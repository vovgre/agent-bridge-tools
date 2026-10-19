// The browser's only way out: Chrome is started with this as its proxy for everything, loopback included, so every
// request (pages, fetches, redirect hops, WebSockets, workers) passes here. Only the run's own origins are forwarded;
// anything else gets 403 (or a refused tunnel) and is recorded.
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";

export class Gate {
  readonly allowed = new Set<string>();
  readonly blocked: { at: number; what: string }[] = [];
  private server: Server;
  private sockets = new Set<Socket>();
  port = 0;

  constructor(origins: string[] = []) {
    for (const o of origins) this.allow(o);
    this.server = createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!this.allowed.has(url.origin)) {
        this.block(`${req.method} ${req.url}`);
        res.writeHead(403, { "Content-Type": "text/plain", "X-UI-Kit": "blocked" });
        res.end(`Blocked by the UI kit: ${url.origin} is not one of this run's origins`);
        return;
      }
      const headers = { ...req.headers };
      delete headers["proxy-connection"];
      const up = request({ host: url.hostname, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    });
    // CONNECT: Chrome tunnels WebSockets (and https) through the proxy.
    this.server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => this.tunnel(`http://${req.url}`, `CONNECT ${req.url}`, socket, head));
    // A WebSocket sent as a plain upgrade request (absolute URL).
    this.server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        socket.destroy();
        return;
      }
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      this.tunnel(url.origin.replace(/^ws/, "http"), `UPGRADE ${req.url}`, socket, Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), head]), false);
    });
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  private tunnel(origin: string, what: string, socket: Socket, head: Buffer, announce = true) {
    socket.on("error", () => {});
    let o: string;
    try {
      o = new URL(origin).origin;
    } catch {
      socket.destroy();
      return;
    }
    if (!this.allowed.has(o)) {
      this.block(what);
      socket.end("HTTP/1.1 403 Forbidden\r\nX-UI-Kit: blocked\r\n\r\n");
      return;
    }
    const u = new URL(o);
    const up = connect(Number(u.port || 80), u.hostname, () => {
      if (announce) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    this.sockets.add(up);
    up.on("close", () => this.sockets.delete(up));
  }

  private block(what: string) {
    this.blocked.push({ at: Date.now(), what });
  }

  /** Lets the browser reach `origin` ("http://127.0.0.1:5199"); ws:// is the same origin with http://. */
  allow(origin: string) {
    this.allowed.add(new URL(origin.replace(/^ws/, "http")).origin);
  }

  isAllowed(url: string): boolean {
    try {
      const u = new URL(url);
      if (!/^(https?|wss?):$/.test(u.protocol)) return true;
      return this.allowed.has(new URL(url.replace(/^ws/, "http")).origin);
    } catch {
      return true;
    }
  }

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  close() {
    for (const s of this.sockets) s.destroy();
    this.server.close();
  }
}
