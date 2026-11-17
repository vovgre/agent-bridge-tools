// Regressions from independent integration review. All inference uses a fake CLI.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { processInfo } from "../bin/lib/common.ts";
import { compare, snapshot } from "../bin/lib/scope.ts";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "bin/claude-ask.ts");
const base = mkdtempSync(join(tmpdir(), "bridge-review-"));
const fake = join(base, "bin");
mkdirSync(fake);
writeFileSync(join(fake, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "test/fakes/claude.mjs")}" "$@"\n`, { mode: 0o755 });
const env = { ...process.env, PATH: fake + ":" + process.env.PATH, AGENT_ASK_KILL_GRACE_MS: "100" };
function fixture(same = false) {
  const cwd = mkdtempSync(join(base, "repo-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  writeFileSync(join(cwd, "allowed.txt"), "a");
  writeFileSync(join(cwd, "outside.txt"), "b");
  git("add", "."); git("commit", "-qm", "fixture");
  const thread = same ? cwd : mkdtempSync(join(base, "thread-"));
  writeFileSync(join(thread, "01-request.md"), "Test request");
  return { cwd, thread };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args, "--thread", f.thread], { env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 });
}
const state = (f: Fixture) => JSON.parse(readFileSync(join(f.thread, "01-state.json"), "utf8"));
const start = (f: Fixture) => ["start", "--round", "01", "--cwd", f.cwd, "--sandbox", "workspace-write", "--write", join(f.cwd, "allowed.txt")];

test("an implementation thread cannot exclude the whole worktree from scope detection", () => {
  const f = fixture(true);
  const r = run(f, start(f));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /thread must not contain --cwd/);
  assert.equal(existsSync(join(f.thread, "01-lock")), false);
});

test("resume preserves an earlier scope violation until the unauthorized edit is restored", () => {
  const f = fixture();
  const edit = (content: string) => ({ FAKE_EDITS: JSON.stringify([{ op: "write", path: "outside.txt", content }]) });
  assert.equal(run(f, start(f), edit("unauthorized")).status, 1);
  assert.equal(state(f).status, "partial");
  assert.equal(run(f, ["resume", "--round", "01"]).status, 1);
  assert.equal(state(f).status, "partial");
  assert.match(state(f).note, /outside --write/);
  assert.equal(readFileSync(join(f.cwd, "outside.txt"), "utf8"), "unauthorized");
  const restored = run(f, ["resume", "--round", "01"], edit("b"));
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(state(f).status, "complete");
});

test("a cancellation request just before provider exit wins over success publication", () => {
  const f = fixture();
  const bin = mkdtempSync(join(base, "cancel-fake-"));
  const js = join(bin, "fake.mjs");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  writeFileSync(js, `import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--help')||args.includes('--version')||args.includes('auth')) {
 const r=spawnSync(process.execPath,[${JSON.stringify(join(root, "test/fakes/claude.mjs"))},...args],{stdio:'inherit'});process.exit(r.status??1);
}
readFileSync(0,'utf8');
const thread=${JSON.stringify(f.thread)};
const s=JSON.parse(readFileSync(thread+'/01-state.json','utf8'));
const a=s.attempts.at(-1);
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'cancel-session',tools:['Read','Glob','Grep'],permissionMode:'dontAsk',apiKeySource:'none'}));
writeFileSync(thread+'/01-cancel.json',JSON.stringify({round:'01',attempt:a.n,pid:process.pid,nonce:'review-test',requestedAt:new Date().toISOString(),by:process.pid}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'cancel-session',result:'Done\\nSTATUS: complete',permission_denials:[]}));
`);
  const r = run(f, ["start", "--round", "01", "--cwd", f.cwd], { PATH: bin + ":" + process.env.PATH });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(state(f).status, "cancelled");
  assert.equal(existsSync(join(f.thread, "01-reply.md")), false);
});

test("orphan cancellation requires the recorded birth identity, even for a recent process named claude", async () => {
  const f = fixture();
  const other = spawn(process.execPath, ["-e", "/* claude */ setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const closed = new Promise((done) => other.once("close", done));
  try {
    assert.ok(other.pid);
    const identity = processInfo(other.pid!);
    assert.ok(identity, "this process-inspection test needs ps access");
    writeFileSync(join(f.thread, "01-state.json"), JSON.stringify({
      provider: "claude", round: "01", status: "running", mode: "review", cwd: f.cwd, sandbox: "read-only", effort: "high", write: [],
      requestSha256: "x", reply: join(f.thread, "01-reply.md"), updatedAt: new Date().toISOString(),
      attempts: [{ n: 1, startedAt: new Date().toISOString(), pid: other.pid, processIdentity: { ...identity, start: identity!.start - 1000 }, events: "x", stderr: "y", last: "z", reply: "w" }],
    }));
    const r = run(f, ["cancel", "--round", "01"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /can't confirm.*nothing was signalled/);
    assert.doesNotThrow(() => process.kill(other.pid!, 0));
  } finally { other.kill("SIGKILL"); await closed; }
});

test("scope detects a permission change to an already-dirty file", () => {
  const f = fixture();
  writeFileSync(join(f.cwd, "outside.txt"), "already dirty");
  const b = snapshot(f.cwd)!;
  chmodSync(join(f.cwd, "outside.txt"), 0o755);
  const report = compare(b, [join(f.cwd, "allowed.txt")], []);
  assert.equal(report.outside.length, 1);
  assert.equal(report.outside[0].wasDirty, true);
});
