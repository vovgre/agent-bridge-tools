// Child processes and folders that never outlive the run. Two layers: exit hooks in this process (normal exit, signals,
// uncaught errors) and one detached supervisor per process that holds the list of owned process groups and folders and
// cleans them up when this process goes away for any reason, SIGKILL included (its stdin pipe closes).
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";

const cleanups = new Set<() => void>();
let hooked = false;

/** Runs `fn` once when the process ends, however it ends (SIGKILL aside: the supervisor covers that). Returns an unregister function. */
export function onExit(fn: () => void): () => void {
  if (!hooked) {
    hooked = true;
    process.on("exit", runCleanups);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.on(sig, () => {
        runCleanups();
        process.exit(sig === "SIGINT" ? 130 : 143);
      });
  }
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

function runCleanups() {
  for (const fn of [...cleanups]) {
    cleanups.delete(fn);
    try { fn(); } catch {}
  }
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** SIGKILL the whole process group of a child started with `detached: true` (falls back to the pid alone). */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL") {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

// The supervisor: registered groups and folders arrive as JSON lines on its stdin. When stdin ends (this process exited
// or was killed), it SIGKILLs every registered group, waits for them to go, then removes every registered folder. It
// doesn't care whether a group's leader already exited: descendants left in the group are killed too.
const SUPERVISOR = `
  const { rmSync } = require("node:fs");
  const groups = new Set(), dirs = new Set();
  let buf = "";
  for (const s of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(s, () => {});
  const groupAlive = (g) => { try { process.kill(-g, 0); return true; } catch { return false; } };
  const finish = () => {
    for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { try { process.kill(g, "SIGKILL"); } catch {} } }
    const end = Date.now() + 5000;
    const t = setInterval(() => {
      if ([...groups].some(groupAlive) && Date.now() < end) return;
      clearInterval(t);
      for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} }
      process.exit(0);
    }, 50);
  };
  process.stdin.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\\n")) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      if (m.group) groups.add(m.group);
      if (m.ungroup) groups.delete(m.ungroup);
      if (m.dir) dirs.add(m.dir);
      if (m.undir) dirs.delete(m.undir);
    }
  });
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
  process.stdin.resume();`;

let supervisor: ChildProcess | null = null;
function tell(msg: object) {
  if (!supervisor) {
    supervisor = spawn(process.execPath, ["-e", SUPERVISOR], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    supervisor.unref();
    (supervisor.stdin as unknown as { unref?: () => void }).unref?.();
    supervisor.stdin!.on("error", () => {});
  }
  supervisor.stdin!.write(`${JSON.stringify(msg)}\n`);
}

/** The process group led by `pid` is killed when this process goes away, however it goes. */
export const ownGroup = (pid: number | undefined) => void (pid && tell({ group: pid }));
export const releaseGroup = (pid: number | undefined) => void (pid && tell({ ungroup: pid }));
/** `dir` is removed when this process goes away (after the owned groups are killed). */
export const ownDir = (dir: string) => tell({ dir });
export const releaseDir = (dir: string) => tell({ undir: dir });
/** The supervisor's pid (tests). */
export const supervisorPid = () => supervisor?.pid;

export function removeDir(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

/** A free loopback TCP port, never one of `avoid`. */
export async function freePort(avoid: number[] = []): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    if (!avoid.includes(port)) return port;
  }
  throw new Error("no free port");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TimeoutError extends Error {}

/** `p`, or a TimeoutError after `ms` (the work behind `p` isn't stopped: the caller has to stop it). */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimeoutError(`${message} (after ${ms} ms)`)), ms)));
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Polls `fn` until it returns something truthy; rejects with `message` (and the last error) after `timeout` ms. The
 * deadline holds even when a call of `fn` hangs: each call is raced against the time left.
 */
export async function waitUntil<T>(fn: () => T | Promise<T>, opts: { timeout?: number; interval?: number; message?: string } = {}): Promise<NonNullable<T>> {
  const timeout = opts.timeout ?? 10_000;
  const end = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const v = await withTimeout(Promise.resolve().then(fn), Math.max(1, end - Date.now()), "a check didn't answer");
      if (v) return v as NonNullable<T>;
      last = v;
    } catch (err) {
      // A call cut off by the deadline says less than what the calls before it said.
      if (!(err instanceof TimeoutError) || last === undefined) last = err;
    }
    if (Date.now() >= end) {
      const detail = last instanceof Error ? last.message : JSON.stringify(last);
      throw new TimeoutError(`${opts.message ?? "condition not met"} (after ${timeout} ms; last: ${detail})`);
    }
    await sleep(Math.min(opts.interval ?? 100, Math.max(0, end - Date.now())));
  }
}
