// The Codex adapter (`codex exec`): the 1.x behavior of bin/codex-ask.ts, unchanged (prompt footer, sandbox policy,
// ChatGPT-only auth, report rules), plus follow-up rounds through `codex exec resume`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { ctx, die, file, readText } from "./common.ts";
import type { Attempt, Evidence, Kind, Provider, State } from "./common.ts";

const KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"];
const env = () => { const e = { ...process.env }; for (const k of KEYS) delete e[k]; return e; };

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
  const roots = s.sandbox === "workspace-write" ? [ctx.thread, ...s.write] : [];
  return ["-c", `sandbox_mode="${s.sandbox}"`, "-c", `approval_policy="never"`, "-c", `model_reasoning_effort="${s.effort}"`,
    "-c", "sandbox_workspace_write.network_access=false", "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    ...(s.model ? ["-m", s.model] : [])];
}

/** Codex must be signed in with ChatGPT (subscription), not an API key: refuse otherwise. */
function checkAuth() {
  if (process.env.CODEX_ASK_SKIP_AUTH) return;
  const r = spawnSync("codex", ["login", "status"], { env: env(), encoding: "utf8" });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") die("the `codex` CLI isn't installed or not on PATH: `npm install -g @openai/codex` (or run /codex:setup), then `codex login`");
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 || !/ChatGPT/i.test(text)) die(`Codex isn't signed in with ChatGPT (\`codex login status\`: ${text.trim() || r.error?.message}). Sign in with ChatGPT: \`codex logout\` if an API key is in use, then \`codex login\`.`);
}

export const codex: Provider = {
  name: "codex", label: "Codex", bin: "codex", keepFirstSession: true, requireScope: false,
  validate() {},
  preflight: checkAuth,
  env,
  argv: (s, a, session) => session
    ? ["exec", "resume", session, ...policy(s), "--skip-git-repo-check", "--json", "-o", a.last, "-"]
    : ["exec", "-C", s.cwd, ...policy(s), "--skip-git-repo-check", "--json", "-o", a.last, "-"],
  prompt(s: State, a: Attempt, kind: Kind) {
    if (kind === "resume") {
      return `Your previous attempt on round ${s.round} was interrupted. Look at what you already wrote (the earlier attempt files ` +
        `${s.round}-attempt-*-reply.md in ${ctx.thread}, and the files you may write) and continue from there; don't redo finished work.` + footer(s, a);
    }
    const request = readFileSync(file(s.round, "request.md"), "utf8");
    if (kind === "follow-up") return `Follow-up round ${s.round}, continuing round ${s.continueFrom} in the same session. The new request:\n\n${request}${footer(s, a)}`;
    return request + footer(s, a);
  },
  sessionIn(events: string) {
    if (!existsSync(events)) return undefined;
    for (const line of readFileSync(events, "utf8").split("\n")) {
      try { const e = JSON.parse(line); if (e.type === "thread.started" && e.thread_id) return e.thread_id as string; } catch {}
    }
    return undefined;
  },
  allowed: (s) => [ctx.thread, ...s.write],
  evidence(s: State, a: Attempt): Evidence {
    const events = readText(a.events);
    const turnDone = /"type":"turn\.completed"/.test(events);
    const turnFailed = /"type":"turn\.failed"/.test(events);
    const last = readText(a.last).trim();
    if (s.sandbox !== "workspace-write" && last) writeFileSync(a.reply, last + "\n");
    const report = readText(a.reply).trim();
    const stderr = readText(a.stderr);
    let interrupt: string | undefined;
    if (/already has an active writer/.test(stderr)) interrupt = "the previous Codex process still holds this session: wait a minute, then resume again";
    else if (a.exitCode !== 0 && a.exitCode != null && /usage limit|rate limit/i.test(stderr)) {
      interrupt = "Codex reported a usage or rate limit: nothing is retried automatically; `resume` after it resets";
    }
    return {
      done: turnDone, failed: turnFailed, report, statusText: last || report, interrupt, blockers: [],
      failNote: `exit ${a.exitCode}${turnFailed ? ", turn failed" : ""}${turnDone ? "" : ", no completed turn"}; see ${basename(a.stderr)}`,
      missingNote: `Codex finished but this attempt's report (${basename(a.reply)}) is missing or empty (last message in ${basename(a.last)})`,
    };
  },
};
