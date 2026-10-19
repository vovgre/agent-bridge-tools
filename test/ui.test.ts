import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { Browser, findChrome, makeGif } from "../ui/cdp.ts";
import { alive, freePort, waitUntil } from "../ui/proc.ts";
import { crc32, png } from "../ui/png.ts";

test("png: valid header, CRCs and pixel data", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const p = png(30, 20, [{ x: 5, y: 5, w: 10, h: 2, gray: 0 }]);
  assert.deepEqual([...p.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(p.readUInt32BE(16), 30);
  assert.equal(p.readUInt32BE(20), 20);
  const idatLen = p.readUInt32BE(33);
  assert.equal(p.toString("ascii", 37, 41), "IDAT");
  const raw = inflateSync(p.subarray(41, 41 + idatLen));
  assert.equal(raw.length, 20 * 31);
  assert.equal(raw[5 * 31 + 1 + 5], 0);
  assert.equal(raw[5 * 31 + 1 + 4], 255);
  assert.equal(crc32(p.subarray(37, 41 + idatLen)), p.readUInt32BE(41 + idatLen));
});

test("waitUntil returns the first truthy value and times out with the message", async () => {
  let n = 0;
  assert.equal(await waitUntil(() => (++n >= 3 ? n : 0), { interval: 5 }), 3);
  await assert.rejects(waitUntil(() => false, { timeout: 50, interval: 5, message: "never" }), /never \(after 50 ms/);
  // The deadline holds when a check itself hangs (Codex's B5 reproduction: 25 ms was still pending after 126 ms).
  const t0 = Date.now();
  await assert.rejects(waitUntil(() => new Promise(() => {}), { timeout: 25 }), /after 25 ms/);
  assert.ok(Date.now() - t0 < 100, `took ${Date.now() - t0} ms`);
  const port = await freePort([5176]);
  assert.ok(port > 0 && port !== 5176);
});

const chrome = findChrome();

describe("cdp driver (needs Chrome)", { skip: !chrome && "no Chrome: set CHROME_BIN" }, () => {
  let browser: Browser;
  let server: Server;
  let base = "";
  const PAGE = `<!doctype html><title>t</title>
    <input id="name"><button id="go" onclick="document.getElementById('out').textContent = document.getElementById('name').value">Go</button>
    <p id="out"></p><input id="file" type="file" hidden>
    <script>
      document.getElementById('file').onchange = (e) => document.getElementById('out').textContent = e.target.files[0].name;
      document.addEventListener('keydown', (e) => { if (e.key === 'z' && e.ctrlKey) document.getElementById('out').textContent = 'undo'; });
      let downs = 0; document.addEventListener('pointerdown', (e) => { downs++; document.title = e.pointerType + downs; });
    </script>`;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/redirect?to=")) return res.writeHead(302, { Location: decodeURIComponent(req.url.slice(13)) }).end();
      if (req.url === "/set") res.setHeader("Set-Cookie", "who=a; Path=/");
      res.setHeader("Content-Type", "text/html");
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await Browser.launch({ allow: [base] });
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  test("real clicks, typing, keys and pointer events; console and exceptions are captured", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(`${base}/`);
    await page.click("#name");
    await page.insertText("hello");
    await page.click("#go");
    assert.equal(await page.waitFor(() => document.getElementById("out")!.textContent), "hello");
    assert.match(await page.eval(() => document.title), /^mouse\d+$/);
    await page.press("z", ["Control"]);
    assert.equal(await page.waitFor(() => document.getElementById("out")!.textContent === "undo"), true);
    await page.eval(() => { console.error("bad thing"); setTimeout(() => { throw new Error("boom"); }); });
    await waitUntil(() => page.events.some((e) => e.kind === "exception"));
    assert.ok(page.events.some((e) => e.kind === "console" && e.level === "error" && /bad thing/.test(e.text)));
    assert.ok(page.problems().some((e) => /boom/.test(e.text)));
    await ctx.close();
  });

  test("only allowed origins: a loopback sentinel on another port gets nothing (fetch, image, redirect, WebSocket, navigation)", async () => {
    let hits = 0;
    const sentinel = createServer((_q, s) => (hits++, s.end("sentinel")));
    sentinel.on("upgrade", (_q, sock) => (hits++, sock.destroy()));
    await new Promise<void>((r) => sentinel.listen(0, "127.0.0.1", () => r()));
    const s = `http://127.0.0.1:${(sentinel.address() as { port: number }).port}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage(`${base}/`);
    const statuses = await page.eval(async (url: string, port: string) => {
      new Image().src = `${url}/img`;
      const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
      const wsDone = new Promise((r) => { ws.onerror = () => r("ws refused"); ws.onopen = () => r("ws open"); });
      const st = await Promise.all([fetch(`${url}/a`), fetch(`http://localhost:${port}/b`), fetch(`/redirect?to=${encodeURIComponent(url)}`)].map((p) => p.then((r) => r.status, () => "failed")));
      return [...st, await wsDone];
    }, s, s.split(":").pop()!);
    await page.goto(`${s}/nav`).catch(() => {});
    assert.equal(hits, 0, `sentinel got ${hits} request(s); page saw ${JSON.stringify(statuses)}`);
    assert.ok(statuses.includes("ws refused"), JSON.stringify(statuses));
    assert.ok(browser.gate.blocked.some((b) => b.what.includes("/nav")));
    sentinel.close();
    await ctx.close();
  });

  test("contexts are isolated: cookies and storage", async () => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    const pa = await a.newPage(`${base}/set`);
    const pb = await b.newPage(`${base}/`);
    await pa.eval(() => localStorage.setItem("k", "a"));
    assert.equal(await pb.eval(() => localStorage.getItem("k")), null);
    assert.equal((await a.cookies()).find((c) => c.name === "who")?.value, "a");
    assert.equal((await b.cookies()).length, 0);
    await b.setCookies([{ name: "who", value: "b", url: base }]);
    assert.equal(await pb.eval(() => document.cookie), "who=b");
    await a.close();
    await b.close();
  });

  test("file inputs fire change with the picked file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-test-"));
    const file = join(dir, "plan 850 sq ft.png");
    writeFileSync(file, png(4, 4));
    const ctx = await browser.newContext();
    const page = await ctx.newPage(`${base}/`);
    await page.setFiles("#file", [file]);
    assert.equal(await page.waitFor(() => document.getElementById("out")!.textContent), "plan 850 sq ft.png");
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("commands reject on protocol errors and time out; a hidden or missing element can't be clicked", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(`${base}/`);
    await assert.rejects(page.send("No.suchMethod"), /No.suchMethod/);
    await assert.rejects(page.send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, 200), /no answer within 200 ms/);
    await assert.rejects(page.click("#file", { timeout: 300 }), /not visible/);
    await assert.rejects(page.click("#nothing", { timeout: 300 }), /not found/);
    await assert.rejects(page.waitFor(() => false, { timeout: 200, message: "never true" }), /never true/);
    await ctx.close();
  });

  test("crash() kills the renderer; the page reports it", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(`${base}/`);
    await page.crash();
    assert.equal(page.crashed, true);
    await assert.rejects(page.eval(() => 1), /crashed/);
    await ctx.close();
  });

  test("screenshots, and a GIF when ffmpeg is there", async (t) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(`${base}/`);
    const dir = mkdtempSync(join(tmpdir(), "ui-shot-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const shot = await page.screenshot(join(dir, "a.png"));
    assert.ok(existsSync(shot));
    if (spawnSync("sh", ["-c", "command -v ffmpeg"]).status !== 0) return t.skip("no ffmpeg");
    page.startRecording(join(dir, "frames"), 50);
    await waitUntil(() => spawnSync("ls", [join(dir, "frames")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).length >= 3, { timeout: 5000 });
    assert.ok(page.stopRecording(join(dir, "a.gif")));
    assert.ok(makeGif(join(dir, "nothing"), join(dir, "b.gif")) === null);
    await ctx.close();
  });
});

describe("Chrome never outlives its process (needs Chrome)", { skip: !chrome && "no Chrome: set CHROME_BIN" }, () => {
  const driver = resolve(import.meta.dirname, "../ui/cdp.ts");
  const script = (end: string) => `
    import { Browser } from ${JSON.stringify(driver)};
    const b = await Browser.launch();
    const p = await (await b.newContext()).newPage("about:blank");
    let pending = p.send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, 60000).catch((e) => console.log("REJECTED " + e.message));
    console.log(JSON.stringify({ pid: b.process.pid, profile: b.profile }));
    ${end}`;

  const start = async (end: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script(end)], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    const info = await waitUntil(() => out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find(Boolean), { timeout: 20_000, message: "child didn't launch Chrome" });
    return { child, info: info as { pid: number; profile: string }, out: () => out };
  };

  test("SIGKILL of the owner: the watchdog kills Chrome and removes its profile", async () => {
    const { child, info } = await start("await new Promise(() => {});");
    assert.ok(alive(info.pid));
    child.kill("SIGKILL");
    await waitUntil(() => !alive(info.pid) && !existsSync(info.profile), { timeout: 10_000, message: "Chrome or its profile survived" });
  });

  test("an uncaught error in the owner: Chrome is killed on exit", async () => {
    const { child, info } = await start(`setTimeout(() => { throw new Error("test crash"); }, 100);`);
    await new Promise((r) => child.once("exit", r));
    await waitUntil(() => !alive(info.pid) && !existsSync(info.profile), { timeout: 10_000, message: "Chrome or its profile survived" });
  });

  test("a lost browser rejects the pending command", async () => {
    const { child, info, out } = await start(`setTimeout(() => process.kill(-b.process.pid, "SIGKILL"), 300); await pending; process.exit(0);`);
    await new Promise((r) => child.once("exit", r));
    assert.match(out(), /REJECTED Runtime.evaluate: browser connection (closed|error)/);
    await waitUntil(() => !alive(info.pid), { timeout: 5000 });
  });
});
