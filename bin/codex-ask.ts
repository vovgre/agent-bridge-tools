#!/usr/bin/env node
// codex-ask: one round with Codex (`codex exec`) that can't lose its answer.
//
//   node bin/codex-ask.ts start  --thread <dir> --round 01 --cwd <worktree> [--mode review|implement|diagnostic|decision]
//                                [--sandbox read-only|workspace-write] [--effort high] [--model <m>] [--write <path>]... [--notify]
//   node bin/codex-ask.ts status --thread <dir>
//   node bin/codex-ask.ts resume --thread <dir> --round 01 [--notify]   (interrupted / failed rounds, old process gone)
//   node bin/codex-ask.ts accept --thread <dir> --round 01              (publish a candidate reply after reading it)
//   node bin/codex-ask.ts unlock --thread <dir> --round 01              (remove a stale lock; refuses if its owner lives)
//
// The request is <thread>/<round>-request.md (docs/ROUNDS.md). Per attempt: <round>-attempt-<n>-{events.jsonl,stderr.log,
// last.md,reply.md}. A reply is published to <round>-reply.md only after that attempt is proven finished: exit 0, a
// completed turn, a non-empty report written by that attempt. <round>-state.json belongs to the launcher; every state
// change happens under the round's lock. API keys are removed from Codex's environment (ChatGPT subscription only).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";

type Status = "queued" | "running" | "interrupted" | "blocked" | "partial" | "failed" | "complete";
interface Attempt {
  n: number; startedAt: string; endedAt?: string; pid?: number; exitCode?: number | null; sessionId?: string; resume?: boolean;
  events: string; stderr: string; last: string; reply: string;
}
interface State {
  round: string; status: Status; mode: string; cwd: string; sandbox: string; effort: string; model?: string;
  write: string[]; requestSha256: string; sessionId?: string; reply: string; attempts: Attempt[];
  reportedStatus?: string; candidate?: string; note?: string; updatedAt: string;
}

const KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"];
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, dflt?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const opts = (name: string) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const flag = (name: string) => args.includes(`--${name}`);
const die = (msg: string): never => { console.error(`codex-ask: ${msg}`); process.exit(2); };

const thread = resolve(opt("thread") ?? die("--thread <dir> is required"));
const file = (round: string, part: string) => resolve(thread, `${round}-${part}`);
const now = () => new Date().toISOString();
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const childEnv = () => { const env = { ...process.env }; for (const k of KEYS) delete env[k]; return env; };

function readState(round: string): State | null {
  const p = file(round, "state.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as State) : null;
}
function writeState(s: State) {
  s.updatedAt = now();
  const p = file(s.round, "state.json");
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p);
}
/** Publish a file atomically (copy to a unique temp, rename over the target). */
function publish(from: string, to: string) {
  const tmp = `${to}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}

/** true = something in the process group (or the pid) lives; false = gone; null = can't tell (treated as alive). */
function alive(pid?: number): boolean | null {
  if (!pid) return false;
  for (const target of [-pid, pid]) {
    try { process.kill(target, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "EPERM") return null; }
  }
  return false;
}
const anyAlive = (s: State) => s.attempts.find((a) => alive(a.pid) !== false);

/**
 * The round's lock, created atomically with its owner's pid in it (write a temp file, then link: link fails if the lock
 * exists). A lock is never taken over automatically (a takeover can't be made race-free with plain files): a lock whose
 * owner is gone is removed by `unlock`, which checks the owner first.
 */
function lock(round: string): () => void {
  const p = file(round, "lock");
  const mine = `${p}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(mine, String(process.pid));
  try {
    linkSync(mine, p);
    return () => { try { if (readFileSync(p, "utf8") === String(process.pid)) rmSync(p); } catch {} };
  } catch {
    let owner = NaN;
    try { owner = Number(readFileSync(p, "utf8")); } catch {}
    if (owner && alive(owner) !== false) return die(`round ${round} is being run by pid ${owner}; wait for it or check \`status\``);
    return die(`round ${round} has a stale lock (pid ${owner || "?"} is gone): check \`status\`, then \`unlock --round ${round}\``);
  } finally { rmSync(mine, { force: true }); }
}

/** The final non-empty line must say STATUS: …; anything else is no status (read as partial: a person should look). */
const reportedStatus = (text: string) => /^\s*STATUS:\s*(complete|blocked|partial)\b/i.exec(text.trim().split("\n").at(-1) ?? "")?.[1]?.toLowerCase();
const outcome = (reported?: string): Status => (reported === "blocked" ? "blocked" : reported === "complete" ? "complete" : "partial");

function footer(s: State, a: Attempt): string {
  const reportRule = s.sandbox === "workspace-write"
    ? `Write your FULL report to this file yourself before your final message (a file write, e.g. a cat > heredoc):\nREPORT_FILE: ${a.reply}\n` +
      `Your final message is only a short summary; the report file is what counts.`
    : `This is a read-only round: your FINAL MESSAGE is the full report (the launcher saves it).`;
  const writable = s.write.length ? `Besides the report you may write only: ${s.write.join(", ")}.` : `Write nothing except the report.`;
  return `\n\n---\nRound ${s.round} (${s.mode}), attempt ${a.n}. ${reportRule}\n${writable} Start the report with the decision and the number ` +
    `of blocking findings. End your final message with one line: STATUS: complete | blocked | partial (and why if not complete).\n`;
}

/** The sandbox policy, stated in full every time (inherited config must not widen it: no network, these roots only). */
function policy(s: State): string[] {
  const roots = s.sandbox === "workspace-write" ? [thread, ...s.write] : [];
  return ["-c", `sandbox_mode="${s.sandbox}"`, "-c", `approval_policy="never"`, "-c", `model_reasoning_effort="${s.effort}"`,
    "-c", "sandbox_workspace_write.network_access=false", "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    ...(s.model ? ["-m", s.model] : [])];
}

function run(s: State, resumeFrom?: string): Promise<void> {
  const n = s.attempts.length + 1;
  const a: Attempt = {
    n, startedAt: now(), resume: !!resumeFrom,
    events: file(s.round, `attempt-${n}-events.jsonl`), stderr: file(s.round, `attempt-${n}-stderr.log`),
    last: file(s.round, `attempt-${n}-last.md`), reply: file(s.round, `attempt-${n}-reply.md`),
  };
  for (const p of [a.events, a.stderr, a.last, a.reply]) rmSync(p, { force: true });
  const prompt = resumeFrom
    ? `Your previous attempt on round ${s.round} was interrupted. Look at what you already wrote (the earlier attempt files ` +
      `${s.round}-attempt-*-reply.md in ${thread}, and the files you may write) and continue from there; don't redo finished work.` + footer(s, a)
    : readFileSync(file(s.round, "request.md"), "utf8") + footer(s, a);
  const argv = resumeFrom
    ? ["exec", "resume", resumeFrom, ...policy(s), "--skip-git-repo-check", "--json", "-o", a.last, "-"]
    : ["exec", "-C", s.cwd, ...policy(s), "--skip-git-repo-check", "--json", "-o", a.last, "-"];
  const out = openSync(a.events, "w");
  const err = openSync(a.stderr, "w");
  // detached = its own process group: it outlives a killed launcher (status reconciles it) and can be checked as a whole.
  const child = spawn("codex", argv, { cwd: s.cwd, env: childEnv(), stdio: ["pipe", out, err], detached: true });
  return new Promise((done) => {
    let settled = false;
    let watch: ReturnType<typeof setInterval> | undefined;
    const end = (code: number | null, note?: string) => {
      if (settled) return;
      settled = true;
      if (watch) clearInterval(watch);
      try { closeSync(out); } catch {}
      try { closeSync(err); } catch {}
      a.exitCode = code;
      a.endedAt = now();
      a.sessionId ??= sessionIn(a.events);
      s.sessionId ??= a.sessionId;
      finish(s, a);
      if (note) { s.status = "failed"; s.note = note; }
      writeState(s);
      done();
    };
    child.on("error", (e) => end(-1, `couldn't start codex: ${e.message}`));
    child.stdin.on("error", () => {});
    // Ownership first: the pid is saved before Codex gets its prompt (a crash between spawn and this line leaves a Codex
    // process that never got the task).
    a.pid = child.pid;
    s.attempts.push(a);
    s.status = "running";
    s.candidate = undefined;
    writeState(s);
    child.stdin.end(prompt);
    watch = setInterval(() => {
      if (a.sessionId) return;
      const id = sessionIn(a.events);
      if (id) { a.sessionId = id; s.sessionId ??= id; writeState(s); }
    }, 1000);
    child.on("close", (code) => end(code));
  });
}

function sessionIn(events: string): string | undefined {
  if (!existsSync(events)) return undefined;
  for (const line of readFileSync(events, "utf8").split("\n")) {
    try { const e = JSON.parse(line); if (e.type === "thread.started" && e.thread_id) return e.thread_id as string; } catch {}
  }
  return undefined;
}

/**
 * Judge one attempt. Complete only with every proof: exit 0, a completed turn, a non-empty report from this attempt (its
 * own file). Then the report is published to <round>-reply.md. Unknown exit (the launcher died) = interrupted, with the
 * report kept as a candidate for `accept`.
 */
function finish(s: State, a: Attempt) {
  const events = existsSync(a.events) ? readFileSync(a.events, "utf8") : "";
  const turnDone = /"type":"turn\.completed"/.test(events);
  const turnFailed = /"type":"turn\.failed"/.test(events);
  const last = existsSync(a.last) ? readFileSync(a.last, "utf8").trim() : "";
  if (s.sandbox !== "workspace-write" && last) writeFileSync(a.reply, last + "\n");
  const report = existsSync(a.reply) ? readFileSync(a.reply, "utf8").trim() : "";
  const stderr = existsSync(a.stderr) ? readFileSync(a.stderr, "utf8") : "";
  s.reportedStatus = reportedStatus(last || report);
  s.note = undefined;
  if (/already has an active writer/.test(stderr)) {
    s.status = "interrupted";
    s.note = "the previous Codex process still holds this session: wait a minute, then resume again";
  } else if (a.exitCode === undefined || a.exitCode === null) {
    s.status = "interrupted";
    if (turnDone && report) { s.candidate = a.reply; s.note = `Codex finished its turn but its exit is unknown: read ${basename(a.reply)}, then \`accept\` or \`resume\``; }
    else s.note = "interrupted before Codex finished: resume when ready";
  } else if (a.exitCode !== 0 || turnFailed || !turnDone) {
    s.status = "failed";
    s.note = `exit ${a.exitCode}${turnFailed ? ", turn failed" : ""}${turnDone ? "" : ", no completed turn"}; see ${basename(a.stderr)}`;
  } else if (!report) {
    s.status = "failed";
    s.note = `Codex finished but this attempt's report (${basename(a.reply)}) is missing or empty (last message in ${basename(a.last)})`;
  } else {
    publish(a.reply, s.reply);
    s.status = outcome(s.reportedStatus);
    if (!s.reportedStatus) s.note = "the final message doesn't end with a STATUS line: read the reply";
  }
}

function notify(s: State) {
  if (!flag("notify")) return;
  const text = `Round ${s.round}: ${s.status}`.replace(/"/g, "");
  const topic = basename(thread).replace(/"/g, "");
  // macOS: a notification banner; Linux: notify-send if installed; elsewhere nothing (the summary is printed anyway).
  const [command, argv] = process.platform === "darwin"
    ? ["osascript", ["-e", `display notification "${text}" with title "codex-ask" subtitle "${topic}"`]]
    : process.platform === "linux" ? ["notify-send", ["codex-ask", `${topic}: ${text}`]] : [null, []];
  if (!command) return;
  const child = spawn(command, argv as string[], { stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function summary(s: State) {
  const a = s.attempts.at(-1);
  console.log(`codex-ask ${basename(thread)}/${s.round}: ${s.status}${s.note ? ` (${s.note})` : ""}`);
  console.log(`  reply: ${s.reply}${existsSync(s.reply) ? "" : " (not published)"}`);
  if (s.sessionId) console.log(`  session: ${s.sessionId}`);
  if (a) console.log(`  attempt ${a.n}: exit ${a.exitCode ?? "?"}, events ${basename(a.events)}`);
}

/** Codex must be signed in with ChatGPT (subscription), not an API key: refuse otherwise. */
function checkAuth() {
  if (process.env.CODEX_ASK_SKIP_AUTH) return;
  const r = spawnSync("codex", ["login", "status"], { env: childEnv(), encoding: "utf8" });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 || !/ChatGPT/i.test(text)) die(`Codex isn't signed in with ChatGPT (\`codex login status\`: ${text.trim() || r.error?.message}). Run \`codex login\`.`);
}

async function main() {
  mkdirSync(thread, { recursive: true });
  if (cmd === "start" || cmd === "resume") {
    const round = opt("round") ?? die("--round is required");
    const unlock = lock(round);
    try {
      const old = readState(round);
      const live = old && anyAlive(old);
      if (live) die(`round ${round}: a Codex process from attempt ${live.n} (pid ${live.pid}) is still alive; wait or check \`status\``);
      let s: State;
      if (cmd === "start") {
        const req = file(round, "request.md");
        if (!existsSync(req)) die(`${req} doesn't exist: write the request first`);
        if (old && old.status !== "failed") die(`round ${round} already exists (${old.status}); use resume, accept, or a new round number`);
        const sandbox = opt("sandbox", "read-only")!;
        if (!["read-only", "workspace-write"].includes(sandbox)) die("--sandbox must be read-only or workspace-write");
        s = {
          round, status: "queued", mode: opt("mode", "review")!, cwd: resolve(opt("cwd") ?? die("--cwd <worktree> is required")),
          sandbox, effort: opt("effort", "high")!, model: opt("model"), write: opts("write").map((w) => resolve(w)),
          requestSha256: sha(req), reply: file(round, "reply.md"), attempts: old?.attempts ?? [], updatedAt: now(),
        };
        if (!existsSync(s.cwd)) die(`--cwd ${s.cwd} doesn't exist`);
        checkAuth();
        writeState(s);
        await run(s);
      } else {
        s = old ?? die(`no state for round ${round}`);
        if (s.status === "complete") die(`round ${round} is complete`);
        if (!s.sessionId) die(`round ${round} has no session id to resume: start a new round instead`);
        if (sha(file(round, "request.md")) !== s.requestSha256) die(`the request of round ${round} changed since it started: start a new round`);
        checkAuth();
        await run(s, s.sessionId);
      }
      notify(s); summary(s);
      process.exitCode = s.status === "complete" ? 0 : 1;
    } finally { unlock(); }
  } else if (cmd === "accept") {
    const round = opt("round") ?? die("--round is required");
    const unlock = lock(round);
    try {
      const s = readState(round) ?? die(`no state for round ${round}`);
      if (!s.candidate || !existsSync(s.candidate)) die(`round ${round} has no candidate reply to accept`);
      if (anyAlive(s)) die(`round ${round}: Codex is still running`);
      publish(s.candidate, s.reply);
      s.status = outcome(s.reportedStatus);
      s.note = `accepted by hand from ${basename(s.candidate)} (exit unknown)`;
      s.candidate = undefined;
      writeState(s);
      summary(s);
      process.exitCode = s.status === "complete" ? 0 : 1;
    } finally { unlock(); }
  } else if (cmd === "unlock") {
    const round = opt("round") ?? die("--round is required");
    const p = file(round, "lock");
    if (!existsSync(p)) die(`round ${round} has no lock`);
    const owner = Number(readFileSync(p, "utf8"));
    if (owner && alive(owner) !== false) die(`round ${round} is held by pid ${owner}, which is still running`);
    const s = readState(round);
    const live = s && anyAlive(s);
    if (live) die(`round ${round}: a Codex process from attempt ${live.n} (pid ${live.pid}) is still alive`);
    rmSync(p);
    console.log(`codex-ask: removed the stale lock of round ${round} (pid ${owner || "?"} was gone)`);
  } else if (cmd === "status") {
    const rounds = readdirSync(thread).filter((f) => f.endsWith("-state.json")).map((f) => f.replace(/-state\.json$/, "")).sort();
    if (!rounds.length) console.log(`no rounds in ${thread}`);
    for (const r of rounds) {
      let s = readState(r)!;
      // A running round whose launcher and Codex are both gone is reconciled from its files, under the lock.
      if (s.status === "running" && !anyAlive(s)) {
        if (existsSync(file(r, "lock"))) {
          s.note = "the launcher and Codex are gone but the lock remains: `unlock`, then `status` again";
        } else {
          const unlock = lock(r);
          try {
            s = readState(r)!;
            const b = s.attempts.at(-1);
            if (b && s.status === "running" && !anyAlive(s)) {
              b.endedAt ??= now();
              b.sessionId ??= sessionIn(b.events);
              s.sessionId ??= b.sessionId;
              finish(s, b); // the exit stays unknown: never "complete" from here
              writeState(s);
            }
          } finally { unlock(); }
        }
      }
      summary(s);
    }
  } else {
    die("usage: codex-ask start|status|resume|accept|unlock --thread <dir> [--round NN] ... (see the header of bin/codex-ask.ts)");
  }
}

await main();
