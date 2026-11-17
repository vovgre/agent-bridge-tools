# Agent Bridge 2.0

Codex can now delegate file edits and reviews to Claude Code through a verified Claude subscription, using the same
durable round workflow as the existing Claude-to-Codex launcher. The calling agent runs tests, checks the diff and
integrates the result. No additional runtime dependencies.

## Changes

- `bin/agent-ask.ts --provider codex|claude` shares lifecycle management between two provider adapters.
- `bin/claude-ask.ts` adds Claude review and implementation rounds; `bin/codex-ask.ts` remains compatible with 1.x
  commands and state files.
- `start --continue-from NN` sends a new request into the same conversation. `resume` retries an interrupted request
  and refuses a changed request file. One session writer per thread.
- `cancel` stops the owned process group, records cancellation and publishes no reply. An orphan can be stopped only
  when process inspection matches its recorded birth identity, command and process group.
- `NN-result.json` and `status --json` expose compact status, blockers, usage and report paths. Full events stay on disk.
- Implementation rounds record a git baseline and detect changed paths outside `--write`. Retries preserve the original
  baseline rather than silently accepting earlier violations.

## Claude permissions and limits

Claude receives Read/Glob/Grep, plus Edit/Write for implementation. No shell, web, MCP tools, or permission bypass.
`--restricted` confines file tools to the working directory. `--write` is an additional post-run detection check,
not an OS sandbox. Ignored files and paths outside the git repository are not covered by that check. Use a dedicated
worktree, and keep the thread outside it or in a subdirectory such as `.agent-bridge`.

The launcher verifies subscription authentication and strips API credentials and provider-routing variables. It
checks required CLI flags before inference. Unknown authentication modes are refused. Subscription quotas still apply;
resume and follow-up preserve conversation state but do not guarantee cache hits or unlimited usage.

The calling agent executes tests and reviews the output. A `complete` status means the protocol checks passed and the
agent reported completion; it is not proof that the implementation is correct. Managed enterprise policy still applies.
Sessions opened manually or through another thread are outside the launcher's session-lock coverage.

## Verification

Verified on macOS with Node 22.23.3 and Claude Code 2.1.326:

- All 61 automated tests passed, with no skips, including the original Codex and headless-browser suites.
- The CI example browser scenario passed both checks (empty state and posting a note).
- Fake-CLI regressions cover authentication rejection, environment cleaning, malformed responses, permission denials,
  usage limits, interrupted recovery, follow-up, concurrent writers, cancellation and scope violations.
- Native subscription-only QA: Claude repaired a disposable JavaScript function and wrote a regression test. The
  calling agent ran the test successfully. A second round added a test in the same Claude session and passed again.
- Native cancellation after session initialization produced `cancelled`, with no published reply.
- Independent review fixes cover failing auth exit codes, strict response validation, a cancellation/publication race,
  stale process identity, thread-folder scope exclusions and scope violations surviving a retry.

Claude implemented the shared runner, adapters, tests and docs. Codex independently reviewed the diff, reproduced the
edge cases above, integrated fixes and executed verification. Native Pro/Team/Enterprise logins, Linux/WSL native
Claude behavior and manual cross-thread session conflicts were not exercised. Accepted alternative plan names have
fake-CLI coverage; CI is configured to run the portable test suite on Linux.

Installation and examples: [README](../README.md#codex-asks-claude-claude-ask). Protocol:
[ROUNDS](ROUNDS.md#the-other-way-codex-asks-claude).
