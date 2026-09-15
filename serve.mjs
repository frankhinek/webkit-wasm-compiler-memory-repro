#!/usr/bin/env node
// Static server for the repro. Prints page events that arrive as POST /log.
// Usage: node serve.mjs [--port=8471] [--host=127.0.0.1] [--log=events.jsonl]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unexpected argument ${arg}`);
    return [match[1], match[2]];
  }),
);
const port = Number(args.port ?? 8471);
const host = args.host ?? "127.0.0.1";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};
const PUBLIC = ["index.html", "repro.js", "vendor/", "variants/"];

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname.endsWith("/log")) {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) return res.writeHead(413).end();
      }
      let entry;
      try {
        entry = JSON.parse(body);
      } catch {
        return res.writeHead(400).end();
      }
      const line = JSON.stringify({ ...entry, receivedAt: new Date().toISOString() });
      console.log(line);
      if (args.log) fs.appendFileSync(args.log, line + "\n");
      return res.writeHead(204).end();
    }
    const file = path.resolve(ROOT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)));
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const allowed = PUBLIC.some((entry) => (entry.endsWith("/") ? relative.startsWith(entry) : relative === entry));
    if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(fs.readFileSync(file));
  })
  .listen(port, host, () => console.log(`READY http://${host}:${port}/`));
