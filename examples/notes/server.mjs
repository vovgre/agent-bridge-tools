// A tiny app for the browser kit's example adapter (projects/example): a list of notes in DATA_DIR/notes.json,
// added through a native form post.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const file = join(process.env.DATA_DIR, "notes.json");
const notes = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/notes") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const text = new URLSearchParams(body).get("text")?.trim();
      if (text) writeFileSync(file, JSON.stringify([...notes(), text]));
      res.writeHead(303, { Location: "/" }).end();
    });
    return;
  }
  if (req.url === "/api/notes") return res.setHeader("Content-Type", "application/json"), res.end(JSON.stringify(notes()));
  const page = readFileSync(join(process.cwd(), "dist", "index.html"), "utf8");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(page.replace("<!--notes-->", notes().map((n) => `<li>${escape(n)}</li>`).join("")));
}).listen(Number(process.env.PORT), "127.0.0.1");
