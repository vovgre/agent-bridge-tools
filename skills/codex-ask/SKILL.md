---
name: codex-ask
description: Ask Codex (OpenAI) for an independent review, diagnostic or implementation round through `codex exec`, without losing its answer. Use when the user says "ask Codex", "let Codex review", "get a second opinion from Codex", or when a change touches the numbers the business acts on, saved data, sign-in, security, or an accuracy claim (see docs/ROUNDS.md for when to ask and when not to).
---

# codex-ask

Tools repo: the `agent-bridge-tools` checkout this skill is symlinked from (`skills/codex-ask`); `<tools>` below.
Read `<tools>/docs/ROUNDS.md` once per session: when to ask, the request format, the report format. Needs Node 22.6+
and the `codex` CLI signed in with ChatGPT.

1. Pick the thread: `<project>/.agent-bridge/threads/<topic>/` (git-ignored). Next round number = highest + 1.
2. Write `NN-request.md` in the packet format (decision needed, worktree / branch / HEAD, writable paths, constraints,
   what to read, known findings, acceptance, budget). Don't paste whole archives.
3. Start it in the background (it can take 5 to 30 minutes):
   ```sh
   node <tools>/bin/codex-ask.ts start --thread <dir> --round NN --cwd <worktree> \
     --mode review --sandbox read-only --notify
   ```
   `--sandbox workspace-write` (+ `--write <path>` per extra path) only for implementation rounds.
4. When it ends, read `NN-reply.md` (not the `-last.md` summary). Status `blocked` / `failed` / `interrupted`: read
   `node <tools>/bin/codex-ask.ts status --thread <dir>`; resume an interrupted round with `resume` (it refuses while the
   old Codex process still runs); a killed launcher leaves a lock: `unlock` (it checks the owner), and a
   finished-but-unconfirmed reply: read it, then `accept`. Never start a second writer on the same round.
5. Check Codex's evidence yourself before relaying it: rerun its reproductions, check the diff (and untracked files) of
   a workspace-write round, run the browser kit for UI claims. Commit for Codex: it can't commit in a linked worktree.
6. Write the outcome into `<thread>/decision.md` and give the user one short answer with the link, in their language.

Codex runs on the ChatGPT subscription (the launcher strips API keys). No paid API runs without the user's explicit yes.
