#!/usr/bin/env node
// codex-ask: one round with Codex (`codex exec`) that can't lose its answer.
//
//   node bin/codex-ask.ts start  --thread <dir> --round 01 --cwd <worktree> [--mode review|implement|diagnostic|decision]
//                                [--sandbox read-only|workspace-write] [--effort high] [--model <m>] [--write <path>]... [--notify]
//                                [--continue-from NN] [--timeout <minutes>]
//   node bin/codex-ask.ts status --thread <dir> [--json]
//   node bin/codex-ask.ts resume --thread <dir> --round 01 [--notify]   (interrupted / failed / cancelled rounds, old process gone)
//   node bin/codex-ask.ts accept --thread <dir> --round 01              (publish a candidate reply after reading it)
//   node bin/codex-ask.ts unlock --thread <dir> --round 01              (remove a stale lock; refuses if its owner lives)
//   node bin/codex-ask.ts cancel --thread <dir> --round 01              (stop a running round; nothing is published)
//
// The request is <thread>/<round>-request.md (docs/ROUNDS.md). Per attempt: <round>-attempt-<n>-{events.jsonl,stderr.log,
// last.md,reply.md}. A reply is published to <round>-reply.md only after that attempt is proven finished: exit 0, a
// completed turn, a non-empty report written by that attempt. <round>-state.json belongs to the launcher; every state
// change happens under the round's lock. API keys are removed from Codex's environment (ChatGPT subscription only).
// The same lifecycle runs Claude rounds: bin/claude-ask.ts, or bin/agent-ask.ts --provider claude (bin/lib/).
import { main } from "./lib/rounds.ts";

await main({ name: "codex-ask", provider: "codex" });
