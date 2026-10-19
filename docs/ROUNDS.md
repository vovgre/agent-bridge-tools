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
node bin/codex-ask.ts resume --thread <dir> --round 03      # only interrupted / failed, the old process gone
node bin/codex-ask.ts accept --thread <dir> --round 03      # Codex finished its turn but the launcher died: read, then accept
node bin/codex-ask.ts unlock --thread <dir> --round 03      # a killed launcher's lock (refused while its owner or Codex lives)
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

## The report (`NN-reply.md`)

Starts with the decision and the number of blocking findings. Findings get stable ids, severity, file:line, trigger,
observed vs expected, evidence, the smallest fix. Say what was reproduced, what is source-only, which screenshots were
read and which browser scenarios actually ran. Implementation replies list the changes, the exact checks, what is left.
Last line of the final message: `STATUS: complete | blocked | partial`.

## After the round

Claude checks the evidence and writes one `decision.md` per topic (recommendation, blocking issues, accepted trade-offs,
next owner). The owner gets one short answer with a link. "We agree" only when both positions really agree; otherwise name the
open point and the evidence that would settle it. A disagreement gets one targeted answer: a reproduction, a small
recomputation, or a source. Business tolerances and policy are the owner's (and their client's), not the agents'.

Resume a session within one coherent task; start fresh for an independent review. Fresh doesn't mean rereading every
archive: send the packet and the relevant evidence.
