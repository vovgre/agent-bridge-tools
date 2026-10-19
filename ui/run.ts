#!/usr/bin/env node
// The browser kit's runner: an isolated app instance (fresh data directory, random port, nothing inherited in its
// environment, AI calls trapped), the front end built from the current sources, one headless Chrome that can reach only
// the run's own origins, synthetic setup, then each scenario with its own browser contexts.
//
//   node ui/run.ts --project <name | path> --app <checkout> --scenario a,b | --all
//                  [--artifacts <dir>] [--gif] [--keep] [--no-build]
//                  [--scenario-timeout ms] [--setup-timeout ms] [--ready-timeout ms]
//
// Prints PASS / FAIL per scenario with its artifacts folder; exits 1 when anything failed, 2 on bad arguments. A
// scenario or setup that times out stops the whole run (the server is killed at once, nothing else runs).
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { Browser, findChrome, type Context, type Page } from "./cdp.ts";
import { ensureBuild, fingerprint, type BuildIdentity } from "./build.ts";
import { alive, freePort, killGroup, onExit, ownDir, ownGroup, releaseDir, releaseGroup, removeDir, sleep, supervisorPid, TimeoutError, waitUntil, withTimeout } from "./proc.ts";
import type { Person, Project, RunInfo, ScenarioContext } from "./project.ts";

/** Ports other local instances use (dev servers, live copies): never taken by a test run. `UI_RESERVED_PORTS="5173,8080"`. */
export const RESERVED_PORTS = (process.env.UI_RESERVED_PORTS ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
const KEY_VARS = /^(ANTHROPIC|OPENAI|CODEX|CLAUDE|GEMINI|GOOGLE|AZURE|AWS|MISTRAL|COHERE)_|API_KEY|_TOKEN$|SECRET/i;
const QUIET_MS = 300;
const SETTLE_MAX_MS = 5000;

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);
const num = (name: string, dflt: number) => { const v = opt(name); const n = v === undefined ? dflt : Number(v); return Number.isFinite(n) && n > 0 ? n : die(`--${name} needs a positive number of ms`); };
function die(msg: string): never {
  console.error(`ui/run: ${msg}`);
  process.exit(2);
}

if (process.platform === "win32") die("native Windows isn't supported (process groups, signals): run it inside WSL");
const toolsRoot = resolve(import.meta.dirname, "..");
/** For adapters outside this repo: import runtime helpers from here (`${process.env.AGENT_BRIDGE_TOOLS}/ui/png.ts`). */
process.env.AGENT_BRIDGE_TOOLS = toolsRoot;
const toolsVersion = (() => { try { return JSON.parse(readFileSync(join(toolsRoot, ".claude-plugin", "plugin.json"), "utf8")).version as string; } catch { return null; } })();
const projectArg = opt("project") ?? die("--project <name | path> is required");
const projectDir = /[\\/]/.test(projectArg) ? resolve(projectArg) : join(toolsRoot, "projects", projectArg);
const projectFile = ["index.ts", "index.mts"].map((f) => join(projectDir, f)).find((f) => existsSync(f)) ?? die(`no project at ${join(projectDir, "index.ts")} (or index.mts)`);
const app = resolve(opt("app") ?? die("--app <checkout> is required"));
if (!existsSync(app)) die(`no such checkout: ${app}`);
const project = (await import(pathToFileURL(projectFile).href)).project as Project<unknown>;
const selection = flag("all") ? Object.keys(project.scenarios) : (opt("scenario") ?? die("--scenario a,b or --all")).split(",").map((s) => s.trim()).filter(Boolean);
const wanted = [...new Set(selection)];
if (!wanted.length) die("no scenario selected");
for (const s of wanted) if (!project.scenarios[s]) die(`unknown scenario ${s} (have: ${Object.keys(project.scenarios).join(", ") || "none"})`);
const scenarioTimeout = num("scenario-timeout", 120_000);
const setupTimeout = num("setup-timeout", 60_000);
const readyTimeout = num("ready-timeout", 30_000);
const gif = flag("gif");
const keep = flag("keep");

// A run folder of its own, also when --artifacts points at a folder used before.
const runId = `${project.name}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23)}-${randomBytes(3).toString("hex")}`;
const given = opt("artifacts");
// Default: next to the app (`<app>/.agent-bridge/ui-runs/`, keep `.agent-bridge/` git-ignored), never inside the tools
// (an installed plugin's folder is a cache that updates replace).
const artifacts = resolve(given ? (existsSync(given) && readdirSync(given).length ? join(given, runId) : given) : join(app, ".agent-bridge", "ui-runs", runId));
try { mkdirSync(artifacts, { recursive: true }); } catch (err) { die(`can't create the artifacts folder ${artifacts}: ${(err as Error).message} (pass --artifacts <dir>)`); }
if (!findChrome()) die("no Chrome found: install Google Chrome or Chromium, or set CHROME_BIN");
const runFile = join(artifacts, "run.json");
const runState: Record<string, unknown> = { runnerPid: process.pid, startedAt: new Date().toISOString(), keep, artifacts };
const record = (more: Record<string, unknown>) => {
  Object.assign(runState, more);
  writeFileSync(runFile, JSON.stringify(runState, null, 2));
};

const gitInfo = (dir: string) => {
  const rev = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() || null;
  const dirty = (spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean);
  return { rev, dirty: dirty.length > 0, dirtyFiles: dirty.slice(0, 30) };
};
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !KEY_VARS.test(k))) as Record<string, string>;

project.prepare(app);

// ── the isolated instance ──
const tmp = realpathSync(mkdtempSync(join(tmpdir(), `ui-${project.name}-`)));
if (!keep) ownDir(tmp);
const unhookTmp = onExit(() => { if (!keep) removeDir(tmp); });
const dataDir = join(tmp, "data");
mkdirSync(dataDir);
record({ tmp, dataDir, supervisorPid: supervisorPid() });
if (dataDir.startsWith(realpathSync(app))) die("the data directory must not be inside the checkout");

let failed = false;
let stopped = "";
let phase = "build";
const failures: string[] = [];
const fail = (msg: string) => {
  failed = true;
  failures.push(msg);
  console.log(`FAIL ${msg}`);
};
const results: { scenario: string; ok: boolean; ms: number; error?: string; step?: string; dir: string; notes: string[] }[] = [];

const trapHits: { at: number; line: string }[] = [];
const trap: Server = createServer((req, res) => {
  trapHits.push({ at: Date.now(), line: `${req.method} ${req.url}` });
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ type: "error", error: { type: "ui_kit_trap", message: "AI calls are not allowed in UI tests" } }));
});
await new Promise<void>((r) => trap.listen(0, "127.0.0.1", () => r()));
const trapPort = (trap.address() as { port: number }).port;
const port = await freePort([...RESERVED_PORTS, trapPort]);
const run: RunInfo = { app, dataDir, tmp, port, base: `http://127.0.0.1:${port}`, aiTrap: `http://127.0.0.1:${trapPort}` };

let build: BuildIdentity | null = null;
let browser: Browser | null = null;
let server: ReturnType<typeof spawn> | null = null;
let serverExit: string | null = null;
let serverLog = "";
const spec = project.server(run);
const ready = async () => serverExit === null && (await fetch(`${run.base}${spec.ready}`, { redirect: "manual", signal: AbortSignal.timeout(3000) })).status < 500;
const killServer = () => {
  if (server?.pid) killGroup(server.pid);
};

try {
  if (project.build) {
    build = ensureBuild(app, project.build, { allowBuild: !flag("no-build"), env: cleanEnv(), log: (s) => console.log(s) });
    record({ build });
  }
  phase = "server";
  for (const k of Object.keys(spec.env)) if (KEY_VARS.test(k) && !/_BASE_URL$/.test(k)) throw new Error(`the server environment must not carry ${k}`);
  if (readdirSync(dataDir).length) throw new Error(`data directory not empty: ${dataDir}`);

  const serverLogFile = join(artifacts, "server.log");
  server = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  ownGroup(server.pid);
  const unhookServer = onExit(killServer);
  record({ serverPid: server.pid });
  for (const s of [server.stdout!, server.stderr!])
    s.on("data", (d: Buffer) => {
      serverLog += d.toString();
      appendFileSync(serverLogFile, d);
    });
  server.once("exit", (code, sig) => (serverExit = `server exited (${code ?? sig})`));
  server.once("error", (err) => (serverExit = `server didn't start: ${err.message}`));

  await waitUntil(async () => {
    if (serverExit) throw new Error(`${serverExit}: ${serverLog.slice(-1500)}`);
    return ready();
  }, { timeout: readyTimeout, interval: 150, message: `server not ready at ${run.base}${spec.ready}` });

  phase = "browser";
  browser = await Browser.launch({ logFile: join(artifacts, "chrome.log"), allow: project.allowOrigins?.(run) ?? [run.base] });
  record({ chrome: { version: browser.version, binary: browser.binary, pid: browser.process.pid, profile: browser.profile } });
  const head = gitInfo(app);
  console.log(`${project.name} @ ${head.rev?.slice(0, 7) ?? "?"}${head.dirty ? "+dirty" : ""} · ${browser.version} · node ${process.version} · ${run.base} · artifacts ${artifacts}`);

  phase = "setup";
  const setupStart = Date.now();
  let fixtures: unknown;
  try {
    fixtures = await withTimeout(project.setup(run), setupTimeout, "setup didn't finish");
  } catch (err) {
    if (err instanceof TimeoutError) {
      killServer();
      stopped = "setup timed out";
    }
    throw err;
  }
  writeFileSync(join(artifacts, "setup.txt"), `setup took ${Date.now() - setupStart} ms\n`);

  phase = "scenarios";
  for (const name of wanted) {
    const dir = join(artifacts, name);
    mkdirSync(dir, { recursive: true });
    const r = await runScenario(name, dir, fixtures);
    results.push(r);
    failed ||= !r.ok;
    const rel = relative(process.cwd(), dir).startsWith("..") ? dir : relative(process.cwd(), dir);
    const time = `${(r.ms / 1000).toFixed(1)} s`;
    if (r.ok) console.log(`PASS ${name.padEnd(10)} ${time.padStart(7)}  ${rel}`);
    else console.log(`FAIL ${name.padEnd(10)} ${time.padStart(7)}  ${rel}\n     ${r.error}${r.step ? `\n     (step: ${r.step})` : ""}`);
    for (const n of r.notes) console.log(`     note: ${n}`);
    if (stopped) break;
  }

  phase = "final checks";
  // Before the intentional shutdown: still healthy?
  if (!stopped && !(await ready().catch(() => false))) fail(`server: not healthy at the end of the run${serverExit ? ` (${serverExit})` : ""}`);
  for (const p of project.verify?.(run) ?? []) fail(`verify: ${p}`);
  if (build && project.build && fingerprint(app, project.build.inputs) !== build.inputs) fail("build: the sources changed during the run, so the results don't describe them");
  unhookServer();
} catch (err) {
  fail(`${stopped || phase}: ${(err as Error).message}`);
} finally {
  await browser?.close().catch(() => {});
  if (server?.pid) {
    killGroup(server.pid, "SIGTERM");
    await waitUntil(() => !alive(server!.pid!), { timeout: 3000, interval: 50 }).catch(() => {});
    killGroup(server.pid);
    releaseGroup(server.pid);
  }
  trap.close();
  if (trapHits.length) fail(`ai-trap: the app sent ${trapHits.length} request(s) to the AI provider endpoint: ${trapHits.map((h) => h.line).join(", ")}`);
  if (stopped && !failures.some((f) => f.startsWith(stopped))) fail(`run stopped: ${stopped}`);
  const notRun = wanted.length - results.length;
  if (notRun) failed = true;
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed} passed, ${results.length - passed} failed${notRun ? `, ${notRun} not run` : ""}`);
  writeFileSync(join(artifacts, "summary.json"), JSON.stringify({
    project: project.name, ok: !failed, stopped: stopped || null, failures,
    tools: { version: toolsVersion, ...gitInfo(toolsRoot) }, app: { path: app, ...gitInfo(app) }, build,
    chrome: browser ? { version: browser.version, binary: browser.binary } : null, node: process.version, base: run.base,
    timeouts: { scenario: scenarioTimeout, setup: setupTimeout, ready: readyTimeout },
    results, notRun: wanted.slice(results.length), trapHits, blockedByGate: browser?.gate.blocked ?? [],
  }, null, 2));
  if (keep) console.log(`kept the instance's files: ${tmp}`);
  else {
    removeDir(tmp);
    releaseDir(tmp);
  }
  unhookTmp();
  // Exit now: a timed-out scenario's leftover promises must not get to run.
  process.exit(failed ? 1 : 0);
}

async function runScenario(name: string, dir: string, fixtures: unknown) {
  const started = Date.now();
  const logStart = serverLog.length;
  const trapStart = trapHits.length;
  const contexts: { person: string; context: Context; pages: Page[] }[] = [];
  const notes: string[] = [];
  let lastStep = "";
  let allowAi = false;
  const allowed5xx: RegExp[] = [];
  let shots = 0;
  const steps: string[] = [];
  const step = (label: string) => steps.push(`${String(Date.now() - started).padStart(6)} ms  ${label}`);
  const t: ScenarioContext<unknown> = {
    run,
    fixtures,
    browser: browser!,
    dir,
    async person(personName: string): Promise<Person> {
      const context = await browser!.newContext();
      const entry = { person: personName, context, pages: [] as Page[] };
      contexts.push(entry);
      return {
        name: personName,
        context,
        async open(url = "about:blank") {
          const page = await context.newPage();
          entry.pages.push(page);
          if (gif) page.startRecording(join(dir, "frames", `${personName}-${entry.pages.length}`));
          if (url !== "about:blank") await page.goto(url);
          return page;
        },
      };
    },
    step(label: string) {
      lastStep = label;
      step(label);
    },
    shot(page: Page, label: string) {
      return page.screenshot(join(dir, `${String(++shots).padStart(2, "0")}-${label.replace(/[^\w-]+/g, "-")}.png`));
    },
    check(cond: unknown, message: string) {
      if (!cond) throw new Error(message);
    },
    serverLog: () => serverLog.slice(logStart),
    aiAttempts: () => serverLog.slice(logStart).split("\n").filter((l) => project.aiAttempt.test(l)),
    expectAiRefusal: () => void (allowAi = true),
    expectServerError: (url: RegExp) => void allowed5xx.push(url),
    note: (text: string) => void notes.push(text),
  };
  const pages = () => contexts.flatMap((c) => c.pages.map((p, i) => ({ person: c.person, i, p })));
  /** Everything that makes a finished scenario a failure, as seen so far. */
  const verdict = async (): Promise<string | null> => {
    const bad = pages().flatMap(({ person, p }) =>
      p.events
        .filter((e) => e.kind === "exception" || (e.kind === "crash" && e.level === "error") || (e.kind === "network" && e.level === "error" && !allowed5xx.some((re) => re.test(e.text))))
        .map((e) => `${person}: ${e.text.split("\n")[0]}`),
    );
    if (bad.length) return `page exceptions / crashes / server errors: ${bad.slice(0, 5).join(" | ")}`;
    if (trapHits.length > trapStart) return `AI provider request(s): ${trapHits.slice(trapStart).map((h) => h.line).join(", ")}`;
    const attempts = t.aiAttempts();
    if (attempts.length && !allowAi) return `the app tried to use an AI provider: ${attempts[0].trim()}`;
    if (!(await ready().catch(() => false))) return `the server isn't healthy after the scenario${serverExit ? ` (${serverExit})` : ""}`;
    return null;
  };

  let error: string | undefined;
  try {
    await withTimeout(project.scenarios[name](t), scenarioTimeout, "scenario timed out");
  } catch (err) {
    if (err instanceof TimeoutError) {
      // Stop the run: the scenario's own work is still going and must not change anything more.
      killServer();
      stopped = `${name} timed out after ${scenarioTimeout} ms`;
      error = `${(err as Error).message}: the run stops here (server killed)`;
    } else error = (err as Error).message;
  }
  // The completion boundary: every open page quiet (no request in flight, no event for QUIET_MS), at most SETTLE_MAX_MS.
  if (!stopped) {
    const end = Date.now() + SETTLE_MAX_MS;
    while (!pages().every(({ p }) => p.crashed || (p.inflight.size === 0 && Date.now() - p.lastActivity >= QUIET_MS)) && Date.now() < end) await sleep(50);
    if (Date.now() >= end) {
      const open = pages().flatMap(({ p }) => [...p.inflight].map((id) => p.requests.get(id)?.url ?? id));
      step(`pages not quiet after ${SETTLE_MAX_MS} ms; in flight: ${open.join(", ") || "none"}`);
    }
    error ??= (await verdict()) ?? undefined;
  }
  if (error)
    for (const { person, i, p } of pages())
      if (!p.crashed) await p.screenshot(join(dir, `failure-${person}-${i + 1}.png`)).catch(() => {});
  for (const { person, i, p } of pages())
    if (gif) {
      const made = p.stopRecording(join(dir, `${person}-${i + 1}.gif`));
      if (made) notes.push(`gif: ${made}`);
    }
  for (const c of contexts) await c.context.close().catch(() => {});
  // After teardown: anything that arrived while capturing or closing still counts.
  if (!error && !stopped) error = (await verdict()) ?? undefined;
  for (const { person, i, p } of pages())
    writeFileSync(join(dir, `${person}-${i + 1}.log`), `${p.log()}\n\nrequests:\n${[...p.requests.values()].map((r) => `${r.method} ${r.url} ${r.status ?? r.failed ?? ""}${r.blocked ? " (blocked)" : ""}`).join("\n")}\n`);
  writeFileSync(join(dir, "steps.txt"), steps.join("\n") + "\n");
  writeFileSync(join(dir, "server.log"), serverLog.slice(logStart));
  return { scenario: name, ok: !error, ms: Date.now() - started, error, step: error ? lastStep : undefined, dir, notes };
}
