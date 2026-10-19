// A tiny app for the runner's own tests: serves dist/, and a few switches to misbehave on purpose.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

if (process.env.FAKE_GRANDCHILD) {
  const c = spawn("sleep", ["600"], { stdio: "ignore" });
  writeFileSync(join(process.env.DATA_DIR, "grandchild.pid"), String(c.pid));
}
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/500") return (res.statusCode = 500), res.end("boom");
  if (u.pathname === "/die") return res.end("bye"), setTimeout(() => process.exit(1), 10);
  if (u.pathname === "/mutate") {
    if (process.env.FAKE_MUTATIONS) appendFileSync(process.env.FAKE_MUTATIONS, `mutated ${Date.now()}\n`);
    return res.end("ok");
  }
  if (u.pathname === "/redirect") return res.writeHead(302, { Location: u.searchParams.get("to") }), res.end();
  res.setHeader("Content-Type", "text/html");
  res.end(readFileSync(join(process.cwd(), "dist", "index.html")));
});
setTimeout(() => server.listen(Number(process.env.PORT), "127.0.0.1"), Number(process.env.FAKE_READY_DELAY || 0));
