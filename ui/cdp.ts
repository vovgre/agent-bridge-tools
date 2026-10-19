// A small Chrome DevTools Protocol driver: headless Chrome with a throwaway profile on a random loopback port, isolated
// browser contexts ("two people"), real mouse / keyboard input, file inputs, console / exception / network capture,
// screenshots, an optional GIF. Every command times out and rejects on a protocol error or a lost connection.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gate } from "./gate.ts";
import { alive, killGroup, onExit, ownDir, ownGroup, releaseDir, releaseGroup, removeDir, sleep, waitUntil } from "./proc.ts";

export { sleep, waitUntil };

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** CHROME_BIN, else the usual install place on macOS, else the first Chrome / Chromium on PATH. Null = none found. */
export function findChrome(): string | null {
  if (process.env.CHROME_BIN) return existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;
  if (process.platform === "darwin" && existsSync(MAC_CHROME)) return MAC_CHROME;
  for (const name of LINUX_CHROMES) {
    const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

export class CdpError extends Error {
  method?: string;
  constructor(message: string, method?: string) {
    super(message);
    this.method = method;
  }
}

type Listener = (params: any, sessionId?: string) => void;

/** One WebSocket to the browser; page sessions are multiplexed over it (flat sessions). */
class Connection {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }>();
  private listeners = new Map<string, Set<Listener>>();
  closed: Error | null = null;
  readonly timeout: number;

  constructor(ws: WebSocket, timeout: number) {
    this.ws = ws;
    this.timeout = timeout;
    ws.addEventListener("message", (e) => this.receive(String(e.data)));
    ws.addEventListener("close", () => this.fail(new CdpError("browser connection closed")));
    ws.addEventListener("error", () => this.fail(new CdpError("browser connection error")));
  }

  static async open(url: string, timeout: number): Promise<Connection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new CdpError(`can't connect to ${url}`)), timeout);
      ws.addEventListener("open", () => (clearTimeout(t), resolve()), { once: true });
      ws.addEventListener("error", () => (clearTimeout(t), reject(new CdpError(`can't connect to ${url}`))), { once: true });
    });
    return new Connection(ws, timeout);
  }

  private receive(raw: string) {
    const m = JSON.parse(raw);
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new CdpError(`${p.method}: ${m.error.message}${m.error.data ? ` (${m.error.data})` : ""}`, p.method));
      else p.resolve(m.result);
      return;
    }
    for (const key of [m.method, `${m.sessionId ?? ""}:${m.method}`])
      for (const fn of this.listeners.get(key) ?? []) {
        try { fn(m.params, m.sessionId); } catch {}
      }
  }

  private fail(err: Error) {
    if (this.closed) return;
    this.closed = err;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError(`${p.method}: ${err.message}`, p.method));
    }
    this.pending.clear();
    for (const fn of this.listeners.get("disconnected") ?? []) fn({});
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string, timeout = this.timeout): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(`${method}: ${this.closed.message}`, method));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method}: no answer within ${timeout} ms`, method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** `event` = "Domain.event" (any session) or "<sessionId>:Domain.event"; "disconnected" fires once on a lost connection. */
  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

export interface LaunchOptions {
  /** Defaults to findChrome(). */
  chrome?: string;
  /** Per-command timeout in ms (default 15 000). */
  timeout?: number;
  width?: number;
  height?: number;
  /**
   * The only origins the browser may reach ("http://127.0.0.1:5199"); more with `browser.gate.allow()`. Everything goes
   * through the run's proxy (`ui/gate.ts`), loopback included: other local services and the internet are refused.
   */
  allow?: string[];
  /** Where Chrome's own stderr goes (default: kept in memory, last 8 KB). */
  logFile?: string;
  args?: string[];
}

export interface PageEvent {
  at: number;
  kind: "console" | "exception" | "network" | "dialog" | "log" | "crash";
  level: "info" | "warning" | "error";
  text: string;
}

export interface RequestRecord {
  id: string;
  method: string;
  url: string;
  status?: number;
  failed?: string;
  blocked?: boolean;
}

/** A launched Chrome. `close()` (or the end of the process, whatever ends it) kills it and removes its profile. */
export class Browser {
  readonly contexts = new Set<Context>();
  readonly conn: Connection;
  readonly process: ChildProcess;
  readonly profile: string;
  readonly version: string;
  readonly options: Required<Pick<LaunchOptions, "width" | "height" | "timeout">>;
  readonly gate: Gate;
  readonly binary: string;
  private unhook: () => void;

  private constructor(conn: Connection, child: ChildProcess, profile: string, version: string, options: Browser["options"], unhook: () => void, gate: Gate, binary: string) {
    this.gate = gate;
    this.binary = binary;
    this.conn = conn;
    this.process = child;
    this.profile = profile;
    this.version = version;
    this.options = options;
    this.unhook = unhook;
  }

  static async launch(opts: LaunchOptions = {}): Promise<Browser> {
    const chrome = opts.chrome ?? findChrome();
    if (!chrome) throw new Error("No Chrome found: set CHROME_BIN");
    const timeout = opts.timeout ?? 15_000;
    const width = opts.width ?? 1440;
    const height = opts.height ?? 900;
    const profile = mkdtempSync(join(tmpdir(), "ui-chrome-"));
    ownDir(profile);
    const gate = new Gate(opts.allow ?? []);
    const gatePort = await gate.listen();
    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-default-apps",
      "--metrics-recording-only",
      "--password-store=basic",
      "--use-mock-keychain",
      "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
      `--proxy-server=http://127.0.0.1:${gatePort}`,
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      ...(process.platform === "linux" && (process.env.CI || process.getuid?.() === 0) ? ["--no-sandbox"] : []),
      ...(opts.args ?? []),
      "about:blank",
    ];
    const child = spawn(chrome, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8192);
      if (opts.logFile) try { writeFileSync(opts.logFile, d, { flag: "a" }); } catch {}
    });
    ownGroup(child.pid);
    const unhook = onExit(() => {
      killGroup(child.pid);
      removeDir(profile);
    });
    let exited: string | null = null;
    child.once("exit", (code, sig) => (exited = `Chrome exited (${code ?? sig}): ${stderr.slice(-800)}`));
    child.once("error", (err) => (exited = `Chrome didn't start: ${err.message}`));
    try {
      const portFile = join(profile, "DevToolsActivePort");
      const [port, path] = await waitUntil(() => {
        if (exited) throw new Error(exited);
        const lines = existsSync(portFile) ? readFileSync(portFile, "utf8").split("\n") : [];
        return lines.length >= 2 && lines[1] ? lines : null;
      }, { timeout: 20_000, interval: 50, message: "Chrome didn't open its debugging port" });
      const conn = await Connection.open(`ws://127.0.0.1:${port}${path}`, timeout);
      const v = await conn.send("Browser.getVersion");
      const b = new Browser(conn, child, profile, v.product, { width, height, timeout }, unhook, gate, chrome);
      await conn.send("Target.setDiscoverTargets", { discover: true });
      return b;
    } catch (err) {
      unhook();
      killGroup(child.pid);
      removeDir(profile);
      gate.close();
      throw err;
    }
  }

  /** An isolated context (own cookies, storage, cache): one per person. */
  async newContext(): Promise<Context> {
    const { browserContextId } = await this.conn.send("Target.createBrowserContext", { disposeOnDetach: true });
    const c = new Context(this, browserContextId);
    this.contexts.add(c);
    return c;
  }

  pages(): Page[] {
    return [...this.contexts].flatMap((c) => [...c.pages]);
  }

  async close() {
    for (const c of this.contexts) await c.close().catch(() => {});
    await this.conn.send("Browser.close", {}, undefined, 3000).catch(() => {});
    this.conn.close();
    await waitUntil(() => !this.process.pid || !alive(this.process.pid), { timeout: 3000, interval: 50 }).catch(() => {});
    killGroup(this.process.pid);
    removeDir(this.profile);
    this.gate.close();
    this.unhook();
    releaseGroup(this.process.pid);
    releaseDir(this.profile);
  }
}

export interface CookieParam {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export class Context {
  readonly pages = new Set<Page>();
  readonly browser: Browser;
  readonly id: string;

  constructor(browser: Browser, id: string) {
    this.browser = browser;
    this.id = id;
  }

  async newPage(url = "about:blank"): Promise<Page> {
    const conn = this.browser.conn;
    const { targetId } = await conn.send("Target.createTarget", { url: "about:blank", browserContextId: this.id });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init();
    this.pages.add(page);
    if (url !== "about:blank") await page.goto(url);
    return page;
  }

  setCookies(cookies: CookieParam[]) {
    return this.browser.conn.send("Storage.setCookies", { cookies, browserContextId: this.id });
  }

  async cookies(): Promise<{ name: string; value: string; domain: string }[]> {
    return (await this.browser.conn.send("Storage.getCookies", { browserContextId: this.id })).cookies;
  }

  async close() {
    for (const p of this.pages) await p.close().catch(() => {});
    await this.browser.conn.send("Target.disposeBrowserContext", { browserContextId: this.id }).catch(() => {});
    this.browser.contexts.delete(this);
  }
}

type Modifier = "Alt" | "Control" | "Meta" | "Shift";
const MODIFIER_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  " ": { code: "Space", keyCode: 32, text: " " },
  Shift: { code: "ShiftLeft", keyCode: 16 },
  Alt: { code: "AltLeft", keyCode: 18 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Meta: { code: "MetaLeft", keyCode: 91 },
};
function keyInfo(key: string) {
  if (KEYS[key]) return KEYS[key];
  if (/^[a-z]$/i.test(key)) return { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  throw new Error(`unknown key ${key}`);
}

/** `fn` runs in the page: it must not use anything from the test's scope except its JSON-serialisable `args`. */
type PageFn<A extends unknown[], R> = (...args: A) => R | Promise<R>;

export class Page {
  readonly events: PageEvent[] = [];
  readonly requests = new Map<string, RequestRecord>();
  crashed = false;
  /** Set by `crash()`: a crash the test asked for. Any other renderer crash is an error event. */
  crashExpected = false;
  /** Requests started and not finished yet, and when anything last happened (the runner's quiet-period check). */
  readonly inflight = new Set<string>();
  lastActivity = Date.now();
  private mouse = { x: 0, y: 0, buttons: 0 };
  private off: (() => void)[] = [];
  private recording: { timer: NodeJS.Timeout; dir: string; n: number } | null = null;
  readonly context: Context;
  readonly targetId: string;
  readonly sessionId: string;

  constructor(context: Context, targetId: string, sessionId: string) {
    this.context = context;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  get conn() {
    return this.context.browser.conn;
  }

  send<T = any>(method: string, params: object = {}, timeout?: number): Promise<T> {
    if (this.crashed && !method.startsWith("Target.")) return Promise.reject(new CdpError(`${method}: the page crashed`, method));
    return this.conn.send<T>(method, params, this.sessionId, timeout);
  }

  on(event: string, fn: Listener): () => void {
    const off = this.conn.on(`${this.sessionId}:${event}`, fn);
    this.off.push(off);
    return off;
  }

  private note(kind: PageEvent["kind"], level: PageEvent["level"], text: string) {
    this.events.push({ at: Date.now(), kind, level, text });
    this.lastActivity = Date.now();
  }

  async init() {
    this.on("Runtime.consoleAPICalled", (p) => {
      const text = p.args.map((a: any) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.type)).join(" ");
      this.note("console", p.type === "error" || p.type === "assert" ? "error" : p.type === "warning" ? "warning" : "info", `${p.type}: ${text}`);
    });
    this.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails;
      this.note("exception", "error", `${d.exception?.description ?? d.text}${d.url ? ` (${d.url}:${d.lineNumber})` : ""}`);
    });
    this.on("Log.entryAdded", (p) => this.note("log", p.entry.level === "error" ? "warning" : "info", `${p.entry.source}: ${p.entry.text}${p.entry.url ? ` ${p.entry.url}` : ""}`));
    this.on("Network.requestWillBeSent", (p) => {
      // A redirect reuses the request id: the hop that was redirected is kept under its own key with its status.
      const prev = this.requests.get(p.requestId);
      if (p.redirectResponse && prev) this.requests.set(`${p.requestId}#${this.requests.size}`, { ...prev, status: p.redirectResponse.status });
      this.requests.set(p.requestId, { id: p.requestId, method: p.request.method, url: p.request.url });
      this.inflight.add(p.requestId);
      this.lastActivity = Date.now();
    });
    this.on("Page.frameNavigated", (p) => {
      if (!p.frame.parentId) this.inflight.clear(); // the old document's requests are gone with it
    });
    this.on("Network.loadingFinished", (p) => {
      this.inflight.delete(p.requestId);
      this.lastActivity = Date.now();
    });
    this.on("Network.responseReceived", (p) => {
      const r = this.requests.get(p.requestId);
      if (r) r.status = p.response.status;
      // Answered = settled for the quiet-period check (a body nobody reads may never "finish").
      this.inflight.delete(p.requestId);
      this.lastActivity = Date.now();
      const h = p.response.headers ?? {};
      if (h["X-UI-Kit"] === "blocked" || h["x-ui-kit"] === "blocked") {
        if (r) r.blocked = true;
        this.note("network", "info", `blocked (not a run origin): ${r?.method ?? ""} ${p.response.url}`);
      } else if (p.response.status >= 500) this.note("network", "error", `${p.response.status} ${r?.method ?? ""} ${p.response.url}`);
      else if (p.response.status >= 400) this.note("network", "info", `${p.response.status} ${r?.method ?? ""} ${p.response.url}`);
    });
    this.on("Network.loadingFailed", (p) => {
      this.inflight.delete(p.requestId);
      const r = this.requests.get(p.requestId);
      if (r) r.failed = p.errorText;
      if (r && !this.context.browser.gate.isAllowed(r.url)) r.blocked = true;
      this.note("network", p.canceled || r?.blocked ? "info" : "warning", `${p.canceled ? "canceled" : r?.blocked ? "blocked (not a run origin)" : "failed"}: ${p.errorText} ${r?.method ?? ""} ${r?.url ?? p.requestId}`);
    });
    this.on("Page.javascriptDialogOpening", (p) => {
      this.note("dialog", "info", `${p.type}: ${p.message}`);
      void this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    });
    this.on("Inspector.targetCrashed", () => {
      this.crashed = true;
      this.note("crash", this.crashExpected ? "info" : "error", this.crashExpected ? "the page crashed (asked for)" : "the renderer crashed unexpectedly");
    });
    const { width, height } = this.context.browser.options;
    await Promise.all([
      this.send("Page.enable"),
      this.send("Runtime.enable"),
      this.send("Network.enable"),
      this.send("Log.enable"),
      this.send("Inspector.enable"),
      this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }),
    ]);
  }

  /** Navigates and waits for the load event (a same-document change, e.g. only the #hash, resolves at once). */
  async goto(url: string, timeout = this.conn.timeout) {
    const loaded = this.nextEvent("Page.loadEventFired", timeout);
    try {
      const r = await this.send("Page.navigate", { url });
      if (r.errorText) throw new CdpError(`navigate ${url}: ${r.errorText}`);
      if (r.loaderId) await loaded.promise;
    } finally {
      loaded.cancel();
    }
  }

  async reload(timeout = this.conn.timeout) {
    const loaded = this.nextEvent("Page.loadEventFired", timeout);
    try {
      await this.send("Page.reload", { ignoreCache: false });
      await loaded.promise;
    } finally {
      loaded.cancel();
    }
  }

  /** The next `event` on this page; rejects after `timeout` or when the connection is lost. */
  waitEvent<T = any>(event: string, timeout = this.conn.timeout): Promise<T> {
    return this.nextEvent<T>(event, timeout).promise;
  }

  private nextEvent<T>(event: string, timeout: number): { promise: Promise<T>; cancel: () => void } {
    let cancel = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        off();
        offLost();
        fn();
      };
      const t = setTimeout(() => done(() => reject(new CdpError(`${event}: not within ${timeout} ms`))), timeout);
      const off = this.on(event, (p) => done(() => resolve(p)));
      const offLost = this.conn.on("disconnected", () => done(() => reject(new CdpError(`${event}: browser connection closed`))));
      cancel = () => done(() => resolve(undefined as T));
    });
    return { promise, cancel };
  }

  /** Evaluates `fn(...args)` in the page (awaits promises) and returns its JSON value. Page errors reject. */
  async eval<A extends unknown[], R>(fn: PageFn<A, R> | string, ...args: A): Promise<R> {
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})(...${JSON.stringify(args)})`;
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as R;
  }

  /** Re-evaluates `fn` in the page until it returns something truthy, and returns that. No fixed sleeps. */
  waitFor<A extends unknown[], R>(fn: PageFn<A, R> | string, opts: { timeout?: number; interval?: number; message?: string } = {}, ...args: A): Promise<NonNullable<R>> {
    return waitUntil(() => {
      if (this.conn.closed) throw new Error(`browser connection closed`);
      return this.eval(fn, ...args);
    }, { timeout: opts.timeout ?? 10_000, interval: opts.interval ?? 100, message: opts.message ?? `waitFor ${typeof fn === "string" ? fn : fn.toString().slice(0, 120)}` });
  }

  /** The visible centre of `selector` (scrolled into view); throws when it is missing, hidden or disabled. */
  async center(selector: string): Promise<{ x: number; y: number }> {
    const r = await this.eval((sel: string) => {
      const e = document.querySelector(sel) as HTMLElement | null;
      if (!e) return { error: "not found" };
      e.scrollIntoView({ block: "center", inline: "center" });
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(e).visibility === "hidden") return { error: "not visible" };
      if ((e as HTMLButtonElement).disabled) return { error: "disabled" };
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== e && !e.contains(hit)) return { error: `covered by <${hit.tagName.toLowerCase()} id="${hit.id}" class="${hit.className}">` };
      return { x, y };
    }, selector);
    if ("error" in r) throw new Error(`${selector}: ${r.error}`);
    return r as { x: number; y: number };
  }

  /** A real click (mouse moved there, pressed, released) on the element's visible centre. */
  async click(selector: string, opts: { timeout?: number } = {}) {
    const p = await waitUntil(() => this.center(selector), { timeout: opts.timeout ?? 5000, message: `click ${selector}` });
    await this.clickAt(p.x, p.y);
  }

  async mouseMove(x: number, y: number, opts: { steps?: number; modifiers?: Modifier[] } = {}) {
    const steps = opts.steps ?? 1;
    const { x: x0, y: y0 } = this.mouse;
    for (let i = 1; i <= steps; i++) {
      const px = x0 + ((x - x0) * i) / steps;
      const py = y0 + ((y - y0) * i) / steps;
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, buttons: this.mouse.buttons, button: this.mouse.buttons ? "left" : "none", pointerType: "mouse", modifiers: bits(opts.modifiers) });
    }
    this.mouse.x = x;
    this.mouse.y = y;
  }

  async mouseDown(opts: { modifiers?: Modifier[]; clickCount?: number } = {}) {
    this.mouse.buttons = 1;
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: this.mouse.x, y: this.mouse.y, button: "left", buttons: 1, clickCount: opts.clickCount ?? 1, pointerType: "mouse", modifiers: bits(opts.modifiers) });
  }

  async mouseUp(opts: { modifiers?: Modifier[]; clickCount?: number } = {}) {
    this.mouse.buttons = 0;
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: this.mouse.x, y: this.mouse.y, button: "left", buttons: 0, clickCount: opts.clickCount ?? 1, pointerType: "mouse", modifiers: bits(opts.modifiers) });
  }

  async clickAt(x: number, y: number, opts: { modifiers?: Modifier[] } = {}) {
    await this.mouseMove(x, y, opts);
    await this.mouseDown(opts);
    await this.mouseUp(opts);
  }

  async drag(x0: number, y0: number, x1: number, y1: number, steps = 10) {
    await this.mouseMove(x0, y0);
    await this.mouseDown();
    await this.mouseMove(x1, y1, { steps });
    await this.mouseUp();
  }

  /** A key press (keyDown + keyUp) with modifiers, e.g. press("z", ["Control"]). */
  async press(key: string, modifiers: Modifier[] = []) {
    const k = keyInfo(key);
    const text = modifiers.some((m) => m !== "Shift") ? undefined : k.text && (modifiers.includes("Shift") ? k.text.toUpperCase() : k.text);
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: bits(modifiers) };
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: k.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Text as typed into the focused element (an IME-style insert: input events fire, no key events). */
  insertText(text: string) {
    return this.send("Input.insertText", { text });
  }

  /** Focus `selector`, select what's in it, type `text` over it. */
  async fill(selector: string, text: string) {
    await this.click(selector);
    await this.eval((sel: string) => {
      const e = document.querySelector(sel) as HTMLInputElement;
      e.focus();
      e.select?.();
    }, selector);
    if (text) await this.insertText(text);
    else await this.press("Backspace");
  }

  /** Puts files into an <input type=file> (hidden ones too) as if picked in the file dialog; `change` fires. */
  async setFiles(selector: string, files: string[]) {
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`${selector}: not found`);
    await this.send("DOM.setFileInputFiles", { nodeId, files });
  }

  async screenshot(file: string, format: "png" | "jpeg" = "png") {
    const r = await this.send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 70 } : {}) }, 10_000);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }

  /** Kills the renderer (as a crash would): no unload handlers, no last save. */
  async crash() {
    this.crashExpected = true;
    const crashed = this.nextEvent("Inspector.targetCrashed", 10_000);
    void this.send("Page.crash").catch(() => {});
    try {
      await crashed.promise;
    } finally {
      crashed.cancel();
    }
    this.crashed = true;
  }

  /**
   * Holds back this page's requests matching `urlPattern` (CDP wildcards: * and ?) until `release()`: a slow server on
   * demand (e.g. a plan that is still loading while the person switches to another one).
   */
  async hold(urlPattern: string): Promise<{ held: () => number; release: () => Promise<void> }> {
    const paused: string[] = [];
    const off = this.on("Fetch.requestPaused", (p) => paused.push(p.requestId));
    await this.send("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Request" }] });
    return {
      held: () => paused.length,
      release: async () => {
        off();
        for (const id of paused) await this.send("Fetch.continueRequest", { requestId: id }).catch(() => {});
        await this.send("Fetch.disable").catch(() => {});
      },
    };
  }

  /** Screenshots every `interval` ms into `dir` until `stopRecording` (for a GIF; never part of pass / fail). */
  startRecording(dir: string, interval = 250) {
    if (this.recording) return;
    mkdirSync(dir, { recursive: true });
    const rec = { timer: null as unknown as NodeJS.Timeout, dir, n: 0 };
    let busy = false;
    rec.timer = setInterval(() => {
      if (busy || this.crashed || this.conn.closed) return;
      busy = true;
      this.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, 5000)
        .then((r) => writeFileSync(join(dir, `${String(++rec.n).padStart(5, "0")}.jpg`), Buffer.from(r.data, "base64")))
        .catch(() => {})
        .finally(() => (busy = false));
    }, interval);
    this.recording = rec;
  }

  /** Stops recording; with ffmpeg on PATH writes `gif` and returns its path, else null. Errors are swallowed. */
  stopRecording(gif?: string, fps = 4): string | null {
    const rec = this.recording;
    if (!rec) return null;
    clearInterval(rec.timer);
    this.recording = null;
    const made = gif ? makeGif(rec.dir, gif, fps) : null;
    if (made) removeDir(rec.dir);
    return made;
  }

  /** Exceptions, console errors and 5xx responses seen so far (the things a scenario should fail on). */
  problems(): PageEvent[] {
    return this.events.filter((e) => e.level === "error");
  }

  log(): string {
    return this.events.map((e) => `${new Date(e.at).toISOString().slice(11, 23)} ${e.level.padEnd(7)} ${e.kind.padEnd(9)} ${e.text}`).join("\n");
  }

  async close() {
    if (this.recording) clearInterval(this.recording.timer);
    this.off.forEach((f) => f());
    this.context.pages.delete(this);
    await this.conn.send("Target.closeTarget", { targetId: this.targetId }, undefined, 5000).catch(() => {});
  }
}

const bits = (mods: Modifier[] = []) => mods.reduce((s, m) => s | MODIFIER_BITS[m], 0);

/** JPEG / PNG frames in `dir` (sorted by name) → an animated GIF via ffmpeg. Null when ffmpeg is missing or fails. */
export function makeGif(dir: string, out: string, fps = 4): string | null {
  try {
    const frames = readdirSync(dir).filter((f) => /\.(jpe?g|png)$/.test(f)).sort();
    if (!frames.length) return null;
    const list = join(dir, "frames.txt");
    writeFileSync(list, frames.map((f) => `file '${join(dir, f).replace(/'/g, "'\\''")}'\nduration ${1 / fps}`).join("\n") + "\n");
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=${fps},scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, out], { encoding: "utf8", timeout: 120_000 });
    return r.status === 0 && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}
