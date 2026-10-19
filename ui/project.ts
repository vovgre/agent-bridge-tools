// What a project (an app under test) gives the runner (ui/run.ts): how to build and start it on a throwaway data
// directory, how to set up synthetic users / data once per run, how to check the run left no trace, and its scenarios.
//
// Isolation is the adapter's job as much as the runner's. The runner gives the server a fresh data directory, an
// environment with nothing inherited, a random port and a browser that can reach only `allowOrigins`. The adapter must
// know where its app reads configuration and data (and point every one of those at `run.dataDir` / `run.tmp`, never
// the checkout or a home folder), how it reaches outside services (point provider base URLs at `run.aiTrap` and give no
// keys), and check in `verify` that nothing was written that shouldn't be (e.g. an AI answer cache).
import type { Browser, Context, Page } from "./cdp.ts";
import type { BuildSpec } from "./build.ts";

export interface RunInfo {
  /** The app checkout under test. */
  app: string;
  /** A fresh, empty data directory for this run only (no production settings, projects or caches). */
  dataDir: string;
  /** Scratch space for this run (generated pictures…), removed afterwards. */
  tmp: string;
  port: number;
  base: string;
  /** A local endpoint that records any AI provider request (and refuses it): point the app's provider base URL here. */
  aiTrap: string;
}

export interface ServerSpec {
  command: string;
  args: string[];
  cwd: string;
  /** The child's whole environment: nothing is inherited, so no API keys can leak in. */
  env: Record<string, string>;
  /** GET path that answers < 500 once the server is ready. */
  ready: string;
}

/** One browser context = one person (own cookies and storage). */
export interface Person {
  name: string;
  context: Context;
  /** A new tab in this person's context, recorded for the GIF when `--gif` is on. */
  open(url?: string): Promise<Page>;
}

export interface ScenarioContext<F> {
  run: RunInfo;
  fixtures: F;
  browser: Browser;
  /** This scenario's artifacts folder. */
  dir: string;
  person(name: string): Promise<Person>;
  /** A labelled step (written to steps.txt with its time; the last one is reported on failure). */
  step(label: string): void;
  /** A screenshot into the artifacts folder. */
  shot(page: Page, label: string): Promise<string>;
  /** Throws `message` unless `cond`. */
  check(cond: unknown, message: string): void;
  /** Server log lines written since this scenario started. */
  serverLog(): string;
  /** Lines in the server log that show the app tried to use an AI provider (refused: no key), since the scenario started. */
  aiAttempts(): string[];
  /** This scenario expects the app to try (and be refused); without it any attempt fails the scenario. */
  expectAiRefusal(): void;
  /** 5xx answers to URLs matching `url` are expected here (any other 5xx fails the scenario). */
  expectServerError(url: RegExp): void;
  /** A note printed with the result (observed behaviour worth knowing, not a failure). */
  note(text: string): void;
}

export type Scenario<F> = (t: ScenarioContext<F>) => Promise<void>;

export interface Project<F> {
  name: string;
  /** Throws a clear message when the checkout isn't this app. */
  prepare(app: string): void;
  /** How the front end is built from which sources: the runner builds when its stamp is stale (ui/build.ts). */
  build?: BuildSpec;
  server(run: RunInfo): ServerSpec;
  /** Origins the browser may reach (default: the app's base only). */
  allowOrigins?(run: RunInfo): string[];
  setup(run: RunInfo): Promise<F>;
  /** Server log lines that mean an AI provider call was attempted. */
  aiAttempt: RegExp;
  /** After the scenarios, before the data directory is removed: problems found (an AI cache written…) fail the run. */
  verify?(run: RunInfo): string[];
  scenarios: Record<string, Scenario<F>>;
}
