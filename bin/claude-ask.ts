#!/usr/bin/env node
// claude-ask: one round with Claude Code (`claude -p`) on the Claude subscription, for Codex (or any caller) to delegate
// a review or an implementation. Same commands as agent-ask, with --provider claude as the default.
//
//   node bin/claude-ask.ts start  --thread <dir> --round 01 --cwd <worktree> [--mode review|implement|diagnostic|decision]
//                                 [--sandbox read-only|workspace-write --write <path>...] [--model <m>] [--timeout <minutes>]
//   node bin/claude-ask.ts start  --thread <dir> --round 02 --continue-from 01 [--sandbox ...]   (follow-up, same session)
//   node bin/claude-ask.ts status|resume|accept|unlock|cancel --thread <dir> [--round NN] [--json]
//
// Claude's final response is the report (the launcher writes <round>-reply.md), in both sandboxes. Tools: Read/Glob/Grep,
// plus Edit/Write for workspace-write, inside --cwd only; no shell. Details and limits: docs/ROUNDS.md, skills/claude-ask.
import { main } from "./lib/rounds.ts";

await main({ name: "claude-ask", provider: "claude" });
