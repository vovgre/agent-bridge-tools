// The round lifecycle shared by codex-ask, claude-ask and agent-ask: start / follow-up / resume / accept / unlock /
// cancel / status. One attempt = one provider process in its own process group; it is judged from its own files only,
// and its report is published only after every proof is there. Nothing is retried automatically: every inference is an
// explicit command.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  alive, anyAlive, compactResult, ctx, die, file, flag, groupAlive, lock, lockOwner, now, opt, opts, outcome, processInfo, publish,
  readState, releaseAll, reportedStatus, rounds, sessionLock, sha, signalGroup, sleep, staleSessionLocks, stopGroup, writeAtomic, writeState,
} from "./common.ts";
import type { Attempt, Ended, Kind, Provider, ProviderName, State } from "./common.ts";
import { codex } from "./codex.ts";
import { claude } from "./claude.ts";
import { canon, compare, inside, snapshot } from "./scope.ts";

export interface EntryConfig { name: string; provider?: ProviderName }

const providers: Record<ProviderName, Provider> = { codex, claude };
const providerOf = (s: State) => providers[s.provider ?? "codex"];
const grace = () => Math.max(100, Number(process.env.AGENT_ASK_KILL_GRACE_MS) || 5000);
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
const DONE_FOR_FOLLOW_UP = ["complete", "partial", "blocked"];

const roundArg = (name = "round") => {
  const r = opt(name) ?? die(`--${name} is required`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r)) die(`--${name} must be a plain round name like 03`);
  return r;
};

/* ---------- cancel requests ---------- */

interface CancelRequest { round: string; attempt: number; pid: number; nonce: string; requestedAt: string; by: number; killedAt?: string }
const cancelPath = (round: string) => file(round, "cancel.json");
function readCancel(round: string): CancelRequest | undefined {
  try { return JSON.parse(readFileSync(cancelPath(round), "utf8")); } catch { return undefined; }
}
/** A cancel request counts only for the attempt and pid it names; anything else is stale and removed. */
function cancelFor(s: State, a: Attempt): CancelRequest | undefined {
  if (!existsSync(cancelPath(s.round))) return undefined;
  const c = readCancel(s.round);
  if (c && c.round === s.round && c.attempt === a.n && c.pid === a.pid) return c;
  rmSync(cancelPath(s.round), { force: true });
  return undefined;
}

/* ---------- scope ---------- */

function takeBaseline(s: State, a: Attempt) {
  try {
    const b = snapshot(s.cwd);
    if (!b) { a.scopeSkipped = "the --cwd isn't in a git repository"; return; }
    a.baseline = file(s.round, `attempt-${a.n}-baseline.json`);
    writeFileSync(a.baseline, JSON.stringify(b));
  } catch (e) { a.scopeSkipped = `the baseline couldn't be taken: ${(e as Error).message}`; }
}

function scopeBlockers(s: State, a: Attempt, p: Provider): string[] {
  if (s.sandbox !== "workspace-write") return [];
  if (!a.baseline || !existsSync(a.baseline)) return p.requireScope ? [`changes weren't checked (${a.scopeSkipped ?? "no baseline"})`] : [];
  try {
    // A retry must not quietly adopt unauthorized edits from an earlier attempt as its new baseline.
    // Keep the round's first usable baseline until a new request/round explicitly establishes a new scope.
    const baseline = s.attempts.find((attempt) => attempt.baseline)?.baseline ?? a.baseline;
    const r = compare(JSON.parse(readFileSync(baseline, "utf8")), p.allowed(s).map(canon), [canon(ctx.thread)]);
    a.scope = file(s.round, `attempt-${a.n}-scope.json`);
    writeAtomic(a.scope, JSON.stringify(r, null, 2) + "\n");
    a.changes = { changed: r.changed.length, outside: r.outside.length, first: r.outside.slice(0, 20).map((c) => `${c.kind}${c.wasDirty ? " (was dirty)" : ""} ${c.path}`) };
    const out: string[] = [];
    if (r.outside.length) {
      const list = r.outside.slice(0, 5).map((c) => `${c.kind} ${c.path}`).join(", ");
      out.push(`${r.outside.length} change(s) outside --write (${list}${r.outside.length > 5 ? ", ..." : ""}); see ${basename(a.scope)}`);
    }
    if (r.headBefore !== r.headAfter) out.push(`HEAD moved during the attempt (${r.headBefore?.slice(0, 10) ?? "none"} -> ${r.headAfter?.slice(0, 10) ?? "none"}): committed changes aren't covered by the check`);
    return out;
  } catch (e) { return [`the scope check failed (${(e as Error).message}): changes weren't checked`]; }
}

/* ---------- judging ---------- */

/**
 * Judge one attempt. Complete only with every proof: exit 0, the provider's completion event without an error, a
 * non-empty report from this attempt (its own file), a final STATUS: complete, and no blockers (permission denials,
 * changes outside --write). Then the report is published to <round>-reply.md. Unknown exit (the launcher died) =
 * interrupted, with the report kept as a candidate for `accept`. A cancelled or timed-out attempt publishes nothing.
 */
function finish(s: State, a: Attempt, p: Provider, ended?: Ended) {
  const ev = p.evidence(s, a);
  if (ev.usage) a.usage = ev.usage;
  s.reportedStatus = reportedStatus(ev.statusText);
  s.note = undefined;
  const blockers = [...ev.blockers, ...scopeBlockers(s, a, p)];
  a.blockers = blockers.length ? blockers : undefined;
  const notes: string[] = [];
  if (ended) {
    s.status = ended.kind === "timeout" ? "interrupted" : "cancelled";
    notes.push(ended.note);
  } else if (ev.interrupt) {
    s.status = "interrupted";
    notes.push(ev.interrupt);
  } else if (a.exitCode === undefined || a.exitCode === null) {
    s.status = "interrupted";
    if (ev.done && !ev.failed && ev.report) { s.candidate = a.reply; notes.push(`${p.label} finished its turn but its exit is unknown: read ${basename(a.reply)}, then \`accept\` or \`resume\``); }
    else notes.push(`interrupted before ${p.label} finished: resume when ready`);
  } else if (a.exitCode !== 0 || ev.failed || !ev.done) {
    s.status = "failed";
    notes.push(ev.failNote);
  } else if (!ev.report) {
    s.status = "failed";
    notes.push(ev.missingNote);
  } else {
    publish(a.reply, s.reply);
    s.published = { attempt: a.n, at: now() };
    s.status = outcome(s.reportedStatus);
    if (!s.reportedStatus) notes.push("the final message doesn't end with a STATUS line: read the reply");
    if (blockers.length && s.status === "complete") s.status = "partial";
  }
  if (blockers.length) notes.push(`not complete: ${blockers.join("; ")}`);
  if (notes.length) s.note = notes.join("; ");
}

function adoptSession(s: State, a: Attempt, p: Provider) {
  if (!a.sessionId) return;
  if (p.keepFirstSession) s.sessionId ??= a.sessionId;
  else s.sessionId = a.sessionId;
}

/* ---------- one attempt ---------- */

function run(s: State, p: Provider, kind: Kind, session?: string): Promise<void> {
  const n = s.attempts.length + 1;
  const a: Attempt = {
    n, startedAt: now(), resume: kind === "resume", kind,
    events: file(s.round, `attempt-${n}-events.jsonl`), stderr: file(s.round, `attempt-${n}-stderr.log`),
    last: file(s.round, `attempt-${n}-last.md`), reply: file(s.round, `attempt-${n}-reply.md`),
  };
  for (const f of [a.events, a.stderr, a.last, a.reply, file(s.round, `attempt-${n}-baseline.json`), file(s.round, `attempt-${n}-scope.json`)]) rmSync(f, { force: true });
  rmSync(cancelPath(s.round), { force: true }); // a cancel request for an earlier attempt must not stop this one
  const prompt = p.prompt(s, a, kind);
  const argv = p.argv(s, a, session);
  if (s.sandbox === "workspace-write") takeBaseline(s, a);
  const out = openSync(a.events, "w");
  const err = openSync(a.stderr, "w");
  a.startedAt = now();
  // detached = its own process group: it outlives a killed launcher (status reconciles it, cancel can still stop it)
  // and can be signalled as a whole.
  const child = spawn(p.bin, argv, { cwd: s.cwd, env: p.env(), stdio: ["pipe", out, err], detached: true });
  return new Promise((done) => {
    let settled = false;
    let ended: Ended | undefined;
    let watch: ReturnType<typeof setInterval> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killAt = 0;
    const terminate = (e: Ended) => {
      if (ended || settled || !a.pid) return;
      ended = e;
      signalGroup(a.pid, "SIGTERM");
      killAt = Date.now() + grace();
      killTimer = setTimeout(() => signalGroup(a.pid, "SIGKILL"), grace());
    };
    const onSignal = (sig: NodeJS.Signals) => terminate({ kind: "signal", note: `the launcher got ${sig}: ${p.label} was stopped and nothing was published; \`resume\` to continue explicitly` });
    const end = (code: number | null, signal: NodeJS.Signals | null, note?: string) => {
      if (settled) return;
      // The provider can finish between watcher ticks. A matching request already on disk must win over publication.
      if (!ended && cancelFor(s, a)) ended = { kind: "cancelled", note: "cancelled on request before publication: nothing was published; `resume` to continue explicitly" };
      settled = true;
      if (watch) clearInterval(watch);
      if (killTimer) clearTimeout(killTimer);
      for (const sig of SIGNALS) process.off(sig, onSignal);
      try { closeSync(out); } catch {}
      try { closeSync(err); } catch {}
      a.exitCode = code;
      if (signal) a.signal = signal;
      a.endedAt = now();
      a.sessionId ??= p.sessionIn(a.events);
      adoptSession(s, a, p);
      finish(s, a, p, ended);
      if (note) { s.status = "failed"; s.note = note; }
      rmSync(cancelPath(s.round), { force: true });
      writeState(s);
      done();
    };
    child.on("error", (e) => end(-1, null, `couldn't start ${p.bin}: ${e.message}`));
    child.stdin.on("error", () => {});
    // Ownership first: the pid is saved before the provider gets its prompt (a crash between spawn and this line leaves a
    // process that never got the task).
    a.pid = child.pid;
    if (a.pid) a.processIdentity = processInfo(a.pid) ?? undefined;
    s.attempts.push(a);
    s.status = "running";
    s.candidate = undefined;
    s.note = undefined;
    writeState(s);
    for (const sig of SIGNALS) process.on(sig, onSignal);
    child.stdin.end(prompt);
    const deadline = s.timeoutMs ? Date.now() + s.timeoutMs : 0;
    watch = setInterval(() => {
      if (!a.sessionId) {
        const id = p.sessionIn(a.events);
        if (id) {
          a.sessionId = id;
          // Refresh after init: an executable shim may have exec'd the actual CLI since spawn.
          if (a.pid) a.processIdentity = processInfo(a.pid) ?? a.processIdentity;
          adoptSession(s, a, p); writeState(s);
        } // persisted as soon as the provider names it
      }
      if (ended) return;
      if (cancelFor(s, a)) terminate({ kind: "cancelled", note: "cancelled on request: nothing was published; `resume` to continue explicitly" });
      else if (deadline && Date.now() > deadline) {
        terminate({ kind: "timeout", note: `the time budget (${+(s.timeoutMs! / 60000).toFixed(2)} min) ran out: ${p.label} was stopped and nothing was published; \`resume\` to continue explicitly` });
      }
    }, 250);
    child.on("close", (code, signal) => {
      if (!ended && cancelFor(s, a)) terminate({ kind: "cancelled", note: "cancelled on request before publication: nothing was published; `resume` to continue explicitly" });
      if (!ended) return end(code, signal);
      // Descendants that outlive the leader get the rest of the grace period, then SIGKILL: nothing of ours survives.
      void stopGroup(a.pid, killAt).then(() => end(code, signal));
    });
  });
}

/* ---------- output ---------- */

function notify(s: State) {
  if (!flag("notify")) return;
  const text = `Round ${s.round}: ${s.status}`.replace(/"/g, "");
  const topic = basename(ctx.thread).replace(/"/g, "");
  // macOS: a notification banner; Linux: notify-send if installed; elsewhere nothing (the summary is printed anyway).
  const [command, argv] = process.platform === "darwin"
    ? ["osascript", ["-e", `display notification "${text}" with title "${ctx.name}" subtitle "${topic}"`]]
    : process.platform === "linux" ? ["notify-send", [ctx.name, `${topic}: ${text}`]] : [null, []];
  if (!command) return;
  const child = spawn(command as string, argv as string[], { stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function summary(s: State) {
  const a = s.attempts.at(-1);
  const prov = (s.provider ?? "codex") === "codex" ? "" : ` [${s.provider}]`;
  const fresh = !!(s.published && a && s.published.attempt === a.n);
  console.log(`${ctx.name} ${basename(ctx.thread)}/${s.round}${prov}: ${s.status}${s.note ? ` (${s.note})` : ""}`);
  console.log(`  reply: ${s.reply}${!existsSync(s.reply) ? " (not published)" : s.published && !fresh ? " (from an earlier attempt)" : ""}`);
  if (s.sessionId) console.log(`  session: ${s.sessionId}`);
  if (a) console.log(`  attempt ${a.n}: exit ${a.exitCode ?? "?"}, events ${basename(a.events)}`);
  console.log(`  result: ${file(s.round, "result.json")}`);
}

/* ---------- commands ---------- */

/** Another round of this thread whose provider process for this session still lives. */
function sessionBusy(provider: ProviderName, id: string): string | undefined {
  for (const r of rounds()) {
    const t = readState(r);
    if (!t || (t.provider ?? "codex") !== provider || (t.sessionId !== id && t.continueSession !== id)) continue;
    const live = anyAlive(t);
    if (live) return `round ${r} (pid ${live.pid})`;
  }
  return undefined;
}

function chooseProvider(cfg: EntryConfig, src: State | null, from?: string): ProviderName {
  const asked = opt("provider");
  if (asked !== undefined && asked !== "codex" && asked !== "claude") die("--provider must be codex or claude");
  if (cfg.provider && asked && asked !== cfg.provider) die(`${cfg.name} runs ${cfg.provider}; use agent-ask --provider ${asked}`);
  const fromSrc = src ? (src.provider ?? "codex") : undefined;
  const p = (asked as ProviderName | undefined) ?? cfg.provider ?? fromSrc ?? die("--provider codex|claude is required for a new round");
  if (fromSrc && p !== fromSrc) die(`round ${from} ran on ${fromSrc}: a follow-up continues the same session, so it needs the same provider`);
  return p;
}

function timeoutOf(p: Provider): number | undefined {
  const t = opt("timeout");
  if (t === undefined) return p.name === "claude" ? 60 * 60_000 : undefined;
  const m = Number(t);
  if (!Number.isFinite(m) || m < 0) die("--timeout takes minutes (0 = no limit)");
  return m ? Math.round(m * 60_000) : undefined;
}

async function startOrResume(cfg: EntryConfig, cmd: "start" | "resume") {
  const round = roundArg();
  lock(round);
  try {
    const old = readState(round);
    const live = old && anyAlive(old);
    if (live) die(`round ${round}: a ${providerOf(old).label} process from attempt ${live.n} (pid ${live.pid}) is still alive; wait or check \`status\``);
    let s: State;
    let p: Provider;
    if (cmd === "start") {
      const req = file(round, "request.md");
      if (!existsSync(req)) die(`${req} doesn't exist: write the request first`);
      if (old && old.status !== "failed" && old.status !== "cancelled") die(`round ${round} already exists (${old.status}); use resume, accept, or a new round number`);
      const from = opt("continue-from") !== undefined ? roundArg("continue-from") : undefined;
      if (from === round) die("--continue-from names an earlier round, not this one");
      const src = from ? readState(from) ?? die(`no state for round ${from}`) : null;
      p = providers[chooseProvider(cfg, src, from)];
      if (old && (old.provider ?? "codex") !== p.name) die(`round ${round} ran on ${old.provider ?? "codex"} before; use a new round number for ${p.name}`);
      const sandbox = opt("sandbox", "read-only")!;
      if (!["read-only", "workspace-write"].includes(sandbox)) die("--sandbox must be read-only or workspace-write");
      const cwdArg = opt("cwd");
      s = {
        provider: p.name, round, status: "queued", mode: opt("mode", "review")!,
        cwd: cwdArg ? resolve(cwdArg) : src ? src.cwd : die("--cwd <worktree> is required"),
        sandbox, effort: opt("effort", "high")!, model: opt("model"), write: opts("write").map((w) => resolve(w)),
        requestSha256: sha(req), reply: file(round, "reply.md"), attempts: old?.attempts ?? [], updatedAt: now(),
        timeoutMs: timeoutOf(p), continueFrom: from, continueSession: src?.sessionId,
      };
      if (!existsSync(s.cwd)) die(`--cwd ${s.cwd} doesn't exist`);
      p.validate(s);
      if (s.sandbox === "workspace-write" && p.requireScope && inside(canon(s.cwd), canon(ctx.thread))) {
        die("an implementation thread must not contain --cwd: keep --thread outside the worktree or in its .agent-bridge subdirectory so artifact exclusion cannot hide code changes");
      }
      if (src) {
        if (!DONE_FOR_FOLLOW_UP.includes(src.status)) die(`round ${from} is ${src.status}: a follow-up continues a complete, partial or blocked round (resume an interrupted or cancelled one instead)`);
        if (!src.sessionId) die(`round ${from} has no session id to continue: start a fresh round instead`);
        if (s.cwd !== src.cwd) die(`a follow-up runs in round ${from}'s --cwd (${src.cwd}): sessions belong to their working directory`);
        const busy = sessionBusy(p.name, src.sessionId);
        if (busy) die(`the session of round ${from} is still used by ${busy}; wait for it or \`cancel\` it`);
        sessionLock(p.name, src.sessionId, round);
      }
      p.preflight(s);
      writeState(s);
      await run(s, p, src ? "follow-up" : "start", src?.sessionId);
    } else {
      s = old ?? die(`no state for round ${round}`);
      p = providerOf(s);
      if (cfg.provider && cfg.provider !== p.name) die(`round ${round} ran on ${p.name}; use agent-ask or ${p.name}-ask to resume it`);
      if (s.status === "complete") die(`round ${round} is complete`);
      if (!s.sessionId) die(`round ${round} has no session id to resume: start a new round instead`);
      const req = file(round, "request.md");
      if (!existsSync(req) || sha(req) !== s.requestSha256) die(`the request of round ${round} changed since it started: start a new round`);
      const busy = sessionBusy(p.name, s.sessionId);
      if (busy) die(`the session of round ${round} is still used by ${busy}; wait for it or \`cancel\` it`);
      sessionLock(p.name, s.sessionId, round);
      // The same restrictions as the round's first attempt: they come from the state, never from new options.
      p.validate(s);
      if (s.sandbox === "workspace-write" && p.requireScope && inside(canon(s.cwd), canon(ctx.thread))) {
        die("an implementation thread must not contain --cwd: use a separate thread directory");
      }
      p.preflight(s);
      await run(s, p, "resume", s.sessionId);
    }
    notify(s);
    summary(s);
    process.exitCode = s.status === "complete" ? 0 : 1;
  } finally { releaseAll(); }
}

function accept() {
  const round = roundArg();
  lock(round);
  try {
    const s = readState(round) ?? die(`no state for round ${round}`);
    const p = providerOf(s);
    if (!s.candidate || !existsSync(s.candidate)) die(`round ${round} has no candidate reply to accept`);
    if (anyAlive(s)) die(`round ${round}: ${p.label} is still running`);
    const a = s.attempts.find((x) => x.reply === s.candidate) ?? s.attempts.at(-1);
    publish(s.candidate, s.reply);
    s.published = { attempt: a?.n ?? 0, at: now() };
    s.status = outcome(s.reportedStatus);
    s.note = `accepted by hand from ${basename(s.candidate)} (exit unknown)`;
    if (a?.blockers?.length) {
      if (s.status === "complete") s.status = "partial";
      s.note += `; not complete: ${a.blockers.join("; ")}`;
    }
    s.candidate = undefined;
    writeState(s);
    summary(s);
    process.exitCode = s.status === "complete" ? 0 : 1;
  } finally { releaseAll(); }
}

function unlock() {
  const round = roundArg();
  const p = file(round, "lock");
  const sessions = staleSessionLocks(round);
  if (!existsSync(p) && !sessions.length) die(`round ${round} has no lock`);
  const owner = existsSync(p) ? Number(readFileSync(p, "utf8")) : 0;
  if (owner && alive(owner) !== false) die(`round ${round} is held by pid ${owner}, which is still running`);
  const s = readState(round);
  const live = s && anyAlive(s);
  if (live) die(`round ${round}: a ${providerOf(s).label} process from attempt ${live.n} (pid ${live.pid}) is still alive`);
  if (existsSync(p)) {
    rmSync(p);
    console.log(`${ctx.name}: removed the stale lock of round ${round} (pid ${owner || "?"} was gone)`);
  }
  for (const f of sessions) { rmSync(f, { force: true }); console.log(`${ctx.name}: removed round ${round}'s stale session lock ${basename(f)}`); }
}

/** A running round whose launcher and provider are both gone, judged from its files under the lock (never "complete"). */
function reconcile(r: string): State {
  lock(r);
  try {
    const s = readState(r)!;
    const p = providerOf(s);
    const b = s.attempts.at(-1);
    if (b && s.status === "running" && !anyAlive(s)) {
      b.endedAt ??= now();
      b.sessionId ??= p.sessionIn(b.events);
      adoptSession(s, b, p);
      const c = cancelFor(s, b);
      finish(s, b, p, c?.killedAt ? { kind: "cancelled", note: "cancelled on request (its launcher was already gone): nothing was published; `resume` to continue explicitly" } : undefined);
      rmSync(cancelPath(r), { force: true });
      writeState(s);
    }
    return s;
  } finally { releaseAll(); }
}

function status() {
  const json = flag("json");
  const list: unknown[] = [];
  const rs = rounds();
  if (!rs.length && !json) console.log(`no rounds in ${ctx.thread}`);
  for (const r of rs) {
    let s = readState(r)!;
    if (s.status === "running" && !anyAlive(s)) {
      if (existsSync(file(r, "lock"))) s.note = `the launcher and ${providerOf(s).label} are gone but the lock remains: \`unlock\`, then \`status\` again`;
      else s = reconcile(r);
    }
    if (json) list.push(compactResult(s));
    else summary(s);
  }
  if (json) console.log(JSON.stringify(list, null, 2));
}

/**
 * Cancel never takes the round's lock (the running launcher holds it). It writes a cancel request naming the attempt
 * and its pid; the launcher checks it and stops its own process group (SIGTERM, then SIGKILL after the grace period).
 * If the launcher is gone, cancel stops the group itself, but only after confirming with ps that the pid is still the
 * provider process that attempt started (a reused pid is never signalled).
 */
async function cancelOwned() {
  const round = roundArg();
  const s = readState(round) ?? die(`no state for round ${round}`);
  const p = providerOf(s);
  const a = s.attempts.at(-1);
  if (s.status !== "running" || !a?.pid) die(`round ${round} isn't running (${s.status}): nothing to cancel`);
  if (!groupAlive(a.pid)) die(`round ${round}: ${p.label} (pid ${a.pid}) is already gone; run \`status\` to reconcile`);
  const req: CancelRequest = { round, attempt: a.n, pid: a.pid, nonce: randomBytes(8).toString("hex"), requestedAt: now(), by: process.pid };
  writeAtomic(cancelPath(round), JSON.stringify(req));
  const owner = lockOwner(round);
  if (owner && alive(owner) !== false) {
    const deadline = Date.now() + grace() + 15_000;
    while (Date.now() < deadline) {
      await sleep(100);
      const t = readState(round);
      if (t && (t.status !== "running" || t.attempts.length !== s.attempts.length)) {
        summary(t);
        process.exitCode = t.status === "cancelled" ? 0 : 1;
        return;
      }
    }
    die(`the launcher (pid ${owner}) hasn't acted on the cancel request yet: check \`status\``);
  }
  const info = processInfo(a.pid);
  const identity = a.processIdentity;
  if (!info || !identity || info.start !== identity.start || info.command !== identity.command || info.group !== a.pid || identity.group !== a.pid) {
    rmSync(cancelPath(round), { force: true });
    die(`round ${round}: can't confirm that pid ${a.pid} is still the ${p.label} process of attempt ${a.n}; nothing was signalled (check it by hand)`);
  }
  signalGroup(a.pid, "SIGTERM");
  await stopGroup(a.pid, Date.now() + grace());
  writeAtomic(cancelPath(round), JSON.stringify({ ...req, killedAt: now() }));
  if (existsSync(file(round, "lock"))) {
    console.log(`${ctx.name}: stopped ${p.label} (pid ${a.pid}); its launcher was gone and left the lock: \`unlock --round ${round}\`, then \`status\` (it will show cancelled)`);
    return;
  }
  const t = reconcile(round);
  summary(t);
  process.exitCode = t.status === "cancelled" ? 0 : 1;
}

async function cancel() {
  // Serialize controllers without taking the running launcher's round lock.
  const round = roundArg();
  lock(`${round}-cancel-control`);
  try { await cancelOwned(); } finally { releaseAll(); }
}

export async function main(cfg: EntryConfig) {
  ctx.name = cfg.name;
  const cmd = ctx.args[0];
  if (process.platform === "win32") die("native Windows isn't supported (process groups, signals): run it inside WSL");
  ctx.thread = resolve(opt("thread") ?? die("--thread <dir> is required"));
  mkdirSync(ctx.thread, { recursive: true });
  if (cmd === "start" || cmd === "resume") await startOrResume(cfg, cmd);
  else if (cmd === "accept") accept();
  else if (cmd === "unlock") unlock();
  else if (cmd === "status") status();
  else if (cmd === "cancel") await cancel();
  else die(`usage: ${cfg.name} start|status|resume|accept|unlock|cancel --thread <dir> [--round NN] ... (see the header of bin/${cfg.name}.ts)`);
}
