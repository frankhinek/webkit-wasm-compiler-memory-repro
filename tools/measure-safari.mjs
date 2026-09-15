#!/usr/bin/env node
// macOS only. Runs each build in its own Safari automation session through SafariDriver, samples the
// physical footprint of every WebKit web content process, and reports the process that grew the most.
// One-time setup: Safari > Settings > Advanced > "Show features for web developers", then
// Develop > "Allow Remote Automation". Safari allows one automation session at a time, so this
// refuses to start while another safaridriver is running. Avoid using Safari during a run.
// Usage: node tools/measure-safari.mjs [--builds=asyncify,asyncify-padded,sync] [--reps=2] [--rows=5000] [--rounds=1] [--modules=4] [--settle=20]
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unexpected argument ${arg}`);
    return [match[1], match[2]];
  }),
);
const builds = (args.builds ?? "asyncify,asyncify-padded,sync").split(",");
const reps = Number(args.reps ?? 2);
const rows = Number(args.rows ?? 5000);
const rounds = Number(args.rounds ?? 1);
const modules = Number(args.modules ?? 4);
const settleSeconds = Number(args.settle ?? 20);
const port = Number(args.port ?? 8471);
const sh = (command) => execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MiB = (bytes) => Math.round(bytes / 1048576);
const readJsonl = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

if (sh("pgrep -x safaridriver || true")) throw new Error("safaridriver is already running; another tool may be automating Safari");
const safariBuild = sh("/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' /Applications/Safari.app/Contents/Info.plist");
const environment = {
  browser: null,
  macos: `${sh("sw_vers -productVersion")} (${sh("sw_vers -buildVersion")})`,
  hardware: sh("sysctl -n hw.model"),
  memoryGiB: Number(sh("sysctl -n hw.memsize")) / 1073741824,
};
const session = path.join(ROOT, "results", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(session, { recursive: true });
const logPath = path.join(session, "page-events.jsonl");

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port: free } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return free;
}
async function webdriver(route, method = "GET", body) {
  const response = await fetch(driverOrigin + route, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const { value } = await response.json();
  if (!response.ok || value?.error) throw new Error(`WebDriver ${method} ${route}: ${value?.message || value?.error || response.status}`);
  return value;
}

const driverOrigin = `http://127.0.0.1:${await freePort()}`;
const driver = spawn("/usr/bin/safaridriver", ["-p", new URL(driverOrigin).port], { stdio: ["ignore", "ignore", "pipe"] });
let driverLog = "";
driver.stderr.on("data", (data) => (driverLog = (driverLog + data).slice(-4000)));
const server = spawn(process.execPath, [path.join(ROOT, "serve.mjs"), `--port=${port}`, `--log=${logPath}`], {
  stdio: ["ignore", "pipe", "inherit"],
});

const webContentPids = () =>
  sh("pgrep -f com.apple.WebKit.WebContent || true").split("\n").filter(Boolean).map(Number);

async function trial(n, build) {
  const run = `${n}-${build}-${Date.now()}`;
  const dir = path.join(session, `trial-${String(n).padStart(2, "0")}-${build}`);
  fs.mkdirSync(dir);
  const samplers = new Map();
  // /usr/bin/python3 can run the interpreter as a child process, so each sampler gets its own
  // process group, is stopped as a group, and also stops itself after the trial's longest duration.
  const limitSeconds = String(300 + settleSeconds + 60);
  const sampleNew = () => {
    for (const pid of webContentPids())
      if (!samplers.has(pid))
        samplers.set(
          pid,
          spawn(
            "/usr/bin/python3",
            [path.join(ROOT, "tools", "sample-footprint.py"), String(pid), path.join(dir, `footprint-${pid}.jsonl`), dir, limitSeconds],
            { stdio: "ignore", detached: true },
          ),
        );
  };
  sampleNew();
  await sleep(1000);
  const opened = Date.now();
  // A new automation session per trial gives each build a fresh window and web content process,
  // and deleting the session closes the window afterwards.
  const created = await webdriver("/session", "POST", { capabilities: { alwaysMatch: { browserName: "safari", platformName: "mac" } } });
  environment.browser ??= `Safari ${created.capabilities?.browserVersion ?? "unknown"} (${safariBuild})`;
  let finished = null;
  try {
    sampleNew();
    const query = new URLSearchParams({ build, rows: String(rows), rounds: String(rounds), modules: String(modules), run, autostart: "1" });
    await webdriver(`/session/${created.sessionId}/url`, "POST", { url: `http://127.0.0.1:${port}/?${query}` });
    while (!finished && Date.now() - opened < 300_000) {
      await sleep(250);
      sampleNew();
      finished = readJsonl(logPath).find((event) => event.run === run && ["done", "error"].includes(event.event)) ?? null;
    }
    const settleEnd = Date.now() + settleSeconds * 1000;
    while (Date.now() < settleEnd) {
      await sleep(250);
      sampleNew();
    }
  } finally {
    await webdriver(`/session/${created.sessionId}`, "DELETE").catch(() => {});
    for (const sampler of samplers.values()) {
      try {
        process.kill(-sampler.pid, "SIGTERM");
      } catch {}
    }
    await sleep(300);
  }
  const finishedAt = finished ? Date.parse(finished.at) : null;
  const processes = [...samplers.keys()]
    .map((pid) => {
      const samples = readJsonl(path.join(dir, `footprint-${pid}.jsonl`)).filter((sample) => !sample.exited);
      if (!samples.length) return null;
      const before = samples.filter((sample) => sample.t * 1000 <= opened).at(-1) ?? samples[0];
      const peak = samples.reduce((best, sample) => (sample.fp > best.fp ? sample : best));
      return {
        pid,
        beforeMiB: MiB(before.fp),
        peakMiB: MiB(peak.fp),
        growthMiB: MiB(peak.fp - before.fp),
        peakSecondsAfterWorkload: finishedAt ? Number(((peak.t * 1000 - finishedAt) / 1000).toFixed(1)) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.growthMiB - a.growthMiB);
  const result = {
    n,
    build,
    outcome: finished?.event ?? "timeout",
    workloadMs: finished?.elapsedMs ?? null,
    error: finished?.error,
    tab: processes[0] ?? null,
  };
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ ...result, processes }, null, 2) + "\n");
  return result;
}

const results = [];
try {
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (data) => {
      if (String(data).includes("READY")) resolve();
    });
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  for (let tries = 0; ; tries++) {
    try {
      await webdriver("/status");
      break;
    } catch (error) {
      if (tries > 50 || driver.exitCode !== null) throw new Error(`safaridriver did not start: ${driverLog || error}`);
      await sleep(100);
    }
  }
  let n = 0;
  for (let rep = 0; rep < reps; rep++)
    for (let i = 0; i < builds.length; i++) {
      const result = await trial(++n, builds[(i + rep) % builds.length]);
      results.push(result);
      console.log(JSON.stringify(result));
    }
} finally {
  driver.kill("SIGTERM");
  server.kill("SIGTERM");
  fs.writeFileSync(path.join(session, "summary.json"), JSON.stringify({ environment, rows, rounds, modules, settleSeconds, results }, null, 2) + "\n");
  console.log(`RESULTS ${session}`);
}
