// A run tests the front end built from the current sources, never an older build: the build inputs are fingerprinted,
// a stamp next to the output records the inputs it was built from and the output's own fingerprint, and a missing,
// stale or tampered stamp means build now (or, with --no-build, refuse).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface BuildSpec {
  /** Files and folders (relative to the checkout) the output is made from; missing ones are skipped. */
  inputs: string[];
  /** The output folder (relative to the checkout). */
  output: string;
  /** argv run in the checkout. */
  command: string[];
}

export interface BuildIdentity {
  inputs: string;
  output: string;
  /** True when this run built it. */
  built: boolean;
  ms: number;
}

export const STAMP = ".ui-kit-build.json";
const SKIP = new Set(["node_modules", ".git", STAMP]);

/** sha256 over every file under `paths` (sorted relative paths and contents). */
export function fingerprint(root: string, paths: string[]): string {
  const h = createHash("sha256");
  const walk = (abs: string) => {
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) if (!SKIP.has(name)) walk(join(abs, name));
      return;
    }
    if (!st.isFile()) return;
    h.update(`${relative(root, abs)}\0${st.size}\0`);
    h.update(readFileSync(abs));
    h.update("\0");
  };
  for (const p of [...paths].sort()) walk(join(root, p));
  return h.digest("hex").slice(0, 16);
}

function readStamp(file: string): { inputs?: string; output?: string } {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Builds when the stamp doesn't match the current inputs and output; with `allowBuild: false` throws instead. */
export function ensureBuild(app: string, spec: BuildSpec, opts: { allowBuild: boolean; env: Record<string, string>; log?: (s: string) => void }): BuildIdentity {
  const stampFile = join(app, spec.output, STAMP);
  const inputs = fingerprint(app, spec.inputs);
  const stamp = readStamp(stampFile);
  const output = fingerprint(app, [spec.output]);
  if (stamp.inputs === inputs && stamp.output === output) return { inputs, output, built: false, ms: 0 };
  const why = !stamp.inputs ? "no build stamp" : stamp.inputs !== inputs ? "the sources changed since the last build" : "the build output was changed by hand or by another build";
  if (!opts.allowBuild) throw new Error(`stale build in ${spec.output}/ (${why}); run without --no-build to build it`);
  opts.log?.(`building (${why}): ${spec.command.join(" ")}`);
  const start = Date.now();
  const r = spawnSync(spec.command[0], spec.command.slice(1), { cwd: app, env: opts.env, encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0) throw new Error(`build failed (${r.status ?? r.signal}): ${(r.stderr || r.stdout || String(r.error ?? "")).slice(-1500)}`);
  const after = fingerprint(app, spec.inputs);
  if (after !== inputs) throw new Error("the sources changed while building: run again");
  const built = fingerprint(app, [spec.output]);
  writeFileSync(stampFile, JSON.stringify({ inputs, output: built, at: new Date().toISOString() }, null, 2));
  return { inputs, output: built, built: true, ms: Date.now() - start };
}
