// A stand-in for `claude` in tests (no credentials, no inference). The tests put a tiny executable `claude` wrapper on
// PATH that execs this file. FAKE_CLAUDE = complete | blocked | partial | nostatus | noreport | error | truncate | exit1 |
// denied | quota | auth | hang | slow | stubborn. FAKE_AUTH = the raw auth status output. FAKE_HELP_DROP = flags left
// out of --help. FAKE_EDITS = JSON list of file operations done in the cwd before the result. FAKE_LOG = a jsonl log
// (argv, cwd, leaked env names, prompt). FAKE_PIDS = a file for the pids of the stubborn mode.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const env = process.env;
// Exit overrides: FAKE_AUTH_EXIT, FAKE_HELP_EXIT, FAKE_VERSION_EXIT. Malformed-success modes (a success result that must
// not count): badline, tworesults, errorevent, noinit, sessionmismatch, noiserror, nonstring, apikey, extratool,
// permmode. Mode ratelimit = a success with well-formed extra system / rate limit events (must count).
const LEAK = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_SKIP_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_REGION$|VERTEX_REGION_|AZURE_|OPENAI_API_KEY$|CODEX_API_KEY$|CLAUDECODE$|.*_API_KEY$|.*_AUTH_TOKEN$)/;
const leaked = Object.keys(env).filter((k) => LEAK.test(k));
const log = (o) => { if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, JSON.stringify({ ...o, argv: args, cwd: process.cwd(), leaked, envKeys: Object.keys(env) }) + "\n"); };

if (args.includes("--version")) { console.log(env.FAKE_VERSION ?? "2.1.326 (Claude Code)"); process.exit(Number(env.FAKE_VERSION_EXIT ?? 0)); }
if (args.includes("--help")) {
  const flags = [
    "-p, --print  Print response and exit", '--output-format <format>  (choices: "text", "json", "stream-json")', "--verbose",
    "--setting-sources <sources>", "--settings <file-or-json>", "--strict-mcp-config", "--mcp-config <configs...>",
    "--disable-slash-commands", "--no-chrome", "--restricted  Confine file tools to the working directories", "--tools <tools...>",
    "--allowedTools, --allowed-tools <tools...>", '--permission-mode <mode>  (choices: "acceptEdits", "bypassPermissions", "default", "dontAsk", "plan")',
    '--effort <level>  (choices: "low", "medium", "high", "xhigh", "max")', "-r, --resume [value]", "--model <model>",
  ];
  const drop = (env.FAKE_HELP_DROP ?? "").split(",").filter(Boolean);
  console.log(["Usage: claude [options] [command] [prompt]", "", "Options:", ...flags.filter((l) => !drop.some((d) => l.startsWith(d) || l.includes(` ${d} `) || l.includes(`${d}  `))).map((l) => `  ${l}`)].join("\n"));
  process.exit(Number(env.FAKE_HELP_EXIT ?? 0));
}
if (args.includes("auth") && args.includes("status")) {
  log({ auth: true });
  const ok = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "owner-SECRET6@example.invalid", orgId: "org-SECRET7" };
  console.log(env.FAKE_AUTH ?? JSON.stringify(ok));
  // Like the real CLI: exit 0 when logged in, 1 otherwise (FAKE_AUTH_EXIT overrides).
  let loggedIn = !env.FAKE_AUTH;
  try { loggedIn ||= JSON.parse(env.FAKE_AUTH)?.loggedIn === true; } catch {}
  process.exit(Number(env.FAKE_AUTH_EXIT ?? (loggedIn ? 0 : 1)));
}

const prompt = readFileSync(0, "utf8");
log({ prompt });
const mode = env.FAKE_CLAUDE ?? "complete";
const ri = args.indexOf("--resume");
const session = ri >= 0 ? args[ri + 1] : (env.FAKE_SESSION ?? "c-sess-1");
const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
const ti = args.indexOf("--tools");
const tools = ti >= 0 ? args[ti + 1].split(",") : [];
if (mode !== "noinit") {
  out({
    type: "system", subtype: "init", session_id: session, cwd: process.cwd(), model: "claude-fake",
    tools: mode === "extratool" ? [...tools, "Bash"] : tools, mcp_servers: [],
    permissionMode: mode === "permmode" ? "default" : args[args.indexOf("--permission-mode") + 1],
    apiKeySource: mode === "apikey" ? "ANTHROPIC_API_KEY" : "none",
  });
}

for (const op of JSON.parse(env.FAKE_EDITS ?? "[]")) {
  if (op.op === "write") { mkdirSync(dirname(resolve(op.path)), { recursive: true }); writeFileSync(resolve(op.path), op.content); }
  if (op.op === "rm") rmSync(resolve(op.path));
  if (op.op === "rename") renameSync(resolve(op.from), resolve(op.to));
}

const status = mode === "blocked" ? "blocked" : mode === "partial" ? "partial" : "complete";
const text = `Decision: done. Blocking findings: 0.\nWe mention STATUS: blocked inside the text on purpose.\nFull report body.` + (mode === "nostatus" ? `\nSTATUS: complete\nand then more text` : `\nSTATUS: ${status}`);
const result = (extra = {}) => out({
  type: "result", subtype: "success", is_error: false, result: text, session_id: session, num_turns: 2, duration_ms: 5,
  total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 }, permission_denials: [], ...extra,
});
const assistant = () => out({ type: "assistant", session_id: session, message: { role: "assistant", content: [{ type: "text", text: "Working." }] } });

if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  const g = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  if (env.FAKE_PIDS) writeFileSync(env.FAKE_PIDS, JSON.stringify({ self: process.pid, grandchild: g.pid }));
  setInterval(() => {}, 1000);
} else if (mode === "slow") {
  assistant();
  setTimeout(() => { result(); process.exit(0); }, Number(env.FAKE_DELAY_MS ?? 2000));
} else if (mode === "truncate") {
  assistant();
  process.stdout.write('{"type":"assistant","mess');
  process.exit(0);
} else if (mode === "noreport") { result({ result: "" }); }
else if (mode === "error") { assistant(); result({ subtype: "error_during_execution", is_error: true, result: undefined }); process.exitCode = 1; }
else if (mode === "exit1") { assistant(); result(); process.exitCode = 1; }
else if (mode === "denied") {
  assistant();
  result({ permission_denials: [{ tool_name: "Edit", tool_use_id: "t1", tool_input: { file_path: "/elsewhere/x.ts" } }, { tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "npm test" } }] });
} else if (mode === "quota") { result({ is_error: true, result: "Claude AI usage limit reached|1763400000" }); process.exitCode = 1; }
else if (mode === "auth") { result({ is_error: true, result: "Invalid API key · Please run /login" }); process.exitCode = 1; }
else if (mode === "badline") { assistant(); process.stdout.write("not json at all\n"); result(); }
else if (mode === "tworesults") { assistant(); result(); result({ result: "A different answer.\nSTATUS: complete" }); }
else if (mode === "errorevent") { out({ type: "assistant", session_id: session, error: "server_error", message: { role: "assistant", content: [] } }); result(); }
else if (mode === "sessionmismatch") { assistant(); result({ session_id: "another-session" }); }
else if (mode === "noiserror") { assistant(); result({ is_error: undefined }); }
else if (mode === "nonstring") { assistant(); result({ result: { text } }); }
else if (mode === "ratelimit") {
  out({ type: "system", subtype: "status", session_id: session, status: "requesting" });
  out({ type: "rate_limit_event", session_id: session, rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } });
  assistant();
  result();
} else { assistant(); result(); }
