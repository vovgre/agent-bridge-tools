// The Claude Code adapter (`claude -p`, stream-json). Subscription-only: the environment loses API keys, tokens, base
// URLs, cloud-provider switches and cloud credentials (list at STRIP), `claude auth status --json` must exit 0 and show a
// claude.ai subscription login, and the CLI must offer every restriction the launcher passes (checked in `claude --help`
// before any inference). No shell tool: read-only rounds get Read/Glob/Grep, implementation rounds add Edit/Write, all
// inside --cwd (--restricted). Permissions are never bypassed (dontAsk: anything not pre-approved is denied, and a denial
// keeps the round from being complete).
//
// CLI contracts this relies on (Claude Code 2.1.326, from its --help and observed output; see docs/ROUNDS.md):
//   flags  -p/--print, --output-format stream-json, --verbose, --setting-sources, --settings, --strict-mcp-config,
//          --mcp-config, --disable-slash-commands, --no-chrome, --restricted, --tools, --allowedTools,
//          --permission-mode dontAsk, --effort low|medium|high|xhigh|max, --resume <session id>; the prompt comes on stdin.
//   events {"type":"system","subtype":"init","session_id","tools","permissionMode","apiKeySource"} first; other
//          well-formed events in between (other system subtypes, rate limit events, assistant / user messages);
//          exactly one {"type":"result","subtype":"success"|"error_…","is_error","result","session_id",
//          "permission_denials":[…],"usage",…} last.
//   auth   `claude --setting-sources '' auth status --json` -> exit 0 and { loggedIn, authMethod, apiProvider, subscriptionType, … }.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { die, file, readText } from "./common.ts";
import type { Attempt, Evidence, Kind, Provider, State } from "./common.ts";
import { canon, gitTop, inside } from "./scope.ts";

/** Subscription plans accepted (as reported by `auth status --json` in subscriptionType). */
export const SUBSCRIPTIONS = ["max", "pro", "team", "enterprise"];
/** Effort levels of `--effort` in Claude Code 2.1.326. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const READ_TOOLS = ["Read", "Glob", "Grep"];
const WRITE_TOOLS = ["Edit", "Write"];
const toolsOf = (s: State) => [...READ_TOOLS, ...(s.sandbox === "workspace-write" ? WRITE_TOOLS : [])];
/** Inline settings: no hooks; the tools the launcher doesn't select are denied outright as well. */
const SETTINGS = { disableAllHooks: true, permissions: { deny: ["Bash", "WebFetch", "WebSearch"] } };
const NO_MCP = '{"mcpServers":{}}';

/**
 * Removed from Claude's environment:
 *   - API keys and auth tokens of any service (`*_API_KEY`, `*_AUTH_TOKEN`), every `ANTHROPIC_*` variable (key, token,
 *     base URL, custom headers, models, Bedrock / Vertex / Foundry base URLs and keys);
 *   - the cloud routing switches and skips (`CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*`), an inherited OAuth token or key
 *     helper setting (`CLAUDE_CODE_OAUTH_*`, `CLAUDE_CODE_API_KEY*`);
 *   - cloud credentials and project / region selectors: every `AWS_*` (keys, session tokens, profiles, Bedrock bearer
 *     token, region), `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `CLOUDSDK_*`,
 *     `CLOUD_ML_REGION`, `VERTEX_REGION_*`, every `AZURE_*`;
 *   - the markers of an outer Claude Code session.
 * Not removed: HOME, PATH, proxies, CLAUDE_CONFIG_DIR, so the native login (macOS Keychain or ~/.claude) keeps working.
 * Cloud credential files reachable through HOME (~/.aws, ~/.config/gcloud) stay on disk; they are only used when a
 * CLAUDE_CODE_USE_* switch is set, and the switches can't come from settings either (--setting-sources '').
 */
const STRIP = /^(ANTHROPIC_.*|CLAUDE_CODE_USE_.*|CLAUDE_CODE_SKIP_.*|CLAUDE_CODE_OAUTH_.*|CLAUDE_CODE_API_KEY.*|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDECODE|AWS_.*|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|CLOUDSDK_.*|CLOUD_ML_REGION|VERTEX_REGION_.*|AZURE_.*|.*_API_KEY|.*_AUTH_TOKEN)$/;
export function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (STRIP.test(k)) delete env[k];
  env.DISABLE_AUTOUPDATER = "1"; // never install anything during a round
  return env;
}

/** A value from auth status that is safe to show: short enum-like strings and booleans only. */
const show = (v: unknown) => typeof v === "boolean" ? String(v) : v == null ? "missing" : typeof v === "string" && /^[\w.-]{1,32}$/.test(v) ? JSON.stringify(v) : "(unexpected value)";
/** Error text from Claude, shortened, with anything that looks like a key or token removed. */
const redact = (t: string) => t.replace(/\s+/g, " ").replace(/(sk-[\w-]{6,}|[A-Za-z0-9_\-+/=]{32,})/g, "[redacted]").trim().slice(0, 240);
const exitOf = (r: ReturnType<typeof spawnSync>) => r.error ? ((r.error as NodeJS.ErrnoException).code ?? "error") : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;

const NO_CLI = "the `claude` CLI isn't installed or not on PATH: install Claude Code and sign in yourself (`claude auth login`); the launcher never installs or signs in";
function checkAuth(env: NodeJS.ProcessEnv) {
  const r = spawnSync("claude", ["--setting-sources", "", "auth", "status", "--json"], { env, encoding: "utf8", timeout: 60_000 });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") die(NO_CLI);
  const hint = "Sign in yourself with `claude auth login` and a Claude subscription (Pro / Max / Team / Enterprise); API keys, auth tokens, Bedrock / Vertex and other providers are refused, and nothing was run.";
  // The output is never printed: it may hold the account's email or organization.
  if (r.error || r.status !== 0) die(`\`claude auth status --json\` didn't succeed (${exitOf(r)}), so the Claude subscription login can't be confirmed. ${hint}`);
  let j: unknown;
  try { j = JSON.parse((r.stdout ?? "").trim()); } catch {}
  if (!j || typeof j !== "object" || Array.isArray(j)) die(`couldn't read \`claude auth status --json\` (not a JSON object), so the Claude subscription login can't be confirmed. ${hint}`);
  const a = j as Record<string, unknown>;
  const problems: string[] = [];
  if (a.loggedIn !== true) problems.push(`loggedIn ${show(a.loggedIn)}`);
  if (a.authMethod !== "claude.ai") problems.push(`authMethod ${show(a.authMethod)}, needs "claude.ai"`);
  if (a.apiProvider !== "firstParty") problems.push(`apiProvider ${show(a.apiProvider)}, needs "firstParty"`);
  if (typeof a.subscriptionType !== "string" || !SUBSCRIPTIONS.includes(a.subscriptionType.toLowerCase())) {
    problems.push(`subscriptionType ${show(a.subscriptionType)}, needs one of ${SUBSCRIPTIONS.join(" / ")}`);
  }
  if (problems.length) die(`Claude isn't signed in with a Claude subscription (${problems.join("; ")}). ${hint}`);
}

const NEEDED = ["--print", "--output-format", "--verbose", "--setting-sources", "--settings", "--strict-mcp-config", "--mcp-config",
  "--disable-slash-commands", "--no-chrome", "--restricted", "--tools", "--allowedTools", "--permission-mode", "--effort", "--resume"];
const has = (help: string, f: string) => new RegExp(`(^|[\\s,])${f.replace(/[-]/g, "\\-")}(?![\\w-])`, "m").test(help);
/** Every restriction must be offered by this CLI, or nothing runs (an older CLI would silently ignore or reject them). */
function checkCapabilities(s: State, env: NodeJS.ProcessEnv): string {
  const r = spawnSync("claude", ["--help"], { env, encoding: "utf8", timeout: 60_000 });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") die(NO_CLI);
  if (r.error || r.status !== 0) die(`\`claude --help\` didn't succeed (${exitOf(r)}), so the launcher can't confirm the CLI's restrictions (nothing was run)`);
  const help = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const missing = [...NEEDED, ...(s.model ? ["--model"] : [])].filter((f) => !has(help, f));
  if (!/\bdontAsk\b/.test(help)) missing.push("--permission-mode dontAsk");
  if (!/\bstream-json\b/.test(help)) missing.push("--output-format stream-json");
  if (missing.length) die(`this Claude Code CLI doesn't offer ${missing.join(", ")}, which the launcher needs to restrict it; update Claude Code yourself (nothing was run)`);
  const v = spawnSync("claude", ["--version"], { env, encoding: "utf8", timeout: 60_000 });
  if (v.error || v.status !== 0) die(`\`claude --version\` didn't succeed (${exitOf(v)}); check the Claude Code install yourself (nothing was run)`);
  const line = (v.stdout ?? "").trim().split("\n")[0] ?? "";
  return /^[\w .()+-]{1,60}$/.test(line) ? line : "unknown";
}

function footer(s: State, a: Attempt): string {
  const write = s.sandbox === "workspace-write";
  const tools = write ? "Read, Glob, Grep, Edit and Write" : "Read, Glob and Grep (read-only)";
  const scope = write
    ? `You may change only: ${s.write.join(", ")}. Changes anywhere else are detected after the round and make it not complete.`
    : `Change no files.`;
  return `\n\n---\nRound ${s.round} (${s.mode}), attempt ${a.n}. Your tools: ${tools}, only inside ${s.cwd}. There is no shell: you can't run ` +
    `tests, builds or git; list the exact checks the orchestrator should run. Anything not pre-approved is denied; don't try to get around a denial, report it.\n` +
    `${scope}\nYour FINAL RESPONSE is the full report (the launcher saves it; don't write a report file). Start it with the decision and the number ` +
    `of blocking findings. End it with one line: STATUS: complete | blocked | partial (and why if not complete).\n`;
}

const QUOTA = /usage limit|rate[ _-]?limit|hit your limit|limit (reached|exceeded)|quota|too many requests|\b429\b/i;
const AUTH = /not logged in|invalid api key|please run \/login|authentication[_ ](error|failed)|unauthori[sz]ed|oauth token|\b401\b|credit balance/i;

interface Stream { init?: any; result?: any; results: number; bad: number; errors: string[] }
function readStream(path: string): Stream {
  const out: Stream = { results: 0, bad: 0, errors: [] };
  for (const line of readText(path).split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { out.bad++; continue; }
    if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.type !== "string") { out.bad++; continue; }
    if (e.type === "system" && e.subtype === "init") out.init ??= e;
    else if (e.type === "result") { out.results++; out.result = e; }
    else if (e.type === "error") out.errors.push(typeof e.message === "string" ? e.message : "error event");
    else if (e.type === "assistant" && e.error != null) out.errors.push(typeof e.error === "string" ? e.error : "assistant error");
  }
  return out;
}

/** Stream integrity: every line an event, one init naming the session with the launcher's restrictions, one result for that session. */
function integrity(s: State, st: Stream): string[] {
  const p: string[] = [];
  if (st.bad) p.push(`${st.bad} unreadable event line(s)`);
  if (st.results > 1) p.push(`${st.results} result events`);
  const id = st.init?.session_id;
  if (!st.init) p.push("no init event");
  else {
    if (typeof id !== "string" || !id) p.push("the init event names no session");
    if (st.init.permissionMode !== undefined && st.init.permissionMode !== "dontAsk") p.push(`init permissionMode ${show(st.init.permissionMode)}, expected "dontAsk"`);
    if (st.init.apiKeySource !== undefined && st.init.apiKeySource !== "none") p.push(`init apiKeySource ${show(st.init.apiKeySource)}, expected "none" (an API key was in use)`);
    if (Array.isArray(st.init.tools)) {
      const extra = st.init.tools.filter((t: unknown) => !toolsOf(s).includes(String(t)));
      if (extra.length) p.push(`init lists tools that weren't selected (${extra.slice(0, 5).map(String).join(", ")})`);
    }
  }
  if (st.result && typeof id === "string" && st.result.session_id !== id) p.push("the result event's session differs from the init event's");
  if (st.errors.length) p.push(`error event(s): ${redact(st.errors.join("; "))}`);
  return p;
}

const pickUsage = (r: any): Record<string, unknown> | undefined => {
  if (!r) return undefined;
  const u = r.usage ?? {};
  const out: Record<string, unknown> = {};
  for (const k of ["num_turns", "duration_ms", "duration_api_ms", "total_cost_usd"]) if (typeof r[k] === "number") out[k] = r[k];
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) if (typeof u[k] === "number") out[k] = u[k];
  return out;
};

export const claude: Provider = {
  name: "claude", label: "Claude", bin: "claude", keepFirstSession: false, requireScope: true,
  validate(s: State) {
    if (!EFFORTS.includes(s.effort)) die(`--effort for Claude must be one of ${EFFORTS.join(", ")} (got ${show(s.effort)})`);
    if (s.sandbox !== "workspace-write") return;
    if (!s.write.length) die("--sandbox workspace-write needs --write <path> for each file or folder Claude may change (e.g. --write \"<worktree>/src\", or the worktree itself)");
    const cwd = canon(s.cwd);
    const outside = s.write.filter((w) => !inside(canon(w), cwd));
    if (outside.length) die(`Claude's file tools only work inside --cwd (${s.cwd}); these --write paths are outside it: ${outside.join(", ")}`);
    if (!gitTop(s.cwd)) die(`an implementation round with Claude needs --cwd inside a git worktree (the scope check compares git status before and after): ${s.cwd}`);
  },
  preflight(s: State) {
    const env = claudeEnv();
    s.cli = checkCapabilities(s, env);
    checkAuth(env);
  },
  env: claudeEnv,
  argv(s: State, _a: Attempt, session?: string) {
    const tools = toolsOf(s).join(",");
    return ["-p", "--output-format", "stream-json", "--verbose",
      "--setting-sources", "", "--settings", JSON.stringify(SETTINGS), "--strict-mcp-config", "--mcp-config", NO_MCP,
      "--disable-slash-commands", "--no-chrome", "--restricted", "--permission-mode", "dontAsk",
      "--tools", tools, "--allowedTools", tools, "--effort", s.effort,
      ...(s.model ? ["--model", s.model] : []), ...(session ? ["--resume", session] : [])];
  },
  prompt(s: State, a: Attempt, kind: Kind) {
    if (kind === "resume") {
      return `Your previous attempt on round ${s.round} was interrupted or stopped. Continue the same request from where you stopped: ` +
        `check the files you may change for what is already done, and don't redo finished work.` + footer(s, a);
    }
    const request = readFileSync(file(s.round, "request.md"), "utf8");
    if (kind === "follow-up") return `Follow-up round ${s.round}, continuing round ${s.continueFrom} in the same session. The new request:\n\n${request}${footer(s, a)}`;
    return request + footer(s, a);
  },
  sessionIn(path: string) {
    const e = readStream(path);
    const id = e.init?.session_id ?? e.result?.session_id;
    return typeof id === "string" && id ? id : undefined;
  },
  allowed: (s) => s.write,
  evidence(s: State, a: Attempt): Evidence {
    const st = readStream(a.events);
    const r = st.result;
    const problems = integrity(s, st);
    const success = !!r && r.subtype === "success" && r.is_error === false;
    const text = success && typeof r.result === "string" ? r.result.trim() : "";
    const ok = success && typeof r.result === "string" && !problems.length;
    if (success && typeof r.result !== "string") problems.push("the success result has no text");
    // Only this attempt's final response becomes its report (the attempt files were removed before it started).
    if (ok && text) { writeFileSync(a.last, text + "\n"); writeFileSync(a.reply, text + "\n"); }
    const errText = success ? "" : redact(`${typeof r?.result === "string" ? r.result : ""} ${st.errors.join(" ")} ${readText(a.stderr)}`);
    const quota = !success && QUOTA.test(errText);
    const auth = !success && !quota && AUTH.test(errText);
    const denials: any[] = Array.isArray(r?.permission_denials) ? r.permission_denials : [];
    const blockers = denials.length
      ? [`${denials.length} permission request(s) denied (${[...new Set(denials.map((d) => String(d?.tool_name ?? "?")))].join(", ")}): the requested work may be incomplete`]
      : [];
    const epoch = /\|(\d{10})\b/.exec(errText)?.[1];
    const resetText = /resets?[^.;|]{0,40}/i.exec(errText)?.[0];
    const reset = epoch ? ` (resets ${new Date(Number(epoch) * 1000).toISOString()})` : resetText ? ` (${resetText.trim()})` : "";
    const what = r ? (success ? "" : `, result ${show(r.subtype)}${r.is_error ? " (error)" : ""}`) : ", no result event (the stream ended early)";
    return {
      done: !!r, failed: !!r && !ok, report: ok ? text : "", statusText: ok ? text : "", blockers, usage: pickUsage(r),
      interrupt: quota ? `the Claude subscription's usage limit was reached${reset}: nothing is retried automatically; \`resume\` after the limit resets` : undefined,
      failNote: auth
        ? `Claude refused the sign-in (${errText}): check \`claude auth status\` and sign in yourself with \`claude auth login\` (the launcher never signs in)`
        : `exit ${a.exitCode}${what}${problems.length ? `, ${problems.join(", ")}` : ""}${errText ? `: ${errText}` : ""}; see ${basename(a.stderr)} and ${basename(a.events)}`,
      missingNote: `Claude finished but its final response (this attempt's report) is empty; see ${basename(a.events)}`,
    };
  },
};
