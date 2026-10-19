// An example adapter: the notes app in examples/notes under the browser kit.
//   node ui/run.ts --project example --app examples/notes --all
// Copy this folder to projects/<your app>/ (or anywhere, and pass its path to --project) and adapt each hook.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../../ui/project.ts";

type Fixtures = { base: string };

export const project: Project<Fixtures> = {
  name: "example",
  prepare(app) {
    if (!existsSync(join(app, "server.mjs"))) throw new Error(`${app} is not the example notes app`);
  },
  // The runner rebuilds dist/ whenever src/ changed since the last build.
  build: { inputs: ["src"], output: "dist", command: [process.execPath, "build.mjs"] },
  // The whole environment: nothing is inherited. Every place the app reads data or settings points into the run.
  server: (run) => ({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: run.app,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: run.tmp, DATA_DIR: run.dataDir, PORT: String(run.port) },
    ready: "/",
  }),
  // Synthetic data once per run, through the app's own HTTP API (nothing here needs it).
  async setup(run) {
    return { base: run.base };
  },
  // This app has no AI; a real one would match its provider-call log lines here.
  aiAttempt: /calling the model/,
  verify(run) {
    return existsSync(join(run.app, "notes.json")) ? ["notes.json was written into the checkout"] : [];
  },
  scenarios: {
    /** Starts empty: the run's data directory is fresh. */
    async empty(t) {
      const page = await (await t.person("ann")).open(`${t.fixtures.base}/`);
      const count = await page.eval(() => document.querySelectorAll("#notes li").length);
      t.check(count === 0, `a fresh run shows ${count} notes`);
    },
    /** Ann adds a note through the real form; Ben, in his own browser context, sees it. */
    async post(t) {
      t.step("Ann adds a note with the keyboard and the Add button");
      const ann = await (await t.person("ann")).open(`${t.fixtures.base}/`);
      await ann.fill("#text", "Buy milk");
      const loaded = ann.waitEvent("Page.loadEventFired");
      await ann.click('button[type="submit"]');
      await loaded;
      await ann.waitFor(() => document.querySelector("#notes li")?.textContent, { message: "the note isn't on Ann's page" });
      await t.shot(ann, "ann-added");

      t.step("Ben opens the page in his own context");
      const ben = await (await t.person("ben")).open(`${t.fixtures.base}/`);
      const shown = await ben.eval(() => [...document.querySelectorAll("#notes li")].map((li) => li.textContent));
      t.check(shown.length === 1 && shown[0] === "Buy milk", `Ben sees ${JSON.stringify(shown)}`);
    },
  },
};
