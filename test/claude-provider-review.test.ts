// Regression tests for the Claude adapter (bin/lib/claude.ts) from the 2.0 review: auth preflight exit status and shape,
// strict stream evidence, --effort, environment stripping. Fake `claude` only (test/fakes/claude.mjs): no credentials,
// no inference.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const claudeBin = join(root, "bin/claude-ask.ts");
const fakeDir = mkdtempSync(join(tmpdir(), "fake claude-"));
writeFileSync(join(fakeDir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "test/fakes/claude.mjs")}" "$@"\n`);
chmodSync(join(fakeDir, "claude"), 0o755);

const env = (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${fakeDir}:${process.env.PATH}`, ANTHROPIC_API_KEY: "sk-ant-SECRET1", ...extra });
const thread = () => { const d = mkdtempSync(join(tmpdir(), "claude review-")); writeFileSync(join(d, "01-request.md"), "Question?"); return d; };
const ask = (d: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [claudeBin, ...args, "--thread", d], { env: env(extra), encoding: "utf8" });
const start = (d: string, extra: Record<string, string> = {}, more: string[] = []) => ask(d, ["start", "--round", "01", "--cwd", d, ...more], { FAKE_LOG: join(d, "fake.log"), ...extra });
const state = (d: string) => JSON.parse(readFileSync(join(d, "01-state.json"), "utf8"));
const logOf = (d: string) => { const p = join(d, "fake.log"); return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const runs = (d: string) => logOf(d).filter((e) => e.prompt !== undefined);
const flagValue = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];

function refusedBeforeInference(d: string, r: ReturnType<typeof ask>, pattern: RegExp) {
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, pattern);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET|example\.invalid|org-/);
  assert.equal(runs(d).length, 0, "no inference");
  assert.equal(existsSync(join(d, "01-lock")), false);
  assert.equal(existsSync(join(d, "01-state.json")), false);
}

test("auth preflight: a nonzero exit is refused even with logged-in JSON; non-object or incomplete JSON is refused; nothing sensitive printed", () => {
  const d = thread();
  refusedBeforeInference(d, start(d, { FAKE_AUTH_EXIT: "1" }), /auth status --json` didn't succeed \(exit 1\).*Claude subscription/);
  for (const raw of ["[]", '"logged in"', "null", "42", "[{\"loggedIn\":true}]"]) {
    const e = thread();
    refusedBeforeInference(e, start(e, { FAKE_AUTH: raw, FAKE_AUTH_EXIT: "0" }), /not a JSON object/);
  }
  const f = thread();
  refusedBeforeInference(f, start(f, { FAKE_AUTH: "{}", FAKE_AUTH_EXIT: "0" }), /loggedIn missing.*authMethod missing.*apiProvider missing.*subscriptionType missing/);
  const g = thread();
  refusedBeforeInference(g, start(g, { FAKE_AUTH: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "x-SECRET@example.invalid" }), FAKE_AUTH_EXIT: "3" }), /exit 3/);
});

test("help / version failures are refused before inference", () => {
  const d = thread();
  refusedBeforeInference(d, start(d, { FAKE_HELP_EXIT: "1" }), /`claude --help` didn't succeed/);
  const e = thread();
  refusedBeforeInference(e, start(e, { FAKE_VERSION_EXIT: "1" }), /`claude --version` didn't succeed/);
  const f = thread();
  refusedBeforeInference(f, start(f, { FAKE_HELP_DROP: "--effort" }), /doesn't offer .*--effort/);
});

test("strict evidence: a success result with a broken, conflicting or foreign stream is failed and nothing is published", () => {
  const cases: [string, RegExp][] = [
    ["badline", /1 unreadable event line/], ["tworesults", /2 result events/], ["errorevent", /error event\(s\): server_error/],
    ["noinit", /no init event/], ["sessionmismatch", /session differs/], ["noiserror", /result "success"/],
    ["nonstring", /success result has no text/], ["apikey", /apiKeySource "ANTHROPIC_API_KEY"/],
    ["extratool", /tools that weren't selected \(Bash\)/], ["permmode", /permissionMode "default"/],
  ];
  for (const [mode, note] of cases) {
    const d = thread();
    writeFileSync(join(d, "01-reply.md"), "an older report");
    const r = start(d, { FAKE_CLAUDE: mode });
    const s = state(d);
    assert.equal(s.status, "failed", `${mode}: ${s.note}`);
    assert.match(s.note, note, mode);
    assert.equal(r.status, 1, mode);
    assert.equal(readFileSync(join(d, "01-reply.md"), "utf8"), "an older report", mode);
    assert.equal(s.candidate, undefined, mode);
    assert.equal(runs(d).length, 1, `${mode}: one inference, no retry`);
  }
});

test("well-formed extra events (other system subtypes, rate limit events) still count; quota stays interrupted, denials stay partial", () => {
  const d = thread();
  const r = start(d, { FAKE_CLAUDE: "ratelimit" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(state(d).status, "complete");
  assert.match(readFileSync(join(d, "01-reply.md"), "utf8"), /Full report body/);
  const e = thread();
  start(e, { FAKE_CLAUDE: "quota" });
  assert.equal(state(e).status, "interrupted");
  assert.match(state(e).note, /usage limit was reached/);
  const f = thread();
  start(f, { FAKE_CLAUDE: "denied" });
  assert.equal(state(f).status, "partial");
  assert.match(state(f).note, /permission request\(s\) denied/);
});

test("--effort: passed on start, resume and follow-up; validated; --resume stays the last argument", () => {
  const d = thread();
  start(d);
  assert.equal(flagValue(runs(d)[0].argv, "--effort"), "high");
  const e = thread();
  start(e, { FAKE_CLAUDE: "quota" }, ["--effort", "xhigh"]);
  const r = ask(e, ["resume", "--round", "01"], { FAKE_LOG: join(e, "fake.log") });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [first, second] = runs(e);
  assert.equal(flagValue(first.argv, "--effort"), "xhigh");
  assert.equal(flagValue(second.argv, "--effort"), "xhigh");
  assert.deepEqual(second.argv.slice(-2), ["--resume", "c-sess-1"]);
  writeFileSync(join(e, "02-request.md"), "More?");
  const f = ask(e, ["start", "--round", "02", "--continue-from", "01", "--effort", "max"], { FAKE_LOG: join(e, "fake.log") });
  assert.equal(f.status, 0, f.stdout + f.stderr);
  const third = runs(e).at(-1);
  assert.equal(flagValue(third.argv, "--effort"), "max");
  assert.deepEqual(third.argv.slice(-2), ["--resume", "c-sess-1"]);
  for (const bad of ["extreme", "minimal", "HIGH"]) {
    const g = thread();
    refusedBeforeInference(g, start(g, {}, ["--effort", bad]), /--effort for Claude must be one of low, medium, high, xhigh, max/);
  }
});

test("environment: cloud routing switches, cloud credentials, key helpers and tokens never reach Claude; HOME and the native login stay", () => {
  const d = thread();
  const extra = {
    AWS_ACCESS_KEY_ID: "AKIA-SECRET", AWS_SECRET_ACCESS_KEY: "SECRET", AWS_SESSION_TOKEN: "SECRET", AWS_PROFILE: "bedrock", AWS_REGION: "us-east-1",
    AWS_BEARER_TOKEN_BEDROCK: "SECRET", GOOGLE_APPLICATION_CREDENTIALS: "/tmp/SECRET.json", GOOGLE_CLOUD_PROJECT: "p", GCLOUD_PROJECT: "p",
    CLOUDSDK_CONFIG: "/tmp/gc", CLOUD_ML_REGION: "us-east5", VERTEX_REGION_CLAUDE_X: "us-east5", AZURE_CLIENT_SECRET: "SECRET",
    CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    ANTHROPIC_FOUNDRY_API_KEY: "SECRET", ANTHROPIC_BEDROCK_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_VERTEX_PROJECT_ID: "p",
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "1", CLAUDE_CODE_OAUTH_TOKEN: "SECRET", ANTHROPIC_AUTH_TOKEN: "SECRET", GITHUB_AUTH_TOKEN: "SECRET",
  };
  const r = start(d, extra);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const entries = logOf(d);
  assert.ok(entries.length >= 2);
  for (const e of entries) {
    for (const k of [...Object.keys(extra), "ANTHROPIC_API_KEY"]) assert.ok(!e.envKeys.includes(k), `${k} reached claude`);
    assert.deepEqual(e.leaked, []);
    assert.ok(e.envKeys.includes("HOME") && e.envKeys.includes("PATH") && e.envKeys.includes("DISABLE_AUTOUPDATER"));
  }
  const call = runs(d)[0];
  assert.equal(flagValue(call.argv, "--setting-sources"), "");
  assert.ok(call.argv.includes("--restricted") && call.argv.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(flagValue(call.argv, "--mcp-config")), { mcpServers: {} });
  assert.equal(JSON.parse(flagValue(call.argv, "--settings")).apiKeyHelper, undefined);
});
