// The runner's failure modes, on the fake app (test/fixtures): each case proves a run can't come back PASS when it
// shouldn't, and that nothing outlives it.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { findChrome } from "../ui/cdp.ts";
import { alive, waitUntil } from "../ui/proc.ts";

const runner = resolve(import.meta.dirname, "../ui/run.ts");
const fakeProject = resolve(import.meta.dirname, "fixtures/fake-project");
const temps: string[] = [];
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
function freshApp(): string {
  const dir = temp("ui-fake-app-");
  cpSync(resolve(import.meta.dirname, "fixtures/fake-app"), dir, { recursive: true });
  return dir;
}
const argv = (app: string, args: string[]) => [runner, "--project", fakeProject, "--app", app, ...args];
function run(app: string, args: string[], env: Record<string, string> = {}) {
  const artifacts = temp("ui-art-");
  const r = spawnSync(process.execPath, argv(app, ["--artifacts", artifacts, ...args]), { env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000 });
  const summaryFile = readdirSync(artifacts).includes("summary.json") ? join(artifacts, "summary.json") : null;
  return { status: r.status, out: `${r.stdout}${r.stderr}`, artifacts, summary: summaryFile ? JSON.parse(readFileSync(summaryFile, "utf8")) : null };
}
function start(app: string, args: string[], env: Record<string, string> = {}) {
  const artifacts = temp("ui-art-");
  const child: ChildProcess = spawn(process.execPath, argv(app, ["--artifacts", artifacts, ...args]), { env: { ...process.env, ...env }, stdio: "ignore" });
  const state = () => {
    try {
      return JSON.parse(readFileSync(join(artifacts, "run.json"), "utf8"));
    } catch {
      return null;
    }
  };
  return { child, artifacts, state };
}
const gone = (what: string, check: () => boolean) => waitUntil(check, { timeout: 15_000, interval: 100, message: `${what} survived` });

test("an empty scenario selection is refused", () => {
  for (const sel of ["", " , ", ","]) {
    const r = spawnSync(process.execPath, argv(freshApp(), ["--scenario", sel]), { encoding: "utf8" });
    assert.equal(r.status, 2, `--scenario "${sel}": ${r.stderr}`);
    assert.match(r.stderr, /no scenario selected|--scenario a,b/);
  }
});

describe("runner (needs Chrome)", { skip: !findChrome() && "no Chrome: set CHROME_BIN" }, () => {
  test("B2: a source edit without a rebuild can't pass; the run records what it tested", () => {
    const app = freshApp();
    const first = run(app, ["--scenario", "ok"]);
    assert.equal(first.status, 0, first.out);
    assert.equal(first.summary.build.built, true);
    assert.ok(first.summary.tools.rev && first.summary.chrome.version.startsWith("Chrome/"), JSON.stringify(first.summary));
    assert.ok("dirty" in first.summary.app && "rev" in first.summary.app);
    writeFileSync(join(app, "src", "index.html"), "<!doctype html><h1>version two</h1>\n");
    const stale = run(app, ["--scenario", "ok", "--no-build"]);
    assert.equal(stale.status, 1, stale.out);
    assert.match(stale.out, /stale build in dist\/ \(the sources changed/);
    assert.equal(stale.summary.results.length, 0);
    const rebuilt = run(app, ["--scenario", "ok"]);
    assert.equal(rebuilt.status, 0, rebuilt.out);
    assert.equal(rebuilt.summary.build.built, true);
    assert.notEqual(rebuilt.summary.build.inputs, first.summary.build.inputs);
    // A build output changed by something else (an old build copied in) is stale too.
    writeFileSync(join(app, "dist", "index.html"), "<!doctype html><h1>version one</h1>\n");
    const tampered = run(app, ["--scenario", "ok", "--no-build"]);
    assert.equal(tampered.status, 1);
    assert.match(tampered.out, /build output was changed/);
    const fresh = run(app, ["--scenario", "ok", "--no-build"]);
    assert.equal(fresh.status, 1, "still stale until rebuilt");
    assert.equal(run(app, ["--scenario", "ok"]).status, 0);
    assert.equal(run(app, ["--scenario", "ok", "--no-build"]).status, 0, "a fresh stamp passes with --no-build");
  });

  test("B4: an unexpected renderer crash fails; a crash the scenario asked for doesn't", () => {
    const app = freshApp();
    const bad = run(app, ["--scenario", "crash"]);
    assert.equal(bad.status, 1, bad.out);
    assert.match(bad.out, /FAIL crash[\s\S]*renderer crashed unexpectedly/);
    const good = run(app, ["--scenario", "expectedCrash"]);
    assert.equal(good.status, 0, good.out);
  });

  test("B4: an exception or a 500 after the scenario returned fails it; so does a server that died", () => {
    const app = freshApp();
    const late = run(app, ["--scenario", "lateException"]);
    assert.equal(late.status, 1, late.out);
    assert.match(late.out, /late boom/);
    const late5 = run(app, ["--scenario", "late5xx"]);
    assert.equal(late5.status, 1, late5.out);
    assert.match(late5.out, /500 GET .*\/500/);
    const dead = run(app, ["--scenario", "serverDies"]);
    assert.equal(dead.status, 1, dead.out);
    assert.match(dead.out, /FAIL serverDies/);
    assert.match(dead.out, /server isn't healthy after the scenario|server exited/);
  });

  test("B3: the browser reaches only the run's origins (sentinel on another loopback port gets nothing)", async () => {
    let hits = 0;
    const sentinel = createServer((_q, s) => (hits++, s.end("sentinel")));
    sentinel.on("upgrade", (_q, sock) => (hits++, sock.destroy()));
    sentinel.on("connect", (_q, sock) => (hits++, sock.destroy()));
    await new Promise<void>((r) => sentinel.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(sentinel.address() as { port: number }).port}`;
    const r = await new Promise<{ status: number | null; out: string }>((resolveRun) => {
      const c = spawn(process.execPath, argv(freshApp(), ["--scenario", "reach", "--artifacts", temp("ui-art-")]), { env: { ...process.env, FAKE_SENTINEL: url } });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("exit", (status) => resolveRun({ status, out }));
    });
    sentinel.close();
    assert.equal(r.status, 0, r.out);
    assert.equal(hits, 0, `the sentinel got ${hits} request(s)`);
    for (const what of ["/img", "/fetch", "fetch-localhost", "/redirected", "/navigate", "example.com"]) assert.ok(r.out.includes(what), `not blocked: ${what}\n${r.out}`);
  });

  test("B5: a timed-out scenario stops the run; its delayed mutation never reaches the server", async () => {
    const mutations = join(temp("ui-mut-"), "log");
    const t0 = Date.now();
    const r = run(freshApp(), ["--scenario", "hang,ok", "--scenario-timeout", "1000"], { FAKE_MUTATIONS: mutations });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /scenario timed out .*the run stops here/);
    assert.match(r.out, /0 passed, 1 failed, 1 not run/);
    assert.equal(r.summary.stopped.startsWith("hang timed out"), true);
    assert.ok(Date.now() - t0 < 30_000);
    await new Promise((res) => setTimeout(res, 3000));
    assert.equal(existsSync(mutations), false, "the timed-out scenario's mutation reached the server");
  });

  test("B5: a hanging setup is cut off", () => {
    const t0 = Date.now();
    const r = run(freshApp(), ["--scenario", "ok", "--setup-timeout", "1000"], { FAKE_SETUP: "hang" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /setup timed out: setup didn't finish \(after 1000 ms\)/);
    assert.ok(Date.now() - t0 < 30_000);
  });

  test("run folders never collide, also with a reused --artifacts", () => {
    const app = freshApp();
    const dir = temp("ui-art-");
    for (let i = 0; i < 2; i++) assert.equal(spawnSync(process.execPath, argv(app, ["--scenario", "ok", "--artifacts", dir]), { encoding: "utf8" }).status, 0);
    const sub = readdirSync(dir).filter((f) => f.startsWith("fake-"));
    assert.equal(sub.length, 1, "the second run went into its own folder");
    assert.ok(existsSync(join(dir, "summary.json")) && existsSync(join(dir, sub[0], "summary.json")));
  });

  describe("B1: SIGKILL of the runner leaves nothing behind", () => {
    test("during startup (server not ready yet, with a grandchild in its group)", async () => {
      const r = start(freshApp(), ["--scenario", "ok"], { FAKE_READY_DELAY: "60000", FAKE_GRANDCHILD: "1" });
      const s = await waitUntil(() => {
        const st = r.state();
        return st?.serverPid && existsSync(join(st.dataDir, "grandchild.pid")) ? st : null;
      }, { timeout: 20_000, message: "the server didn't start" });
      const grandchild = Number(readFileSync(join(s.dataDir, "grandchild.pid"), "utf8"));
      r.child.kill("SIGKILL");
      await gone("the server", () => !alive(s.serverPid));
      await gone("the server's grandchild", () => !alive(grandchild));
      await gone("the run folder", () => !existsSync(s.tmp));
    });

    test("during a scenario", async () => {
      const r = start(freshApp(), ["--scenario", "wait"]);
      const s = await waitUntil(() => {
        const st = r.state();
        return st?.chrome && existsSync(join(st.tmp, "scenario-started")) ? st : null;
      }, { timeout: 30_000, message: "the scenario didn't start" });
      r.child.kill("SIGKILL");
      await gone("Chrome", () => !alive(s.chrome.pid));
      await gone("the server", () => !alive(s.serverPid));
      await gone("Chrome's profile", () => !existsSync(s.chrome.profile));
      await gone("the run folder", () => !existsSync(s.tmp));
    });

    test("after a child (Chrome) already exited", async () => {
      const r = start(freshApp(), ["--scenario", "killChrome"]);
      const s = await waitUntil(() => {
        const st = r.state();
        return st?.chrome && existsSync(join(st.tmp, "chrome-killed")) ? st : null;
      }, { timeout: 30_000, message: "the scenario didn't start" });
      await gone("Chrome", () => !alive(s.chrome.pid));
      r.child.kill("SIGKILL");
      await gone("the server", () => !alive(s.serverPid));
      await gone("Chrome's profile", () => !existsSync(s.chrome.profile));
      await gone("the run folder", () => !existsSync(s.tmp));
    });

    test("--keep keeps the run folder but still kills the processes", async () => {
      const r = start(freshApp(), ["--scenario", "wait", "--keep"]);
      const s = await waitUntil(() => {
        const st = r.state();
        return st?.chrome && existsSync(join(st.tmp, "scenario-started")) ? st : null;
      }, { timeout: 30_000, message: "the scenario didn't start" });
      r.child.kill("SIGKILL");
      await gone("Chrome", () => !alive(s.chrome.pid));
      await gone("the server", () => !alive(s.serverPid));
      await gone("Chrome's profile", () => !existsSync(s.chrome.profile));
      await new Promise((res) => setTimeout(res, 500));
      assert.ok(existsSync(s.dataDir), "--keep: the run folder was removed");
      rmSync(s.tmp, { recursive: true, force: true });
    });
  });
});
