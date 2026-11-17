// Lifecycle tests of agent-ask / claude-ask against a fake `claude` (test/fakes/claude.mjs) and the fake `codex`
// (test/fakebin/codex): no credentials, no inference. Real subprocesses for the lifecycle hazards (cancel, signals,
// launcher death, concurrent writers).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const agentBin = join(root, "bin/agent-ask.ts");
const claudeBin = join(root, "bin/claude-ask.ts");
const codexBin = join(root, "bin/codex-ask.ts");
const fakeDir = mkdtempSync(join(tmpdir(), "fake claude-"));
writeFileSync(join(fakeDir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "test/fakes/claude.mjs")}" "$@"\n`);
chmodSync(join(fakeDir, "claude"), 0o755);

const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-SECRET1", ANTHROPIC_AUTH_TOKEN: "tok-SECRET2", ANTHROPIC_BASE_URL: "http://127.0.0.1:9/SECRET-trap",
  CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_OAUTH_TOKEN: "oat-SECRET3", AWS_BEARER_TOKEN_BEDROCK: "aws-SECRET4",
  OPENAI_API_KEY: "sk-SECRET5", CODEX_API_KEY: "c-SECRET9",
};
const env = (extra: Record<string, string> = {}) => ({
  ...process.env, PATH: `${fakeDir}:${join(root, "test/fakebin")}:${process.env.PATH}`, ...SECRETS, AGENT_ASK_KILL_GRACE_MS: "1500", ...extra,
});
const thread = (request = "Question one?") => { const d = mkdtempSync(join(tmpdir(), "claude ask-")); writeFileSync(join(d, "01-request.md"), request); return d; };
const ask = (bin: string, d: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [bin, ...args, "--thread", d], { env: env(extra), encoding: "utf8" });
const claudeAsk = (d: string, args: string[], extra: Record<string, string> = {}) => ask(claudeBin, d, args, extra);
const state = (d: string, r = "01") => JSON.parse(readFileSync(join(d, `${r}-state.json`), "utf8"));
const result = (d: string, r = "01") => JSON.parse(readFileSync(join(d, `${r}-result.json`), "utf8"));
const logOf = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const runs = (p: string) => logOf(p).filter((e) => e.prompt !== undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } };
async function waitFor<T>(fn: () => T, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(50);
  }
}
function bg(bin: string, d: string, args: string[], extra: Record<string, string> = {}) {
  const c: ChildProcess = spawn(process.execPath, [bin, ...args, "--thread", d], { env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout!.on("data", (x) => (out += x));
  c.stderr!.on("data", (x) => (out += x));
  const exit = new Promise<{ code: number | null; out: string }>((r) => c.on("close", (code) => r({ code, out })));
  return { c, exit };
}
const running = (d: string, r = "01") => { const s = state(d, r); return s.status === "running" && s.sessionId && s.attempts.at(-1).pid ? s : null; };
const RESTRICT = ["-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--restricted"];
const flagValue = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { env: gitEnv, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
function repo() {
  const r = mkdtempSync(join(tmpdir(), "ask repo-"));
  git(r, "init", "-q");
  for (const f of ["a.txt", "b.txt", "c.txt", "d.txt"]) writeFileSync(join(r, f), `${f}\n`);
  mkdirSync(join(r, "src"));
  writeFileSync(join(r, "src/keep.ts"), "export {};\n");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  writeFileSync(join(r, "b.txt"), "b changed before the round\n"); // already dirty
  writeFileSync(join(r, "pre.txt"), "untracked before the round\n");
  return r;
}

test("read-only Claude round: restricted argv, no keys or tokens reach Claude, report from the final response, compact result", () => {
  const d = thread();
  const log = join(d, "fake.log");
  const r = claudeAsk(d, ["start", "--round", "01", "--cwd", d], { FAKE_LOG: log });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
  const s = state(d);
  assert.equal(s.provider, "claude");
  assert.equal(s.status, "complete");
  assert.equal(s.sessionId, "c-sess-1");
  assert.equal(s.cli, "2.1.326 (Claude Code)");
  assert.match(readFileSync(join(d, "01-reply.md"), "utf8"), /Full report body/);
  const entries = logOf(log);
  for (const e of entries) assert.deepEqual(e.leaked, [], JSON.stringify(e.argv));
  const auth = entries.find((e) => e.auth);
  assert.deepEqual(auth.argv, ["--setting-sources", "", "auth", "status", "--json"]);
  const [call] = runs(log);
  for (const f of RESTRICT) assert.ok(call.argv.includes(f), f);
  assert.equal(flagValue(call.argv, "--permission-mode"), "dontAsk");
  assert.equal(flagValue(call.argv, "--setting-sources"), "");
  assert.equal(flagValue(call.argv, "--tools"), "Read,Glob,Grep");
  assert.equal(flagValue(call.argv, "--allowedTools"), "Read,Glob,Grep");
  assert.deepEqual(JSON.parse(flagValue(call.argv, "--mcp-config")), { mcpServers: {} });
  const settings = JSON.parse(flagValue(call.argv, "--settings"));
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.apiKeyHelper, undefined);
  for (const bad of ["--bare", "bypassPermissions", "--dangerously-skip-permissions", "--max-turns", "--resume"]) assert.ok(!call.argv.includes(bad), bad);
  assert.ok(!call.argv.some((x: string) => /Bash/.test(x) && !x.startsWith("{")), "no Bash tool selected");
  assert.match(call.prompt, /^Question one\?/);
  assert.match(call.prompt, /FINAL RESPONSE is the full report/);
  const res = result(d);
  assert.equal(res.status, "complete");
  assert.equal(res.provider, "claude");
  assert.equal(res.reply, join(d, "01-reply.md"));
  assert.equal(res.attempt.usage.output_tokens, 20);
});

test("subscription-only auth: every non-subscription login is refused before inference, without printing auth details", () => {
  const ok = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "x-SECRET@example.invalid" };
  const bad = [
    { ...ok, loggedIn: false }, { ...ok, authMethod: "api_key" }, { ...ok, authMethod: "oauth_token" }, { ...ok, apiProvider: "bedrock" },
    { ...ok, apiProvider: "vertex" }, { ...ok, subscriptionType: "free" }, { ...ok, subscriptionType: null },
  ].map((o) => JSON.stringify(o));
  for (const auth of [...bad, "not json SECRET-raw"]) {
    const d = thread();
    const log = join(d, "fake.log");
    const r = claudeAsk(d, ["start", "--round", "01", "--cwd", d], { FAKE_AUTH: auth, FAKE_LOG: log });
    assert.equal(r.status, 2, auth);
    assert.match(r.stderr, /Claude subscription/, auth);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET|example\.invalid/, auth);
    assert.equal(runs(log).length, 0, `no inference for ${auth}`);
    assert.equal(existsSync(join(d, "01-lock")), false);
    assert.equal(existsSync(join(d, "01-state.json")), false);
  }
  for (const plan of ["pro", "team", "enterprise", "Max"]) {
    const d = thread();
    assert.equal(claudeAsk(d, ["start", "--round", "01", "--cwd", d], { FAKE_AUTH: JSON.stringify({ ...ok, subscriptionType: plan }) }).status, 0, plan);
  }
});

test("a CLI without a needed restriction is refused before inference; no CLI at all leaves no lock", () => {
  for (const drop of ["--restricted", "--tools", "--permission-mode", "--strict-mcp-config", "--setting-sources"]) {
    const d = thread();
    const log = join(d, "fake.log");
    const r = claudeAsk(d, ["start", "--round", "01", "--cwd", d], { FAKE_HELP_DROP: drop, FAKE_LOG: log });
    assert.equal(r.status, 2, drop);
    assert.match(r.stderr, new RegExp(`doesn't offer .*${drop}`), drop);
    assert.equal(runs(log).length, 0);
  }
  const d = thread();
  const r = spawnSync(process.execPath, [claudeBin, "start", "--round", "01", "--cwd", d, "--thread", d], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" }, encoding: "utf8" });
  assert.match(r.stderr, /`claude` CLI isn't installed/);
  assert.equal(existsSync(join(d, "01-lock")), false);
});

test("outcomes: STATUS line, errors, truncated stream, empty report, quota, auth refusal, permission denials; only this attempt's report is published", () => {
  const cases: [string, string, RegExp | null, boolean][] = [
    ["complete", "complete", null, true], ["blocked", "blocked", null, true], ["partial", "partial", null, true],
    ["nostatus", "partial", /doesn't end with a STATUS line/, true],
    ["denied", "partial", /2 permission request\(s\) denied \(Edit, Bash\)/, true],
    ["error", "failed", /error_during_execution/, false], ["exit1", "failed", /exit 1/, false],
    ["truncate", "failed", /no result event .*1 unreadable event line/, false],
    ["noreport", "failed", /final response .* is empty/, false],
    ["quota", "interrupted", /usage limit was reached \(resets 2025-.*nothing is retried automatically/, false],
    ["auth", "failed", /refused the sign-in.*claude auth login/, false],
  ];
  for (const [mode, want, note, published] of cases) {
    const d = thread();
    writeFileSync(join(d, "01-reply.md"), "an older report");
    const log = join(d, "fake.log");
    const r = claudeAsk(d, ["start", "--round", "01", "--cwd", d], { FAKE_CLAUDE: mode, FAKE_LOG: log });
    const s = state(d);
    assert.equal(s.status, want, `${mode}: ${s.note}`);
    if (note) assert.match(s.note, note, mode);
    assert.equal(r.status, want === "complete" ? 0 : 1, mode);
    const reply = readFileSync(join(d, "01-reply.md"), "utf8");
    if (published) assert.match(reply, /Full report body/, mode);
    else { assert.equal(reply, "an older report", mode); assert.equal(result(d).reply, null, mode); }
    assert.equal(runs(log).length, 1, `${mode}: exactly one inference, never an automatic retry`);
    assert.equal(s.attempts.length, 1);
  }
});

test("resume: same restrictions and session, request hash guard; a complete round can't be resumed", () => {
  const d = thread();
  const log = join(d, "fake.log");
  claudeAsk(d, ["start", "--round", "01", "--cwd", d], { FAKE_CLAUDE: "quota", FAKE_LOG: log });
  assert.equal(state(d).status, "interrupted");
  const r = claudeAsk(d, ["resume", "--round", "01"], { FAKE_LOG: log });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [first, second] = runs(log);
  assert.deepEqual(second.argv.slice(-2), ["--resume", "c-sess-1"]);
  assert.deepEqual(second.argv.slice(0, -2), first.argv, "resume states the same restrictions");
  assert.match(second.prompt, /was interrupted or stopped/);
  assert.equal(state(d).status, "complete");
  assert.equal(state(d).attempts.at(-1).kind, "resume");
  assert.match(claudeAsk(d, ["resume", "--round", "01"]).stderr, /is complete/);
  const e = thread();
  claudeAsk(e, ["start", "--round", "01", "--cwd", e], { FAKE_CLAUDE: "quota" });
  writeFileSync(join(e, "01-request.md"), "Another question?");
  assert.match(claudeAsk(e, ["resume", "--round", "01"]).stderr, /request .* changed/);
  const f = thread();
  claudeAsk(f, ["start", "--round", "01", "--cwd", f], { FAKE_CLAUDE: "error" });
  const g = claudeAsk(f, ["start", "--round", "01", "--cwd", f]); // an explicit new start of a failed round re-hashes the request
  assert.equal(g.status, 0);
  assert.equal(state(f).attempts.length, 2);
});

test("follow-up: a new request continues a finished round's session in the same cwd; refused for unfinished rounds or another cwd", () => {
  const d = thread();
  const log = join(d, "fake.log");
  claudeAsk(d, ["start", "--round", "01", "--cwd", d], { FAKE_CLAUDE: "partial", FAKE_LOG: log });
  writeFileSync(join(d, "02-request.md"), "Second question, same context?");
  const r = claudeAsk(d, ["start", "--round", "02", "--continue-from", "01"], { FAKE_LOG: log });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const call = runs(log).at(-1);
  assert.deepEqual(call.argv.slice(-2), ["--resume", "c-sess-1"]);
  assert.equal(flagValue(call.argv, "--tools"), "Read,Glob,Grep");
  assert.match(call.prompt, /^Follow-up round 02, continuing round 01/);
  assert.match(call.prompt, /Second question, same context\?/);
  assert.doesNotMatch(call.prompt, /Question one/);
  const s = state(d, "02");
  assert.equal(s.status, "complete");
  assert.equal(s.continueFrom, "01");
  assert.equal(s.sessionId, "c-sess-1");
  assert.equal(s.attempts[0].kind, "follow-up");
  assert.equal(result(d, "02").continueFrom, "01");
  // Not from a failed / interrupted round, not in another cwd, not with another provider.
  const e = thread();
  claudeAsk(e, ["start", "--round", "01", "--cwd", e], { FAKE_CLAUDE: "quota" });
  writeFileSync(join(e, "02-request.md"), "More?");
  assert.match(claudeAsk(e, ["start", "--round", "02", "--continue-from", "01"]).stderr, /01 is interrupted/);
  writeFileSync(join(d, "03-request.md"), "Third?");
  assert.match(claudeAsk(d, ["start", "--round", "03", "--continue-from", "01", "--cwd", tmpdir()]).stderr, /same|--cwd/);
  assert.match(ask(codexBin, d, ["start", "--round", "03", "--continue-from", "01"]).stderr, /ran on claude/);
});

test("one writer per session across rounds: a second follow-up or a held session lock is refused while the first runs", async () => {
  const d = thread();
  claudeAsk(d, ["start", "--round", "01", "--cwd", d]);
  writeFileSync(join(d, "02-request.md"), "Two?");
  writeFileSync(join(d, "03-request.md"), "Three?");
  const two = bg(claudeBin, d, ["start", "--round", "02", "--continue-from", "01"], { FAKE_CLAUDE: "slow", FAKE_DELAY_MS: "2500" });
  await waitFor(() => running(d, "02"));
  const r = claudeAsk(d, ["start", "--round", "03", "--continue-from", "01"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /still used by round 02|in use by round 02/);
  assert.equal(existsSync(join(d, "03-state.json")), false);
  assert.equal((await two.exit).code, 0);
  // A session lock held by a live process (another launcher) refuses too.
  const lockName = `session-${createHash("sha256").update("claude:c-sess-1").digest("hex").slice(0, 16)}.lock`;
  writeFileSync(join(d, lockName), JSON.stringify({ pid: process.pid, round: "09" }));
  assert.match(claudeAsk(d, ["start", "--round", "03", "--continue-from", "02"]).stderr, /in use by round 09/);
  // A dead owner's session lock: refused until `unlock --round <owner>`.
  writeFileSync(join(d, lockName), JSON.stringify({ pid: 999999, round: "09" }));
  assert.match(claudeAsk(d, ["start", "--round", "03", "--continue-from", "02"]).stderr, /stale lock from round 09/);
  assert.equal(claudeAsk(d, ["unlock", "--round", "09"]).status, 0);
  const t = claudeAsk(d, ["start", "--round", "03", "--continue-from", "02"]);
  assert.equal(t.status, 0, t.stdout + t.stderr);
});

test("cancel: the launcher stops Claude, nothing is published, the state says cancelled; resume works afterwards", async () => {
  const d = thread();
  const l = bg(claudeBin, d, ["start", "--round", "01", "--cwd", d], { FAKE_CLAUDE: "hang" });
  const s = await waitFor(() => running(d));
  const pid = s.attempts[0].pid;
  const c = claudeAsk(d, ["cancel", "--round", "01"]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(state(d).status, "cancelled");
  assert.match(state(d).note, /cancelled on request/);
  assert.equal((await l.exit).code, 1);
  await waitFor(() => dead(pid));
  assert.equal(existsSync(join(d, "01-reply.md")), false);
  assert.equal(existsSync(join(d, "01-cancel.json")), false);
  assert.match(claudeAsk(d, ["cancel", "--round", "01"]).stderr, /isn't running/);
  const r = claudeAsk(d, ["resume", "--round", "01"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(state(d).status, "complete");
});

test("cancel escalates to SIGKILL for a child that ignores SIGTERM, grandchildren included; a SIGTERM to the launcher stops Claude too", async () => {
  const d = thread();
  const pids = join(d, "pids.json");
  const l = bg(claudeBin, d, ["start", "--round", "01", "--cwd", d], { FAKE_CLAUDE: "stubborn", FAKE_PIDS: pids });
  await waitFor(() => running(d) && existsSync(pids));
  const { self, grandchild } = JSON.parse(readFileSync(pids, "utf8"));
  assert.equal(claudeAsk(d, ["cancel", "--round", "01"]).status, 0);
  await l.exit;
  await waitFor(() => dead(self) && dead(grandchild));
  assert.equal(state(d).status, "cancelled");

  const e = thread();
  const m = bg(claudeBin, e, ["start", "--round", "01", "--cwd", e], { FAKE_CLAUDE: "hang" });
  const pid = (await waitFor(() => running(e))).attempts[0].pid;
  m.c.kill("SIGTERM");
  assert.equal((await m.exit).code, 1);
  await waitFor(() => dead(pid));
  assert.equal(state(e).status, "cancelled");
  assert.match(state(e).note, /launcher got SIGTERM/);
  assert.equal(existsSync(join(e, "01-lock")), false);
});

test("stale cancellation: requests for another attempt or pid are ignored; a reused pid is never signalled", async () => {
  const d = thread();
  writeFileSync(join(d, "01-cancel.json"), JSON.stringify({ round: "01", attempt: 1, pid: 1, nonce: "x" })); // left over: removed at start
  const l = bg(claudeBin, d, ["start", "--round", "01", "--cwd", d], { FAKE_CLAUDE: "hang" });
  const s = await waitFor(() => running(d));
  const pid = s.attempts[0].pid;
  writeFileSync(join(d, "01-cancel.json"), JSON.stringify({ round: "01", attempt: 1, pid: pid + 1, nonce: "y" }));
  await sleep(700);
  writeFileSync(join(d, "01-cancel.json"), JSON.stringify({ round: "01", attempt: 7, pid, nonce: "z" }));
  await sleep(700);
  assert.equal(state(d).status, "running");
  assert.equal(dead(pid), false);
  assert.equal(claudeAsk(d, ["cancel", "--round", "01"]).status, 0);
  await l.exit;

  // A state that names a live pid which isn't the attempt's process (reused): cancel refuses and signals nothing.
  const e = thread();
  const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  try {
    await waitFor(() => other.pid);
    writeFileSync(join(e, "01-state.json"), JSON.stringify({
      provider: "claude", round: "01", status: "running", mode: "review", cwd: e, sandbox: "read-only", effort: "high", write: [],
      requestSha256: "x", reply: join(e, "01-reply.md"), updatedAt: "2020-01-01T00:00:00.000Z",
      attempts: [{ n: 1, startedAt: "2020-01-01T00:00:00.000Z", pid: other.pid, events: join(e, "x"), stderr: join(e, "y"), last: join(e, "z"), reply: join(e, "w") }],
    }));
    const r = claudeAsk(e, ["cancel", "--round", "01"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /can't confirm .* nothing was signalled/);
    await sleep(200);
    assert.equal(dead(other.pid!), false);
  } finally { other.kill("SIGKILL"); }
});

test("launcher killed: cancel stops the orphaned Claude itself (after checking it is ours); unlock + status then show cancelled", async () => {
  const d = thread();
  const l = bg(claudeBin, d, ["start", "--round", "01", "--cwd", d], { FAKE_CLAUDE: "hang" });
  const pid = (await waitFor(() => running(d))).attempts[0].pid;
  l.c.kill("SIGKILL");
  await l.exit;
  assert.equal(dead(pid), false, "Claude outlives a SIGKILLed launcher (its own group)");
  const c = claudeAsk(d, ["cancel", "--round", "01"]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /left the lock/);
  await waitFor(() => dead(pid));
  assert.equal(claudeAsk(d, ["unlock", "--round", "01"]).status, 0);
  assert.match(claudeAsk(d, ["status"]).stdout, /01 \[claude\]: cancelled/);
  assert.equal(existsSync(join(d, "01-reply.md")), false);
});

test("runner-owned time budget: --timeout stops Claude and leaves the round interrupted, nothing published", async () => {
  const d = thread();
  const r = claudeAsk(d, ["start", "--round", "01", "--cwd", d, "--timeout", "0.02"], { FAKE_CLAUDE: "hang" });
  assert.equal(r.status, 1);
  const s = state(d);
  assert.equal(s.status, "interrupted");
  assert.match(s.note, /time budget .* ran out/);
  await waitFor(() => dead(s.attempts[0].pid));
  assert.equal(existsSync(join(d, "01-reply.md")), false);
});

test("implementation scope (temp git repo): changes outside --write are detected, never reverted; inside-only changes are complete", () => {
  const r = repo();
  const d = join(r, ".agent-bridge", "threads", "t"); // inside the repo and not ignored: the thread itself is never a finding
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "01-request.md"), "Implement it.");
  const log = join(tmpdir(), `scope-${process.pid}-${Date.now()}.log`);
  const edits = [
    { op: "write", path: "src/new.ts", content: "export const x = 1;\n" },
    { op: "write", path: "a.txt", content: "tracked edit\n" },
    { op: "write", path: "b.txt", content: "dirty file changed again\n" },
    { op: "write", path: "new.txt", content: "untracked creation\n" },
    { op: "rm", path: "c.txt" },
    { op: "rename", from: "d.txt", to: "e.txt" },
    { op: "rm", path: "pre.txt" },
  ];
  const x = claudeAsk(d, ["start", "--round", "01", "--cwd", r, "--mode", "implement", "--sandbox", "workspace-write", "--write", join(r, "src")],
    { FAKE_EDITS: JSON.stringify(edits), FAKE_LOG: log });
  assert.equal(x.status, 1, x.stdout + x.stderr);
  const s = state(d);
  assert.equal(s.status, "partial");
  assert.match(s.note, /not complete: 7 change\(s\) outside --write/);
  const call = runs(log).at(-1);
  assert.equal(flagValue(call.argv, "--tools"), "Read,Glob,Grep,Edit,Write");
  assert.match(call.prompt, /You may change only: .*src/);
  const scope = JSON.parse(readFileSync(s.attempts[0].scope, "utf8"));
  const kinds = Object.fromEntries(scope.outside.map((c: { path: string; kind: string }) => [c.path.slice(scope.top.length + 1), c.kind]));
  assert.deepEqual(kinds, { "a.txt": "modified", "b.txt": "modified", "new.txt": "created", "c.txt": "deleted", "d.txt": "deleted", "e.txt": "created", "pre.txt": "deleted" });
  assert.ok(scope.changed.some((c: { path: string }) => c.path.endsWith(join("src", "new.ts"))));
  assert.ok(!scope.changed.some((c: { path: string }) => c.path.includes(".agent-bridge")));
  assert.equal(scope.outside.find((c: { path: string }) => c.path.endsWith("b.txt")).wasDirty, true);
  assert.equal(readFileSync(join(r, "b.txt"), "utf8"), "dirty file changed again\n"); // detection only: nothing reset
  assert.ok(existsSync(join(r, "new.txt")));
  assert.equal(result(d).attempt.changes.outside, 7);

  const q = repo();
  const e = mkdtempSync(join(tmpdir(), "claude ask-"));
  writeFileSync(join(e, "01-request.md"), "Implement it.");
  const y = claudeAsk(e, ["start", "--round", "01", "--cwd", q, "--sandbox", "workspace-write", "--write", join(q, "src")],
    { FAKE_EDITS: JSON.stringify([{ op: "write", path: "src/keep.ts", content: "export const y = 2;\n" }, { op: "write", path: "src/deep/n.ts", content: "1\n" }]) });
  assert.equal(y.status, 0, y.stdout + y.stderr);
  assert.equal(state(e).status, "complete");
  assert.equal(state(e).attempts[0].changes.changed, 2);
});

test("implementation preconditions: --write is required, must be inside --cwd, and --cwd must be a git worktree", () => {
  const r = repo();
  const d = thread();
  assert.match(claudeAsk(d, ["start", "--round", "01", "--cwd", r, "--sandbox", "workspace-write"]).stderr, /needs --write/);
  assert.match(claudeAsk(d, ["start", "--round", "01", "--cwd", r, "--sandbox", "workspace-write", "--write", tmpdir()]).stderr, /only work inside --cwd/);
  assert.match(claudeAsk(d, ["start", "--round", "01", "--cwd", d, "--sandbox", "workspace-write", "--write", d]).stderr, /git worktree/);
  assert.equal(existsSync(join(d, "01-lock")), false);
});

test("agent-ask: --provider is required for a new round; old state files are Codex rounds; codex-ask won't run Claude", () => {
  const d = thread();
  assert.match(ask(agentBin, d, ["start", "--round", "01", "--cwd", d]).stderr, /--provider codex\|claude is required/);
  assert.match(ask(codexBin, d, ["start", "--round", "01", "--cwd", d, "--provider", "claude"]).stderr, /codex-ask runs codex/);
  const r = ask(agentBin, d, ["start", "--provider", "claude", "--round", "01", "--cwd", d]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const e = thread();
  writeFileSync(join(e, "01-state.json"), JSON.stringify({ round: "01", status: "complete", mode: "review", cwd: e, sandbox: "read-only", effort: "high", write: [], requestSha256: "x", reply: join(e, "01-reply.md"), attempts: [], updatedAt: "2020-01-01T00:00:00.000Z" }));
  const st = ask(agentBin, e, ["status", "--json"]);
  assert.equal(st.status, 0, st.stderr);
  assert.equal(JSON.parse(st.stdout)[0].provider, "codex");
});

test("Codex rounds get cancel and follow-up too (fake codex)", async () => {
  const d = thread();
  const l = bg(codexBin, d, ["start", "--round", "01", "--cwd", d], { FAKE_CODEX: "hang" });
  const pid = (await waitFor(() => running(d))).attempts[0].pid;
  const c = ask(codexBin, d, ["cancel", "--round", "01"]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(state(d).status, "cancelled");
  await l.exit;
  await waitFor(() => dead(pid));
  const e = thread();
  const log = join(e, "argv.log");
  assert.equal(ask(codexBin, e, ["start", "--round", "01", "--cwd", e]).status, 0);
  writeFileSync(join(e, "02-request.md"), "Follow-up?");
  const f = ask(codexBin, e, ["start", "--round", "02", "--continue-from", "01"], { FAKE_ARGV_LOG: log });
  assert.equal(f.status, 0, f.stdout + f.stderr);
  const argv: string[] = JSON.parse(readFileSync(log, "utf8").trim()).argv;
  assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "sess-1"]);
  assert.ok(argv.includes('sandbox_mode="read-only"'));
  assert.equal(state(e, "02").provider, "codex");
});
