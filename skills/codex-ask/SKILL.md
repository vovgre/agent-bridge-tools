---
name: codex-ask
description: Ask Codex (OpenAI) for an independent review, diagnostic or implementation round through `codex exec`, with the request, Codex's full reply and the decision saved as files. Use when the user says "ask Codex", "let Codex review", "get a second opinion from Codex" and the round needs a record, or when a change touches the numbers the business acts on, saved data, sign-in, security, or an accuracy claim (see docs/ROUNDS.md for when to ask and when not to).
---

# codex-ask

`<tools>` below = `${CLAUDE_PLUGIN_ROOT}` (installed as the `agent-bridge` plugin), or the agent-bridge-tools checkout
this skill is symlinked from. Read `<tools>/docs/ROUNDS.md` once per session: when to ask, the request format, the
report format. Quote every path in commands: they often contain spaces.

**Which tool:** a quick review of the current diff with nothing to keep → `/codex:review` or
`/codex:adversarial-review <focus>` (the `codex` plugin, installed with this one); a quick task handed to Codex →
`/codex:rescue`. Use codex-ask when the round needs a written request packet, a reply that survives a crash, and one
`decision.md` per topic.

0. Once per session, check the setup (macOS / Linux / WSL only):
   - `node --version` is 22.18 or newer (older Node fails with `ERR_UNKNOWN_FILE_EXTENSION`; look for a newer one with
     `which -a node` and put it first on PATH, or ask the user to install it);
   - `codex login status` says "Logged in using ChatGPT" (no `codex`: `npm install -g @openai/codex`; an API-key login:
     ask the user to run `codex logout` and `codex login`; `/codex:setup` accepts API keys, codex-ask doesn't);
   - the project's `.gitignore` has `.agent-bridge/` (add it if not, and tell the user).
1. Pick the thread: `<project>/.agent-bridge/threads/<topic>/`. Next round number = highest + 1.
2. Write `NN-request.md` in the packet format (decision needed, worktree / branch / HEAD, writable paths, constraints,
   what to read, known findings, acceptance, budget). Don't paste whole archives.
3. Start it in the background (it can take 5 to 30 minutes):
   ```sh
   node "<tools>/bin/codex-ask.ts" start --thread "<thread dir>" --round NN --cwd "<worktree>" \
     --mode review --sandbox read-only --notify
   ```
   `--sandbox workspace-write` (+ `--write "<path>"` per extra path) only for implementation rounds.
4. When it ends, read `NN-reply.md` (not the `-last.md` summary). Status `blocked` / `failed` / `interrupted`: read
   `node "<tools>/bin/codex-ask.ts" status --thread "<thread dir>"`; resume an interrupted round with `resume` (it refuses
   while the old Codex process still runs); a killed launcher leaves a lock: `unlock` (it checks the owner), and a
   finished-but-unconfirmed reply: read it, then `accept`. Never start a second writer on the same round.
5. Check Codex's evidence yourself before relaying it: rerun its reproductions, check the diff (and untracked files) of
   a workspace-write round, run `browser-check` for UI claims. Commit for Codex: it can't commit in a linked worktree.
6. Write the outcome into `<thread dir>/decision.md` and give the user one short answer with the link, in their language.

Codex runs on the ChatGPT subscription (the launcher strips API keys). No paid API runs without the user's explicit yes.
