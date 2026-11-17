# A round between Claude and Codex

Worked out together by Claude and Codex. One round = one question, one request file, one report, one decision.
"The owner" below is the person the agents work for.

## When to ask Codex

**Always** (an independent review before integrating or claiming): changes to the numbers the business acts on
(prices, quantities, the rules that compute them); persisted versions, conflicts, drafts (silent data loss); sign-in,
roles, invites; SSRF / origin defenses; destructive data handling; shared client / server contracts; freezing a
consequential eval design or claiming an accuracy gain; a measured prompt / cache contract; whenever the owner asks.

**Short consultation:** two plausible implementations with a real trade-off, one unexplained failure, a diagnostic whose
cheapest falsification is unclear. Ask "check these two assumptions; stop if either fails", not "design everything".

**Don't:** copy / style edits, obvious local fixes with a regression test, formatting, renames, rerunning an
established script, a second opinion that can't change the next action, a full review after every small follow-up.

**Experiments in three steps:** (1) feasibility screen on existing data ($0): is there a reference, is it circular,
can the change move the result at all; (2) decision diagnostic only if the screen survives (frozen mechanism, few
comparisons, a stopping rule, claims sized to the number of independent properties); (3) qualification on independent
data, and a production-faithful paid check only on the owner's explicit yes with a cost estimate. "Don't build it now" needs
less evidence than "it can't work"; an underpowered gate is "inconclusive", never "no effect".

## The request (`NN-request.md`)

```text
Round/topic: checkout-flow/03
Mode: review | implement | diagnostic | decision
Decision needed: can this checkout flow ship after the listed fixes?
Worktree / branch / base HEAD / target HEAD: exact values
Writable paths: exact list (the report path is added by the launcher)
Existing changes: clean, or the dirty files
Constraints: no paid calls, no deploy, prompts and cache keys unchanged
Read first: the source files and the named doc sections that matter (not whole archives)
Known findings: what is already fixed / settled; don't re-audit unrelated code
Acceptance: the reproductions and data / browser invariants that decide it
Budget: one focused pass; checkpoint if it grows
```

Ask for an independent view before showing Claude's preferred answer when independence matters; for verifying a
finding, give the finding and the fix directly.

## Running it

```sh
node bin/codex-ask.ts start --thread <repo>/.agent-bridge/threads/<topic> --round 03 --cwd <worktree> \
  --mode review --sandbox read-only [--write <path>] [--effort high] [--notify]
node bin/codex-ask.ts status --thread <dir>
node bin/codex-ask.ts resume --thread <dir> --round 03      # only interrupted / failed / cancelled, the old process gone
node bin/codex-ask.ts accept --thread <dir> --round 03      # Codex finished its turn but the launcher died: read, then accept
node bin/codex-ask.ts unlock --thread <dir> --round 03      # a killed launcher's lock (refused while its owner or Codex lives)
node bin/codex-ask.ts cancel --thread <dir> --round 03      # stop a running round; nothing is published
node bin/codex-ask.ts start --thread <dir> --round 04 --continue-from 03   # a new request in round 03's session
```

- `read-only` (reviews, diagnostics): Codex's final message is the full report; the launcher saves it to `NN-reply.md`.
- `workspace-write` (implementation): Codex writes `NN-reply.md` itself; `--write` adds the other paths it may change.
  The sandbox doesn't enforce "only these files": check the diff afterwards.
- Codex runs on the ChatGPT subscription: the launcher removes OPENAI_API_KEY / CODEX_API_KEY / ANTHROPIC_API_KEY.
- Per attempt: `NN-attempt-N-events.jsonl`, `-stderr.log`, `-last.md`; `NN-state.json` belongs to the launcher.
  `complete` needs exit 0, a completed turn and that attempt's own report; the final line `STATUS: blocked` → `blocked`,
  `partial` or no STATUS line → `partial`. A lock is never taken over automatically: `unlock` after checking `status`.
- Codex can't commit in a linked worktree or open a browser: Claude commits (after checking the diff, incl. untracked
  files) and runs the browser kit (`ui/`), then sends the results back as evidence.
- `cancel --round 03` stops a running round (below); `status --json` prints the compact result of every round.

## The other way: Codex asks Claude

The same lifecycle runs Claude Code (`claude -p`) on the owner's Claude subscription, so Codex can hand the reading and
editing to Claude and keep its own context for planning, checking and integration. `bin/claude-ask.ts` is
`bin/agent-ask.ts --provider claude`; `bin/codex-ask.ts` is `agent-ask --provider codex` and unchanged for 1.x users.
The provider is saved in `NN-state.json` (state files without one are Codex rounds).

```sh
node bin/claude-ask.ts start --thread <dir> --round 03 --cwd <worktree> --mode review            # Read / Glob / Grep
node bin/claude-ask.ts start --thread <dir> --round 04 --cwd <worktree> --mode implement \
  --sandbox workspace-write --write <worktree>/src --write <worktree>/test                         # + Edit / Write
node bin/claude-ask.ts start --thread <dir> --round 05 --continue-from 04 [--sandbox ... --write ...]  # follow-up
node bin/claude-ask.ts status --thread <dir> [--json]
node bin/claude-ask.ts resume --thread <dir> --round 04      # the same request again after an interruption
node bin/claude-ask.ts cancel --thread <dir> --round 04
node bin/agent-ask.ts start --provider claude ...            # the same, agent-neutral
```

**The report.** In both sandboxes Claude's final response is the report: the launcher writes it to
`NN-attempt-N-reply.md` and publishes it to `NN-reply.md`; Claude never needs write access to the thread. `complete`
needs: exit 0, the `result` event with `subtype: success` and no error, a non-empty final response from this attempt,
the last line `STATUS: complete`, no denied permission request and no change outside `--write`. A denial or an outside
change makes it `partial` with the reason in the note; `STATUS: blocked` stays `blocked`. Claude's own "success" only
says the turn ended: it doesn't prove the work was done or the tests passed. `NN-result.json` (rewritten with every state
change) is the compact view for the calling agent: status, note, blockers, reply path (only when this attempt published
it), session, the attempt's files, the scope summary, usage (turns, tokens, the CLI's notional cost).

**Sign-in: subscription only.** Before any inference the launcher runs `claude --setting-sources '' auth status --json`
with the cleaned environment and refuses unless `loggedIn` is true, `authMethod` is `claude.ai`, `apiProvider` is
`firstParty` and `subscriptionType` is `max`, `pro`, `team` or `enterprise` (Max was verified natively with Claude Code
2.1.326; other accepted names have fake-CLI coverage). The command must exit 0. It prints only those four fields on a
validation error, never the raw output. The
environment loses every `*_API_KEY` and `*_AUTH_TOKEN`, every `ANTHROPIC_*` (base URL, custom headers, models),
`CLAUDE_CODE_USE_*` (Bedrock / Vertex / Foundry), `CLAUDE_CODE_SKIP_*`, `CLAUDE_CODE_OAUTH_*`, `CLAUDE_CODE_API_KEY*`,
AWS / Azure / Cloud SDK credential environment variables and the markers of an outer Claude Code session;
`DISABLE_AUTOUPDATER=1` is set. HOME stays,
so the native login (macOS Keychain or `~/.claude`) works; `--bare` is never used (it turns OAuth off). A login made
only through `CLAUDE_CODE_OAUTH_TOKEN` is therefore refused. Nothing is installed or signed in automatically.

**Permissions, stated in full on every attempt (start, resume and follow-up alike):** `-p --output-format stream-json
--verbose --setting-sources '' --settings '{"disableAllHooks":true,"permissions":{"deny":["Bash","WebFetch","WebSearch"]}}'
--strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --no-chrome --restricted
--permission-mode dontAsk --tools <list> --allowedTools <list>`, with `Read,Glob,Grep` for `read-only` and
`Read,Glob,Grep,Edit,Write` for `workspace-write`. So: no user, project or local settings (no hooks, plugins, API key
helper or MCP servers from them), no shell or code execution even when implementing (Codex runs the tests), no web, file
tools confined to `--cwd`, and anything not pre-approved denied without a prompt (never `bypassPermissions`). The
launcher checks `claude --help` for every one of these flags (and `dontAsk`, `stream-json`) and refuses to start if one
is missing. There is no turn limit flag: the time budget is the runner's (`--timeout`, minutes, default 60 for Claude,
none for Codex), after which the round is stopped and left `interrupted`. Claude accepts `--effort low|medium|high|xhigh|max`
(default high), explicitly passed on every attempt. Managed (enterprise policy) settings still
apply; they can't be switched off from the command line.

**Implementation rounds.** `--sandbox workspace-write` needs at least one `--write`, every `--write` inside `--cwd`, and
`--cwd` inside a git worktree. The thread must be outside the worktree or in a subdirectory such as `.agent-bridge`;
it cannot contain the whole worktree. Before the attempt the launcher saves the changed paths of the repository and their
content (`git status --untracked-files=all` plus a hash per path); after it, it compares: new tracked edits, edits to
files that were already dirty, untracked creations, deletions and renames (a deletion plus a creation) outside `--write`
are listed in `NN-attempt-N-scope.json` and keep the round from `complete`. Retries compare against the round's original
baseline, so a previous scope violation remains until restored; a new round establishes a new baseline. File mode and
status changes are checked too. A moved HEAD is reported too. This is
detection, not containment: nothing is reset, stashed or deleted, ignored files and paths outside the repository aren't
seen, and the thread folder is skipped. A dedicated worktree isolates the work from shared files; it is not an OS
sandbox. The same check runs for Codex `workspace-write` rounds in a git worktree (allowed: the thread and `--write`);
Codex's own sandbox is unchanged.

**Resume versus follow-up.** `resume --round NN` repeats the same request in the round's session after an
interruption, a usage limit, a time budget or a cancel; it refuses a changed request file (start a new round instead).
`start --round MM --continue-from NN` sends a NEW request file into the session of a `complete`, `partial` or `blocked`
round NN, in the same `--cwd` (Claude keeps sessions per working directory), preserving the conversation without the
caller pasting it again. The provider still processes context and it counts toward usage. The
sandbox and `--write` of a follow-up are its own (default read-only): nothing is inherited silently. One writer per
session: while one round of the thread runs in a session, a resume or follow-up of the same session is refused (a
session lock plus a check for live processes). Sessions are bound to their thread: the launcher can't see a session
resumed by hand or from another thread, so don't. Nothing is ever retried automatically: each attempt is one explicit
command, and each counts against the subscription.

**Cancel.** `cancel --round NN` doesn't take the round's lock (the running launcher holds it). It writes
`NN-cancel.json` naming the attempt and its pid; the launcher checks that it matches its own attempt (a request for
another attempt or pid is removed and ignored), sends SIGTERM to the provider's process group and SIGKILL after the grace
period (5 s; `AGENT_ASK_KILL_GRACE_MS`), then records `cancelled` and publishes nothing. If the launcher is gone, cancel
stops the group itself, but only after `ps` confirms the pid is still the provider process that attempt started (start
time, command and process group must match the recorded identity exactly); otherwise it signals nothing. Cancel
controllers are serialized by a separate `NN-cancel-control-lock`; a crashed controller's stale lock can be removed
with `unlock --round NN-cancel-control`. A matching cancellation is checked again before publishing success.
SIGINT / SIGTERM to the launcher stop the provider the same way. A
SIGKILLed launcher can't: its provider keeps running in its own group until `cancel`. `resume` continues a cancelled
round explicitly. Works for Codex rounds too.

**Status and recovery.** A crashed launcher: `status` judges the files (never `complete`; a finished report becomes a
candidate for `accept`). A truncated stream (no `result` event) is `failed`. A usage limit is `interrupted` with the
reset time when Claude names it: `resume` after it. A refused sign-in is `failed` with a pointer to `claude auth login`.
Error text in notes is shortened and anything that looks like a key is removed.

**Tokens and quota.** Claude rounds use the owner's subscription limits; they aren't unlimited and a long implementation
can use a large share of a window. What the orchestrator saves is its own context: it writes a packet and reads a result
and a report instead of every file. Follow-ups preserve Claude's conversation; cache hits and token savings are not
guaranteed. Keep rounds within the user's authorized scope and agreed budget.

## The report (`NN-reply.md`)

Starts with the decision and the number of blocking findings. Findings get stable ids, severity, file:line, trigger,
observed vs expected, evidence, the smallest fix. Say what was reproduced, what is source-only, which screenshots were
read and which browser scenarios actually ran. Implementation replies list the changes, the exact checks, what is left.
Last line of the final message: `STATUS: complete | blocked | partial`.

## After the round

The calling agent checks the evidence and writes one `decision.md` per topic (recommendation, blocking issues, accepted trade-offs,
next owner). The owner gets one short answer with a link. "We agree" only when both positions really agree; otherwise name the
open point and the evidence that would settle it. A disagreement gets one targeted answer: a reproduction, a small
recomputation, or a source. Business tolerances and policy are the owner's (and their client's), not the agents'.

Resume a session within one coherent task; start fresh for an independent review. Fresh doesn't mean rereading every
archive: send the packet and the relevant evidence.
