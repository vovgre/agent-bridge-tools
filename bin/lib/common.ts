// Shared machinery of the round launchers (codex-ask, claude-ask, agent-ask): the state file, locks, process checks and
// the outcome rules. Provider specifics (argv, auth, event parsing) live in codex.ts and claude.ts.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

export type Status = "queued" | "running" | "interrupted" | "blocked" | "partial" | "failed" | "complete" | "cancelled";
export type ProviderName = "codex" | "claude";
/** start = a new session; resume = the same request again in the round's session; follow-up = a new request in an earlier round's session. */
export type Kind = "start" | "resume" | "follow-up";

export interface Attempt {
  n: number; startedAt: string; endedAt?: string; pid?: number; exitCode?: number | null; signal?: string; sessionId?: string;
  resume?: boolean; kind?: Kind;
  processIdentity?: { start: number; command: string; group: number };
  events: string; stderr: string; last: string; reply: string;
  /** Reasons this attempt can't count as complete (permission denials, changes outside --write, an unchecked scope). */
  blockers?: string[];
  baseline?: string; scope?: string; scopeSkipped?: string;
  changes?: { changed: number; outside: number; first: string[] };
  usage?: Record<string, unknown>;
}

export interface State {
  provider?: ProviderName; // absent in 1.x state files: codex
  round: string; status: Status; mode: string; cwd: string; sandbox: string; effort: string; model?: string;
  write: string[]; requestSha256: string; sessionId?: string; reply: string; attempts: Attempt[];
  continueFrom?: string; continueSession?: string; timeoutMs?: number; cli?: string;
  published?: { attempt: number; at: string };
  reportedStatus?: string; candidate?: string; note?: string; updatedAt: string;
}

/** What one attempt's files prove (built by the provider, judged by the shared rules in rounds.ts). */
export interface Evidence {
  done: boolean;        // the provider's completion event (Codex turn.completed, Claude's result event)
  failed: boolean;      // the provider reported an error for the turn
  report: string;       // this attempt's report ("" = none); the provider has put it in attempt.reply
  statusText: string;   // the text whose last line carries STATUS
  interrupt?: string;   // a condition that means "interrupted, resume later" (a session held elsewhere, a usage limit)
  blockers: string[];   // reasons the attempt can't be complete
  failNote: string; missingNote: string;
  usage?: Record<string, unknown>;
}

export interface Provider {
  name: ProviderName; label: string; bin: string;
  /** Codex keeps the first session id of a round; Claude follows the newest one (a resume may fork). */
  keepFirstSession: boolean;
  /** An implementation attempt without a working scope check can't be complete. */
  requireScope: boolean;
  validate(s: State): void;
  /** Auth and CLI capability checks: no inference; dies on failure. */
  preflight(s: State): void;
  env(): NodeJS.ProcessEnv;
  argv(s: State, a: Attempt, session?: string): string[];
  prompt(s: State, a: Attempt, kind: Kind): string;
  sessionIn(events: string): string | undefined;
  /** The paths an implementation attempt may change (the thread is always excluded from the check). */
  allowed(s: State): string[];
  evidence(s: State, a: Attempt): Evidence;
}

export interface Ended { kind: "cancelled" | "signal" | "timeout"; note: string }

export const ctx = { name: "codex-ask", thread: "", args: process.argv.slice(2) };
export const opt = (name: string, dflt?: string) => { const i = ctx.args.indexOf(`--${name}`); return i >= 0 ? ctx.args[i + 1] : dflt; };
export const opts = (name: string) => ctx.args.flatMap((a, i) => (a === `--${name}` ? [ctx.args[i + 1]] : []));
export const flag = (name: string) => ctx.args.includes(`--${name}`);

/** Locks this process holds: released before any exit (process.exit skips `finally`). */
const held: (() => void)[] = [];
export const releaseAll = () => { for (const release of held.splice(0)) release(); };
export const die = (msg: string): never => { releaseAll(); console.error(`${ctx.name}: ${msg}`); process.exit(2); };

export const file = (round: string, part: string) => resolve(ctx.thread, `${round}-${part}`);
export const now = () => new Date().toISOString();
export const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const rand = () => randomBytes(4).toString("hex");

export function writeAtomic(p: string, text: string) {
  const tmp = `${p}.${process.pid}.${rand()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

export function readState(round: string): State | null {
  const p = file(round, "state.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as State) : null;
}
/** The state, and next to it the compact result for calling agents (<round>-result.json, derived, never read back). */
export function writeState(s: State) {
  s.updatedAt = now();
  writeAtomic(file(s.round, "state.json"), JSON.stringify(s, null, 2));
  writeAtomic(file(s.round, "result.json"), JSON.stringify(compactResult(s), null, 2) + "\n");
}
export const rounds = () => readdirSync(ctx.thread).filter((f) => f.endsWith("-state.json")).map((f) => f.replace(/-state\.json$/, "")).sort();

/** Publish a file atomically (copy to a unique temp, rename over the target). */
export function publish(from: string, to: string) {
  const tmp = `${to}.${process.pid}.${rand()}.tmp`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}

/** true = something in the process group (or the pid) lives; false = gone; null = can't tell (treated as alive). */
export function alive(pid?: number): boolean | null {
  if (!pid) return false;
  for (const target of [-pid, pid]) {
    try { process.kill(target, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "EPERM") return null; }
  }
  return false;
}
export const anyAlive = (s: State) => s.attempts.find((a) => alive(a.pid) !== false);
/** The process group led by pid (an attempt's provider process is spawned detached: its own group). */
export function groupAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
/** Signals only the group (never a bare pid that might have been reused). */
export function signalGroup(pid: number | undefined, sig: NodeJS.Signals) {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch {}
}
export async function stopGroup(pid: number | undefined, killAt: number) {
  if (!pid) return;
  while (groupAlive(pid) && Date.now() < killAt) await sleep(50);
  if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
  for (let i = 0; i < 60 && groupAlive(pid); i++) await sleep(50);
}
/** Start time and command line of a pid (ps), to confirm a pid still belongs to an attempt before signalling it. */
export function processInfo(pid: number): { start: number; command: string; group: number } | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-o", "pgid=", "-o", "command=", "-p", String(pid)], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, timeout: 2000 });
  if (r.status !== 0) return null;
  const m = /^\s*(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(.*)$/.exec(r.stdout.trim());
  if (!m) return null;
  const start = Date.parse(m[1] + " UTC");
  return Number.isFinite(start) ? { start, group: Number(m[2]), command: m[3] } : null;
}

/**
 * The round's lock, created atomically with its owner's pid in it (write a temp file, then link: link fails if the lock
 * exists). A lock is never taken over automatically (a takeover can't be made race-free with plain files): a lock whose
 * owner is gone is removed by `unlock`, which checks the owner first.
 */
export function lock(round: string): () => void {
  const p = file(round, "lock");
  const mine = `${p}.${process.pid}.${rand()}`;
  writeFileSync(mine, String(process.pid));
  try {
    linkSync(mine, p);
    const release = () => { try { if (readFileSync(p, "utf8") === String(process.pid)) rmSync(p); } catch {} };
    held.push(release);
    return release;
  } catch {
    const owner = lockOwner(round);
    if (owner && alive(owner) !== false) return die(`round ${round} is being run by pid ${owner}; wait for it or check \`status\``);
    return die(`round ${round} has a stale lock (pid ${owner || "?"} is gone): check \`status\`, then \`unlock --round ${round}\``);
  } finally { rmSync(mine, { force: true }); }
}
export function lockOwner(round: string): number | undefined {
  try { return Number(readFileSync(file(round, "lock"), "utf8")) || undefined; } catch { return undefined; }
}

/**
 * One writer per provider session within a thread, across rounds: held by a resume or follow-up for the whole attempt.
 * Same rules as the round lock (atomic, never taken over; `unlock --round <owner>` removes a stale one).
 */
const sessionLockPath = (provider: ProviderName, id: string) =>
  resolve(ctx.thread, `session-${createHash("sha256").update(`${provider}:${id}`).digest("hex").slice(0, 16)}.lock`);
export function sessionLock(provider: ProviderName, id: string, round: string): () => void {
  const p = sessionLockPath(provider, id);
  const body = JSON.stringify({ pid: process.pid, round });
  const mine = `${p}.${process.pid}.${rand()}`;
  writeFileSync(mine, body);
  try {
    linkSync(mine, p);
    const release = () => { try { if (readFileSync(p, "utf8") === body) rmSync(p); } catch {} };
    held.push(release);
    return release;
  } catch {
    let o: { pid?: number; round?: string } = {};
    try { o = JSON.parse(readFileSync(p, "utf8")); } catch {}
    if (o.pid && alive(o.pid) !== false) return die(`this ${provider} session is in use by round ${o.round} (pid ${o.pid}): one writer per session; wait for it or \`cancel --round ${o.round}\``);
    return die(`this ${provider} session has a stale lock from round ${o.round ?? "?"} (its launcher is gone): check \`status\`, then \`unlock --round ${o.round ?? "<round>"}\``);
  } finally { rmSync(mine, { force: true }); }
}
/** Session locks taken by `round` whose owner is gone. */
export function staleSessionLocks(round: string): string[] {
  return readdirSync(ctx.thread).filter((f) => /^session-[0-9a-f]{16}\.lock$/.test(f)).map((f) => resolve(ctx.thread, f)).filter((p) => {
    try { const o = JSON.parse(readFileSync(p, "utf8")); return o.round === round && alive(o.pid) === false; } catch { return false; }
  });
}

/** The final non-empty line must say STATUS: …; anything else is no status (read as partial: a person should look). */
export const reportedStatus = (text: string) => /^\s*STATUS:\s*(complete|blocked|partial)\b/i.exec(text.trim().split("\n").at(-1) ?? "")?.[1]?.toLowerCase();
export const outcome = (reported?: string): Status => (reported === "blocked" ? "blocked" : reported === "complete" ? "complete" : "partial");

/** The small summary a calling agent reads (<round>-result.json, `status --json`); details stay in the attempt files. */
export function compactResult(s: State) {
  const a = s.attempts.at(-1);
  const legacyPublished = !s.published && ["complete", "partial", "blocked"].includes(s.status) && existsSync(s.reply);
  const published = (s.published && a && s.published.attempt === a.n) || legacyPublished;
  return {
    round: s.round, provider: s.provider ?? "codex", status: s.status, reportedStatus: s.reportedStatus ?? null, note: s.note ?? null,
    reply: published ? s.reply : null, candidate: s.candidate ?? null, sessionId: s.sessionId ?? null,
    continueFrom: s.continueFrom ?? null, mode: s.mode, sandbox: s.sandbox, cwd: s.cwd, write: s.write,
    blockers: a?.blockers ?? [],
    attempt: a ? {
      n: a.n, kind: a.kind ?? (a.resume ? "resume" : "start"), startedAt: a.startedAt, endedAt: a.endedAt ?? null,
      exitCode: a.exitCode ?? null, events: a.events, stderr: a.stderr, scope: a.scope ?? null, scopeSkipped: a.scopeSkipped ?? null,
      changes: a.changes ?? null, usage: a.usage ?? null,
    } : null,
    updatedAt: s.updatedAt,
  };
}
