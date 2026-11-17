#!/usr/bin/env node
// agent-ask: one round with another coding agent (Codex or Claude Code) that can't lose its answer.
//
//   node bin/agent-ask.ts start  --provider codex|claude --thread <dir> --round 01 --cwd <worktree>
//                                [--mode review|implement|diagnostic|decision] [--sandbox read-only|workspace-write]
//                                [--write <path>]... [--model <m>] [--effort high] [--timeout <minutes>] [--notify]
//   node bin/agent-ask.ts start  --thread <dir> --round 02 --continue-from 01 [...]   (a new request in round 01's session)
//   node bin/agent-ask.ts status --thread <dir> [--json]
//   node bin/agent-ask.ts resume --thread <dir> --round 01       (the same request again, after an interruption)
//   node bin/agent-ask.ts accept --thread <dir> --round 01       (publish a candidate reply after reading it)
//   node bin/agent-ask.ts unlock --thread <dir> --round 01       (remove a stale lock; refuses if its owner lives)
//   node bin/agent-ask.ts cancel --thread <dir> --round 01       (stop a running round; nothing is published)
//
// The provider is recorded in <round>-state.json (state files without one are Codex rounds); every command after start
// reads it from there. Protocol and limits: docs/ROUNDS.md.
import { main } from "./lib/rounds.ts";

await main({ name: "agent-ask" });
