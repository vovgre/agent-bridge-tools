---
name: browser-check
description: Check a web app's flows in a real headless Chrome (real clicks, typing, native form posts, several people at once) on an isolated instance with synthetic data, AI calls and outside network blocked. Use for anything a curl or unit test can't prove (sign-in forms, multi-tab conflicts, uploads, canvas editing, drafts after a crash), and to back up a UI claim before reporting it.
---

# browser-check

`<tools>` below = `${CLAUDE_PLUGIN_ROOT}` (installed as the `agent-bridge` plugin), or the agent-bridge-tools checkout.
Read the "browser kit" part of `<tools>/README.md` once. Quote every path in commands: they often contain spaces.

0. Once per session: macOS / Linux / WSL only; `node --version` 22.18 or newer; Chrome or Chromium installed (or
   `CHROME_BIN` set); the app's `.gitignore` has `.agent-bridge/` (runs are saved in `<app>/.agent-bridge/ui-runs/`).
1. The app needs an adapter: a folder with `index.ts` exporting `project` (`<tools>/ui/project.ts` has the contract).
   Keep it in the app's repo (for example `test/browser/`), never in `<tools>`: an installed plugin's folder is a cache.
   Start from `<tools>/projects/example/index.ts` and the README section "An adapter in your app's repo" (helpers via
   `process.env.AGENT_BRIDGE_TOOLS`; `index.mts` when the app's package.json says `"type": "commonjs"`).
   The adapter's isolation duty: every config / data path at `run.dataDir` / `run.tmp`, outside services at `run.aiTrap`,
   no keys, `allowOrigins` exactly what the browser needs, `verify` for what may not be left behind.
2. Run it (in the background for long suites):
   ```sh
   node "<tools>/ui/run.ts" --project "<app>/test/browser" --app "<app>" --all          # or --scenario a,b
   ```
   `UI_RESERVED_PORTS=5173,8080` keeps the run off ports the user's dev servers use; `--gif` records (needs ffmpeg).
3. The verdict is the exit status (0 = every selected scenario passed) plus `summary.json` in the artifacts folder it
   prints; PASS lines printed during the run are provisional. On a failure read the scenario's `steps.txt`,
   `failure-*.png` and `<person>-*.log` before saying what broke.
4. Report what ran (scenarios, the app's revision and dirty files from `summary.json`) and what wasn't covered.

To see the kit work, run the bundled example on a copy (the plugin folder stays untouched):
```sh
d=$(mktemp -d "${TMPDIR:-/tmp}/agent-bridge-notes.XXXXXX") && cp -R "<tools>/examples/notes" "$d/notes" \
  && node "<tools>/ui/run.ts" --project "<tools>/projects/example" --app "$d/notes" --all
```
