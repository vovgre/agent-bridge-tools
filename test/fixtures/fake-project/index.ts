// A project for the runner's own tests (test/run.test.ts): the fake app plus scenarios that pass, or must fail.
// Switches come from the runner's environment (FAKE_*), set by the test.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../../../ui/proc.ts";
import type { Project, ScenarioContext } from "../../../ui/project.ts";

type T = ScenarioContext<{ base: string }>;
const env = process.env;
const marker = (t: T, name: string) => writeFileSync(join(t.run.tmp, name), String(Date.now()));
const open = async (t: T) => (await t.person("p")).open(`${t.run.base}/`);

export const project: Project<{ base: string }> = {
  name: "fake",
  prepare() {},
  build: { inputs: ["src"], output: "dist", command: [process.execPath, "build.mjs"] },
  server: (run) => ({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: run.app,
    env: {
      PATH: env.PATH ?? "/usr/bin:/bin",
      DATA_DIR: run.dataDir,
      PORT: String(run.port),
      ...(env.FAKE_READY_DELAY ? { FAKE_READY_DELAY: env.FAKE_READY_DELAY } : {}),
      ...(env.FAKE_MUTATIONS ? { FAKE_MUTATIONS: env.FAKE_MUTATIONS } : {}),
      ...(env.FAKE_GRANDCHILD ? { FAKE_GRANDCHILD: "1" } : {}),
    },
    ready: "/",
  }),
  async setup(run) {
    if (env.FAKE_SETUP === "hang") await new Promise(() => {});
    return { base: run.base };
  },
  aiAttempt: /never matches anything/,
  scenarios: {
    /** The page shows the h1 of the current sources (a stale build can't pass). */
    async ok(t) {
      const page = await open(t);
      const want = readFileSync(join(t.run.app, "src", "index.html"), "utf8").match(/<h1>(.*)<\/h1>/)![1];
      const shown = await page.eval(() => document.querySelector("h1")?.textContent);
      t.check(shown === want, `page shows "${shown}", the sources say "${want}"`);
    },
    async expectedCrash(t) {
      await (await open(t)).crash();
    },
    /** A renderer crash nobody asked for. */
    async crash(t) {
      const page = await open(t);
      void page.send("Page.crash").catch(() => {});
      await page.waitEvent("Inspector.targetCrashed");
    },
    /** An exception after the scenario returned. */
    async lateException(t) {
      await (await open(t)).eval(() => void setTimeout(() => { throw new Error("late boom"); }, 150));
    },
    /** A 500 after the scenario returned. */
    async late5xx(t) {
      await (await open(t)).eval(() => void setTimeout(() => fetch("/500"), 150));
    },
    /** The server dies; the scenario itself doesn't notice. */
    async serverDies(t) {
      await open(t);
      await fetch(`${t.run.base}/die`);
    },
    /** Tries every way out of the run's origins; the gate must refuse all of them. */
    async reach(t) {
      const s = env.FAKE_SENTINEL!;
      const page = await open(t);
      await page.eval(async (sentinel: string) => {
        const port = new URL(sentinel).port;
        new Image().src = `${sentinel}/img`;
        const ws = new WebSocket(`${sentinel.replace("http", "ws")}/ws`);
        ws.onerror = () => {};
        await Promise.allSettled([
          fetch(`${sentinel}/fetch`),
          fetch(`http://localhost:${port}/fetch-localhost`),
          fetch(`/redirect?to=${encodeURIComponent(`${sentinel}/redirected`)}`),
          fetch(`https://example.com/`),
        ]);
      }, s);
      const nav = await (await t.person("q")).open();
      await nav.goto(`${s}/navigate`).catch(() => {});
      await sleep(500);
      t.note(`blocked: ${t.browser.gate.blocked.map((b) => b.what).join(" | ")}`);
    },
    /** Times out (with --scenario-timeout); a late mutation must never reach the server. */
    async hang(t) {
      await open(t);
      setTimeout(() => void fetch(`${t.run.base}/mutate`).catch(() => {}), 2500);
      await new Promise(() => {});
    },
    /** Says it started, then waits (the test kills the runner meanwhile). */
    async wait(t) {
      await open(t);
      marker(t, "scenario-started");
      await new Promise(() => {});
    },
    /** Chrome dies first, then the runner is killed (the test does the second part). */
    async killChrome(t) {
      await open(t);
      process.kill(-t.browser.process.pid!, "SIGKILL");
      marker(t, "chrome-killed");
      await new Promise(() => {});
    },
  },
};
