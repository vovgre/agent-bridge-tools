// Scope check for implementation attempts: a baseline of the worktree's changed paths (and their content) before the
// attempt, compared after it. Detection only, not containment: it reports what changed outside --write, it never
// resets, stashes or deletes anything. Covers what `git status` sees in the --cwd's repository (tracked edits, edits to
// files that were already dirty, untracked creations, deletions; a rename shows as a deletion plus a creation). Not
// covered: ignored files, other repositories, paths outside the repository, and changes committed during the attempt
// (a moved HEAD is reported instead).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface Entry { code: string; hash: string }
export interface Baseline { top: string; head: string | null; takenAt: string; entries: Record<string, Entry> }
export interface Change { path: string; kind: "created" | "modified" | "deleted" | "reverted"; wasDirty: boolean }
export interface ScopeReport { top: string; headBefore: string | null; headAfter: string | null; changed: Change[]; outside: Change[] }

const git = (cwd: string, args: string[]) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 256 * 1024 * 1024 });

/** An absolute path with symlinks resolved as far as it exists (/tmp vs /private/tmp on macOS). */
export function canon(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    rest.unshift(basename(head));
    head = up;
  }
  try { head = realpathSync(head); } catch {}
  return join(head, ...rest);
}
export const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

export function gitTop(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.status === 0 && r.stdout.trim() ? canon(r.stdout.trim()) : null;
}

function hashOf(abs: string): string {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
    if (st.isDirectory()) return "dir";
    return `${st.mode & 0o777}:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
  } catch { return "-"; }
}

/** null = not a git repository. Throws when git status fails (the caller decides what an unchecked scope means). */
export function snapshot(cwd: string): Baseline | null {
  const top = gitTop(cwd);
  if (!top) return null;
  const head = git(top, ["rev-parse", "--verify", "-q", "HEAD"]);
  const st = git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"]);
  if (st.status !== 0) throw new Error(`git status failed: ${(st.stderr || st.error?.message || "").trim().slice(0, 200)}`);
  const entries: Record<string, Entry> = {};
  for (const rec of st.stdout.split("\0")) {
    if (rec.length < 4) continue;
    const path = rec.slice(3);
    entries[path] = { code: rec.slice(0, 2), hash: hashOf(join(top, path)) };
  }
  return { top, head: head.status === 0 ? head.stdout.trim() : null, takenAt: new Date().toISOString(), entries };
}

/** Every path whose state differs from the baseline, and those outside `allowed` (paths under `ignore` are skipped). */
export function compare(base: Baseline, allowed: string[], ignore: string[]): ScopeReport {
  const after = snapshot(base.top);
  if (!after) throw new Error(`${base.top} is no longer a git repository`);
  const changed: Change[] = [];
  for (const p of [...new Set([...Object.keys(base.entries), ...Object.keys(after.entries)])].sort()) {
    const b = base.entries[p];
    const n = after.entries[p];
    let kind: Change["kind"];
    if (!b && n) kind = n.hash === "-" ? "deleted" : n.code === "??" ? "created" : "modified";
    else if (b && !n) kind = b.code === "??" ? "deleted" : "reverted"; // an untracked file removed, or a dirty file back to HEAD
    else if (b && n && (b.hash !== n.hash || b.code !== n.code)) kind = n.hash === "-" ? "deleted" : b.hash === "-" ? "created" : "modified";
    else continue;
    const abs = join(base.top, p);
    if (ignore.some((i) => inside(abs, i))) continue;
    changed.push({ path: abs, kind, wasDirty: !!b });
  }
  return { top: base.top, headBefore: base.head, headAfter: after.head, changed, outside: changed.filter((c) => !allowed.some((w) => inside(c.path, w))) };
}
