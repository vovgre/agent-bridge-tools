---
name: claude-ask
description: Delegate a review, diagnostic or implementation round to Claude Code on the owner's subscription, with durable requests, replies and compact results. Use when Codex or another orchestrator wants Claude to write or review code while it handles planning, verification and integration. Follow-up rounds preserve Claude's conversation.
---

# claude-ask

`<tools>` below = the agent-bridge-tools checkout (or `${CLAUDE_PLUGIN_ROOT}` when installed as the Claude Code plugin).
It is a plain CLI: any agent with a shell can use it. Read `<tools>/docs/ROUNDS.md` once per session (request format,
report format, the rules below in full). Quote every path: they often contain spaces.

0. Once per session, check the setup (macOS / Linux / WSL only):
   - `node --version` is 22.18 or newer;
   - `claude --version` works, and `claude auth status` shows a claude.ai login with a Pro / Max / Team / Enterprise
     plan. If not, ask the owner to install Claude Code or run `claude auth login` themselves: the launcher never installs,
     updates or signs in, and refuses API keys, auth tokens, Bedrock / Vertex and other providers;
   - the project's `.gitignore` has `.agent-bridge/`.
1. Thread: `<project>/.agent-bridge/threads/<topic>/`. Next round number = highest + 1.
2. Write `NN-request.md` in the packet format (decision needed, worktree / branch / HEAD, writable paths, constraints,
   what to read, known findings, acceptance, budget). Give paths, not pasted archives: Claude reads files itself.
3. Start it (5 to 30 minutes; run it in the background if your shell allows, and poll `status`):
   ```sh
   # review / diagnostic: Read, Glob, Grep only
   node "<tools>/bin/claude-ask.ts" start --thread "<thread dir>" --round NN --cwd "<worktree>" --mode review
   # implementation: adds Edit and Write, still no shell; every --write path must be inside --cwd (a git worktree)
   node "<tools>/bin/claude-ask.ts" start --thread "<thread dir>" --round NN --cwd "<worktree>" --mode implement \
     --sandbox workspace-write --write "<worktree>/src" --write "<worktree>/test"
   ```
   Options: `--model <name>`, `--effort low|medium|high|xhigh|max` (default high), `--timeout <minutes>` (default 60,
   `0` = none), `--notify`. `agent-ask.ts --provider claude`
   is the same thing.
4. When it ends: exit 0 = `complete`. Read `NN-result.json` (status, note, blockers, reply path, session, usage) and
   then `NN-reply.md`. `NN-attempt-N-events.jsonl` has every event; `NN-attempt-N-scope.json` lists what changed.
5. Next step, by status:
   - `complete` / `partial` / `blocked`, and you have a NEW question in the same context: write `MM-request.md`, then
     `start --round MM --continue-from NN` (same session, same --cwd; give the sandbox / --write again if it should edit).
   - `interrupted` (crash, usage limit, time budget) or `cancelled`: `resume --round NN` repeats the SAME request in its
     session (refused if the request file changed). Never loop resumes: each one is a paid / quota-counted call; after a
     usage limit wait for the reset the note names.
   - `failed`: read the note and `NN-attempt-N-stderr.log`; fix the cause, then `start` the round again or a new one.
   - Stop a running round: `cancel --round NN` (nothing gets published; `resume` later if wanted).
   - A killed launcher: `status` reconciles; `unlock --round NN` removes its lock (refused while anything lives);
     a finished-but-unconfirmed reply: read it, then `accept`.
6. Check the work yourself before relying on it: Claude has no shell, so YOU run the tests, the build and the browser
   checks, and read the diff (`git status`, untracked files included). A round with changes outside `--write`, or with
   denied permission requests, is never `complete`: the note says what happened. Nothing is ever reverted for you.
7. Write the outcome into `<thread dir>/decision.md`; give the owner one short answer with the link.

**Limits.** The worktree is isolation from shared files, not an OS sandbox: `--restricted` confines Claude's file tools
to `--cwd`, and the scope check after the round only detects (git status before and after) what changed outside
`--write`; ignored files and paths outside the repository aren't seen. One writer per Claude session in a thread (a
second follow-up or resume of the same session is refused while one runs); a session resumed by hand outside the
launcher isn't detected.

**Quota and tokens.** Rounds run on the owner's Claude subscription: they count against its usage limits (which reset
over time and depend on the plan), they are not unlimited, and a limit hit stops the round as `interrupted`. The saving
for the orchestrator is real but bounded: its own tokens go to the request packet, `NN-result.json` and the reply instead
of reading and editing every file. A follow-up preserves Claude's conversation without the caller pasting it again;
the provider still processes context and cache savings are not guaranteed. Keep rounds within the user's authorized
scope and agreed budget.

**Codex discovery.** Codex reads skills from its skills folder (assumed `~/.codex/skills/<name>/SKILL.md`; check your
Codex version's docs): `ln -sfn "<tools>/skills/claude-ask" ~/.codex/skills/claude-ask`. Without skills support, point
to this file from the project's `AGENTS.md` ("for delegating to Claude, follow <tools>/skills/claude-ask/SKILL.md").
