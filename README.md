# agent-bridge-tools

Tools for running Claude Code and OpenAI Codex on the same project: Claude does the work, Codex reviews it (or the
other way round), and a headless-Chrome kit checks the UI claims in a real browser. One Claude Code plugin installs
all of it, OpenAI's Codex plugin included.

## Install

In Claude Code (2.1.275 or later):

```text
/plugin install agent-bridge --marketplace vovgre/agent-bridge-tools
```

or in two steps: `/plugin marketplace add vovgre/agent-bridge-tools`, then `/plugin install agent-bridge@agent-bridge-tools`.
Then `/reload-plugins` and `/codex:setup` (it checks that the `codex` CLI is installed and signed in with ChatGPT).
Needs Node 22.6+ and, for the browser kit, Chrome.

You get:

| From | What |
| --- | --- |
| [`codex`](https://github.com/openai/codex-plugin-cc) (OpenAI, Apache-2.0; installed as a dependency, pinned to v1.0.6) | `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`, `/codex:result`, the `codex:codex-rescue` agent |
| `agent-bridge` (this repo, MIT) | skill `codex-ask`: a Codex round with a request packet, a reply that survives a crash, and one `decision.md` per topic (`bin/codex-ask.ts`, protocol in `docs/ROUNDS.md`) |
| | skill `browser-check`: real-browser checks of a web app on an isolated instance (`ui/`, example in `projects/example/` + `examples/notes/`) |

Already have `codex@openai-codex`? Uninstall it first (`/plugin uninstall codex@openai-codex`): two copies of the same
plugin can't both run their hooks.

**Which Codex tool when:** a quick review of the diff → `/codex:review`; a design challenge → `/codex:adversarial-review
<focus>`; a task handed off → `/codex:rescue`; a review that has to leave a record (what was asked, Codex's full answer,
what was decided) → ask Claude for a `codex-ask` round.

## Without the plugin

```sh
git clone https://github.com/vovgre/agent-bridge-tools && cd agent-bridge-tools
ln -sfn "$PWD/skills/codex-ask" ~/.claude/skills/codex-ask
ln -sfn "$PWD/skills/browser-check" ~/.claude/skills/browser-check
```

- **A round with Codex:** write `<project>/.agent-bridge/threads/<topic>/01-request.md` (format in `docs/ROUNDS.md`),
  then `node bin/codex-ask.ts start --thread <that dir> --round 01 --cwd <worktree> --mode review --sandbox read-only --notify`,
  then read `01-reply.md`. Add `.agent-bridge/` to the project's `.gitignore`.
- **A real-browser check:** `node ui/run.ts --project example --app examples/notes --all`. For your app, copy
  `projects/example/` into your app's repo and pass its path: `--project <dir>`.

TypeScript runs directly on Node 22.6+, no dependencies. `npm test` runs the launcher tests against a fake `codex` (no
Codex needed) and the browser kit's tests (skipped without Chrome).

## The browser kit (`ui/`)

Real-browser checks of an app's flows, with nothing shared with real data: the runner builds the front end from the
current sources when needed, starts the app on a throwaway data directory and a random loopback port, drives a headless
Chrome over the DevTools protocol (real mouse, keyboard and native form posts), and prints PASS / FAIL per scenario with
its artifacts folder.

```sh
node ui/run.ts --project example --app examples/notes --all
node ui/run.ts --project <name | path> --app <checkout> --scenario login,upload --artifacts /tmp/ui-run --gif
```

Options: `--no-build` (refuse a stale build instead of building), `--keep` (keep the instance's data directory),
`--gif` (needs ffmpeg; never part of pass / fail), `--scenario-timeout` (120 000 ms), `--setup-timeout` (60 000),
`--ready-timeout` (30 000); `--project` takes a name in `projects/` or a path to a project folder.

Exit 0 = every selected scenario ran and passed, 1 = anything else, 2 = bad arguments (an empty selection included).
Artifacts (default `.runs/<project>-<time>-<random>/`, git-ignored; a reused `--artifacts` folder gets a new subfolder):
`run.json` (pids and folders while it runs), `summary.json` (verdict, failures, tools and app revisions with their dirty
files, the build's input / output fingerprints, Chrome version and binary, node, timeouts, results, requests the gate
blocked), `server.log`, `chrome.log`, and per scenario `steps.txt`, numbered screenshots, `failure-<person>-<n>.png`,
`<person>-<n>.log` (console, exceptions, crashes, dialogs, network, every request) and that scenario's server log.

**What a run guarantees**

- **The current front end.** A project's `build` names the inputs and the output; a stamp in the output records the
  inputs' and the output's fingerprints. A missing, stale or hand-changed stamp means build now (`--no-build`: refuse).
  Sources that change during the run fail it.
- **Isolation.** The server's environment is built from scratch (the runner refuses a variable that looks like a key or
  token); the data directory is new, empty and outside the checkout. The browser's only way out is the run's proxy
  (`ui/gate.ts`, loopback included): only the run's origins (`allowOrigins`, default the app's base) are reachable;
  every other local service, the internet, redirect hops to them and WebSockets are refused and listed in the summary.
  Ports in `UI_RESERVED_PORTS` (comma-separated: your dev servers) are never used.
- **AI fails closed.** No key; the provider base URL points at a trap: any request to it fails the scenario and the run;
  a server log line matching the project's `aiAttempt` fails the scenario unless it declares `expectAiRefusal()`; the
  project's `verify` hook checks what may not be left behind (an AI answer cache, files in the checkout).
- **No false PASS.** A scenario ends at a defined boundary: its function returned, then every page is quiet (no request in
  flight, nothing for 300 ms; at most 5 s); then screenshots, logs and teardown; then the verdict is taken again, so
  anything that arrived meanwhile counts. It fails on a failed check, an unhandled page exception, a renderer crash it
  didn't ask for (`page.crash()` marks the expected ones), a 5xx it didn't declare (`expectServerError`), an AI attempt,
  or a server that isn't healthy. The server's health is checked again before the intentional shutdown.
- **Bounded time.** Every CDP command has a timeout; `waitUntil` holds its deadline even when a check hangs; readiness and
  setup are bounded. A scenario or setup that times out stops the run: the server is killed at once, the remaining
  scenarios are reported "not run", and the runner exits so the losing work can't go on.
- **Nothing outlives the run.** Exit hooks clean up on exit, signals and uncaught errors; a detached supervisor
  (`ui/proc.ts`) holds every owned process group (the server's, Chrome's) and folder (the run's, Chrome's profile) and,
  when the runner goes away (SIGKILL included), kills the groups (descendants too, whether or not their leader is still
  there) and then removes the folders. `--keep` keeps the run folder; the processes still go.

**Isolation is also the adapter's job.** A new project must know where its app reads configuration and data and point
all of it at `run.dataDir` / `run.tmp` (never the checkout or a home folder), point every outside service at `run.aiTrap`
(or something equally dead) and give no keys, set `allowOrigins` to exactly the origins the browser needs, and use
`verify` for what the app may not leave behind. An environment object alone doesn't stop an app from reading a
checkout-local settings file.

**The driver (`ui/cdp.ts`)**, usable on its own: `Browser.launch({ allow: [origins] })` (`CHROME_BIN`, else Chrome on
macOS, else `google-chrome` / `chromium` on PATH; `--no-sandbox` only on Linux CI or as root) → `newContext()` (own
cookies and storage: one per person) → `newPage(url)`. A page has `goto`, `reload`, `eval(fn, ...args)`, `waitFor(fn)`
(polls a page function, no fixed sleeps), `click(selector)` (scrolls into view, refuses hidden / disabled / covered
elements, then moves, presses and releases the mouse), `mouseMove` / `mouseDown` / `mouseUp` / `drag`,
`press(key, modifiers)`, `insertText`, `fill`, `setFiles` (`DOM.setFileInputFiles`), `hold(urlPattern)` (holds matching
requests until `release()`: a slow server on demand), `screenshot`, `crash` (`Page.crash`), `startRecording` /
`stopRecording` (screenshots → GIF), `events` / `requests` / `problems()`. `ui/png.ts` makes synthetic PNGs,
`ui/build.ts` the build stamps, `ui/gate.ts` the proxy.

**A project** is `projects/<name>/index.ts` exporting `project` (`ui/project.ts`): `prepare(app)`, `build` (inputs,
output, command), `server(run)` (command, cwd, the whole env, a readiness path), `allowOrigins(run)`, `setup(run)`
(synthetic users / data once per run, through the app's own HTTP API), `aiAttempt`, `verify(run)` and `scenarios`. A
scenario gets `t.person(name)` (a browser context; `open(url)` makes a tab), `t.step`, `t.shot`, `t.check`, `t.note`
(printed with the result), `t.aiAttempts()`, `t.expectAiRefusal()`, `t.expectServerError(url)`.

### Tests

`npm test` runs the driver's tests (`test/ui.test.ts`: input, contexts, the gate against a loopback
sentinel, file inputs, timeouts incl. a hanging check, protocol errors, crash, GIF, Chrome killed when its owner dies)
and the runner's failure modes on a fake app (`test/run.test.ts`, `test/fixtures/`): an empty selection, a stale build
(source edit, hand-changed output), an unexpected crash, a late exception / 500, a dead server, the sentinel, a
timed-out scenario whose delayed mutation must not land, a hanging setup, run-folder collisions, and SIGKILL of the
runner during startup (with a grandchild in the server's group), during a scenario, after Chrome already died, and with
`--keep`. The Chrome-dependent ones are skipped when no Chrome is found.
`.github/workflows/ci.yml` runs `npm test` and the example on every push and pull request.

**In your app's CI:** check out the app and this repo, install the app, then
`node <tools>/ui/run.ts --project <adapter path> --app . --all --artifacts ui-artifacts`, and upload `ui-artifacts/`
when it fails. `ubuntu-latest` has Chrome (`CHROME_BIN=$(command -v google-chrome)`); no model credentials are needed.

### Known limits

- **The gate is the runner's exit status plus its `summary.json`.** Scenario PASS lines are provisional until the final checks finish.
- **Completion is bounded observation.** Pages are quiet for 300 ms (capped at 5 s, a note if hit). Scenarios must await their saves and delayed effects themselves; errors that arrive later, or on unload, are not covered.
- **One checkout at a time.** Use a stable checkout and a separate `--artifacts` folder per concurrent run. Build coverage is only as good as the adapter's declared `build.inputs`.
- **Cleanup covers registered resources only.** The app server, Chrome, the run folder and the profile are covered. The build and GIF subprocesses are not. JavaScript deadlines can't stop synchronous code that blocks the event loop.
- **Not an OS sandbox.** Isolation needs a trusted adapter: backend config and outbound calls are the adapter's duty. HTTPS / WSS allowlisting needs more work, because CONNECT checks an `http://` origin.
- **Not covered:**
  - external fonts are blocked;
  - Chrome is recorded, not pinned;
  - flows that need a live AI answer: the kit refuses every provider call (a recorded-answer stub would be the next step).

## License

MIT, see `LICENSE`.
