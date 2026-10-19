import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const bin = resolve(import.meta.dirname, "../bin/codex-ask.ts");
const fake = resolve(import.meta.dirname, "fakebin");
const env = (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${fake}:${process.env.PATH}`, OPENAI_API_KEY: "sk-test", CODEX_API_KEY: "c", ANTHROPIC_API_KEY: "sk-ant", ...extra });
// A path with a space in it.
const thread = (request = "Question?") => { const d = mkdtempSync(join(tmpdir(), "ask dir-")); writeFileSync(join(d, "01-request.md"), request); return d; };
const ask = (d: string, args: string[], extra = {}) => spawnSync(process.execPath, [bin, ...args, "--thread", d], { env: env(extra), encoding: "utf8" });
const state = (d: string, r = "01") => JSON.parse(readFileSync(join(d, `${r}-state.json`), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function startHanging(d: string, mode = "hang") {
  const child = spawn(process.execPath, [bin, "start", "--round", "01", "--cwd", d, "--thread", d], { env: env({ FAKE_CODEX: mode }), stdio: "ignore" });
  for (let i = 0; i < 80 && !(existsSync(join(d, "01-state.json")) && state(d).sessionId); i++) await sleep(100);
  return child;
}

test("read-only: the final message becomes the reply; all three API keys stripped; policy stated in full", () => {
  const d = thread();
  const log = join(d, "argv.log");
  const r = ask(d, ["start", "--round", "01", "--cwd", d], { FAKE_ARGV_LOG: log });
  assert.equal(r.status, 0, r.stderr);
  const s = state(d);
  assert.equal(s.status, "complete");
  assert.equal(s.sessionId, "sess-1");
  assert.match(readFileSync(join(d, "01-reply.md"), "utf8"), /Full report body/);
  const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
  assert.deepEqual(call.keys, []);
  assert.equal(realpathSync(call.cwd), realpathSync(d));
  assert.ok(call.argv.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(call.argv.includes('sandbox_mode="read-only"'));
});

test("workspace-write: Codex writes its own attempt report (path with spaces); it is published, the short last message isn't", () => {
  const d = thread();
  const log = join(d, "argv.log");
  const extra = join(d, "extra");
  ask(d, ["start", "--round", "01", "--cwd", d, "--sandbox", "workspace-write", "--write", extra], { FAKE_ARGV_LOG: log });
  const argv: string[] = JSON.parse(readFileSync(log, "utf8").trim()).argv;
  assert.ok(argv.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([d, extra])}`), argv.join(" "));
  assert.ok(argv.includes("sandbox_workspace_write.network_access=false"));
  assert.equal(state(d).status, "complete");
  assert.match(readFileSync(join(d, "01-reply.md"), "utf8"), /Full report body/);
  assert.match(readFileSync(state(d).attempts[0].last, "utf8"), /Summary only/);
});

test("STATUS comes from the last STATUS line: blocked / partial / complete despite the word inside the text", () => {
  for (const [mode, want] of [["blocked", "blocked"], ["partial", "partial"], ["complete", "complete"]]) {
    const d = thread();
    ask(d, ["start", "--round", "01", "--cwd", d], { FAKE_CODEX: mode });
    assert.equal(state(d).status, want, mode);
  }
});

test("no report from this attempt = failed even when an older reply exists (R2); non-zero exit = failed; failed keeps the old reply", () => {
  const d = thread();
  writeFileSync(join(d, "01-reply.md"), "an older report");
  ask(d, ["start", "--round", "01", "--cwd", d, "--sandbox", "workspace-write"], { FAKE_CODEX: "nowrite" });
  assert.equal(state(d).status, "failed");
  assert.equal(readFileSync(join(d, "01-reply.md"), "utf8"), "an older report");
  const e = thread();
  ask(e, ["start", "--round", "01", "--cwd", e], { FAKE_CODEX: "fail" });
  assert.equal(state(e).status, "failed");
});

test("a killed launcher after turn.completed is NOT complete (R1): interrupted with a candidate; accept publishes it", async () => {
  const d = thread();
  const child = await startHanging(d, "turnonly");
  // Wait until the fake has written its report and turn.completed, then kill the launcher and the Codex group.
  for (let i = 0; i < 50 && !/turn\.completed/.test(existsSync(state(d).attempts[0].events) ? readFileSync(state(d).attempts[0].events, "utf8") : ""); i++) await sleep(100);
  const pid = state(d).attempts[0].pid;
  child.kill("SIGKILL");
  process.kill(-pid, "SIGKILL");
  await sleep(300);
  assert.match(ask(d, ["status"]).stdout, /lock remains/);
  assert.equal(ask(d, ["unlock", "--round", "01"]).status, 0);
  assert.match(ask(d, ["status"]).stdout, /interrupted.*exit is unknown/);
  assert.equal(existsSync(join(d, "01-reply.md")), false);
  const a = ask(d, ["accept", "--round", "01"]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(state(d).status, "complete"); // the fake ends with STATUS: complete
  assert.match(readFileSync(join(d, "01-reply.md"), "utf8"), /Full report body/);
});

test("one writer per round (R3, R4): a second start is refused; resume is refused while any old Codex process lives, whatever the status", async () => {
  const d = thread();
  const child = await startHanging(d);
  assert.match(ask(d, ["start", "--round", "01", "--cwd", d]).stderr, /being run by|still alive|already exists/);
  child.kill("SIGKILL"); // the launcher dies, Codex lives on in its own group
  await sleep(300);
  const s = state(d);
  s.status = "failed"; // even a failed-looking round must not get a second writer
  writeFileSync(join(d, "01-state.json"), JSON.stringify(s));
  // The killed launcher left its lock: refused, and unlock refuses too while Codex lives.
  assert.match(ask(d, ["resume", "--round", "01"]).stderr, /stale lock/);
  assert.match(ask(d, ["unlock", "--round", "01"]).stderr, /still alive/);
  process.kill(-s.attempts[0].pid, "SIGKILL");
  await sleep(300);
  assert.equal(ask(d, ["unlock", "--round", "01"]).status, 0);
  const log = join(d, "argv.log");
  const r = ask(d, ["resume", "--round", "01"], { FAKE_ARGV_LOG: log });
  const argv: string[] = JSON.parse(readFileSync(log, "utf8").trim()).argv;
  assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "sess-1"]);
  assert.ok(argv.includes("sandbox_workspace_write.network_access=false") && argv.includes('sandbox_mode="read-only"'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(state(d).status, "complete");
  assert.equal(state(d).attempts.at(-1).resume, true);
});

test("locks are never taken over automatically (R3): a stale lock blocks start until unlock; a live one can't be unlocked", async () => {
  const d = thread();
  writeFileSync(join(d, "01-lock"), "999999"); // a dead owner
  assert.match(ask(d, ["start", "--round", "01", "--cwd", d]).stderr, /stale lock/);
  assert.equal(ask(d, ["unlock", "--round", "01"]).status, 0);
  assert.equal(ask(d, ["start", "--round", "01", "--cwd", d]).status, 0);
  writeFileSync(join(d, "01-lock"), String(process.pid)); // a live owner
  assert.match(ask(d, ["unlock", "--round", "01"]).stderr, /still running/);
  // Two launchers at once on a fresh round: one runs, the other is refused.
  const e = thread();
  const go = () => new Promise<number>((r) => { const c = spawn(process.execPath, [bin, "start", "--round", "01", "--cwd", e, "--thread", e], { env: env(), stdio: "ignore" }); c.on("close", (code) => r(code ?? -1)); });
  const codes = await Promise.all([go(), go()]);
  assert.equal(codes.filter((c) => c === 0).length, 1, String(codes));
  assert.equal(state(e).attempts.length, 1);
});

test("the outcome comes from the final line: text after the STATUS line = no status = partial", async () => {
  const d = thread();
  ask(d, ["start", "--round", "01", "--cwd", d], { FAKE_CODEX: "nostatus" });
  assert.equal(state(d).status, "partial");
  assert.match(state(d).note, /doesn't end with a STATUS line/);
});

test("resume refuses a changed request; an 'active writer' error = interrupted with a wait note; non-ChatGPT auth is refused", () => {
  const d = thread();
  ask(d, ["start", "--round", "01", "--cwd", d], { FAKE_CODEX: "fail" });
  const s = state(d);
  s.sessionId = "sess-1";
  writeFileSync(join(d, "01-state.json"), JSON.stringify(s));
  ask(d, ["resume", "--round", "01"], { FAKE_CODEX: "writer" });
  assert.equal(state(d).status, "interrupted");
  assert.match(state(d).note, /still holds this session/);
  writeFileSync(join(d, "01-request.md"), "Another question?");
  assert.match(ask(d, ["resume", "--round", "01"]).stderr, /request .* changed/);
  const e = thread();
  assert.match(ask(e, ["start", "--round", "01", "--cwd", e], { FAKE_AUTH: "Logged in using an API key" }).stderr, /isn't signed in with ChatGPT/);
});

test("a refused start leaves no lock behind (missing request, wrong auth, no codex CLI), so a retry needs no unlock", () => {
  const d = mkdtempSync(join(tmpdir(), "ask dir-"));
  assert.match(ask(d, ["start", "--round", "01", "--cwd", d]).stderr, /write the request first/);
  assert.equal(existsSync(join(d, "01-lock")), false);
  writeFileSync(join(d, "01-request.md"), "Question?");
  assert.match(ask(d, ["start", "--round", "01", "--cwd", d], { FAKE_AUTH: "Logged in using an API key" }).stderr, /isn't signed in with ChatGPT/);
  assert.equal(existsSync(join(d, "01-lock")), false);
  const r = spawnSync(process.execPath, [bin, "start", "--round", "01", "--cwd", d, "--thread", d], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" }, encoding: "utf8" });
  assert.match(r.stderr, /`codex` CLI isn't installed/);
  assert.equal(existsSync(join(d, "01-lock")), false);
  assert.equal(ask(d, ["start", "--round", "01", "--cwd", d]).status, 0);
});
