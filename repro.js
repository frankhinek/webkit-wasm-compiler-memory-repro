// Runs an in-memory SQLite workload with unmodified wa-sqlite builds. The Asyncify and padded
// pages load the same code; padding only grows the byte size of the three largest function bodies.
import * as SQLite from "./vendor/wa-sqlite/src/sqlite-api.js";
import { MemoryVFS } from "./vendor/wa-sqlite/src/examples/MemoryVFS.js";

const BUILDS = {
  asyncify: { dir: "vendor/wa-sqlite/dist/", loader: "wa-sqlite-async.mjs", label: "Asyncify build" },
  "asyncify-padded": {
    dir: "variants/asyncify-padded/",
    loader: "wa-sqlite-async.mjs",
    label: "Asyncify build with its three largest functions padded",
  },
  sync: { dir: "vendor/wa-sqlite/dist/", loader: "wa-sqlite.mjs", label: "Non-Asyncify build" },
};
const params = new URLSearchParams(location.search);
const rows = Number(params.get("rows") ?? 5000);
const rounds = Number(params.get("rounds") ?? 1);
const modules = Number(params.get("modules") ?? 4);
const run = params.get("run") ?? String(Date.now());
const statusElement = document.querySelector("#status");
const buttons = [...document.querySelectorAll("button[data-build]")];
// Memory peaks several seconds after the JavaScript work ends, so a kill usually comes after
// "done". The marker stays in sessionStorage for a minute after the work, so the page WebKit
// loads into the replacement process can report the reload.
const MARKER = "webkit-wasm-compiler-memory-repro:running";
const AFTER_WORK_WINDOW_MS = 60_000;

function log(event, detail = {}) {
  const entry = { run, event, at: new Date().toISOString(), ...detail };
  document.querySelector("#log").textContent += JSON.stringify(entry) + "\n";
  // serve.mjs records these; a plain static host ignores them.
  try {
    navigator.sendBeacon("log", JSON.stringify({ ...entry, userAgent: navigator.userAgent }));
  } catch {}
}
function remember(value) {
  try {
    if (value) sessionStorage.setItem(MARKER, JSON.stringify(value));
    else sessionStorage.removeItem(MARKER);
  } catch {}
}
function recall() {
  try {
    return JSON.parse(sessionStorage.getItem(MARKER) ?? "null");
  } catch {
    return null;
  }
}

async function query(sqlite, db, sql, bindings) {
  const result = [];
  for await (const statement of sqlite.statements(db, sql)) {
    if (bindings) sqlite.bind_collection(statement, bindings);
    while ((await sqlite.step(statement)) === SQLite.SQLITE_ROW) result.push(sqlite.row(statement));
  }
  return result;
}

async function workload(sqlite, db) {
  const body = "x".repeat(512);
  await sqlite.exec(
    db,
    "DROP TABLE IF EXISTS items; CREATE TABLE items(id TEXT PRIMARY KEY, grp INTEGER NOT NULL, score INTEGER NOT NULL, body TEXT NOT NULL); CREATE INDEX items_by_score ON items(score, id); CREATE INDEX items_by_grp ON items(grp, score, id);",
  );
  for (let start = 0; start < rows; start += 250) {
    await sqlite.exec(db, "BEGIN");
    for (let i = start; i < Math.min(rows, start + 250); i++)
      await query(sqlite, db, "INSERT INTO items VALUES (?, ?, ?, ?)", [`item-${i}`, i % 10, (i * 37) % 1000, body]);
    await sqlite.exec(db, "COMMIT");
  }
  for (let i = 0; i < 200; i++) {
    await query(sqlite, db, "SELECT id, score FROM items WHERE grp = ? ORDER BY score, id LIMIT 50", [i % 10]);
    await query(sqlite, db, "SELECT id, score FROM items ORDER BY score, id LIMIT 50 OFFSET ?", [(i * 397) % (rows - 50)]);
    await query(sqlite, db, "UPDATE items SET score = ?, body = ? WHERE id = ?", [(i * 17) % 1000, body, `item-${(i * 193) % rows}`]);
  }
  const [[count]] = await query(sqlite, db, "SELECT COUNT(*) FROM items");
  if (count !== rows) throw new Error(`expected ${rows} rows, found ${count}`);
}

async function start(name) {
  const build = BUILDS[name];
  if (!build) {
    statusElement.textContent = `Unknown build ${name}`;
    return;
  }
  for (const button of buttons) button.disabled = true;
  statusElement.textContent = `Running: ${build.label}`;
  const startedAt = Date.now();
  remember({ build: name, startedAt, finishedAt: null });
  log("start", { build: name, rows, rounds, modules });
  const started = performance.now();
  try {
    const base = new URL(build.dir, location.href).href;
    const { default: createModule } = await import(base + build.loader);
    // Each instance is a separate WebAssembly module whose functions tier up separately, as when
    // an application opens a fresh module per database. Instances stay referenced afterwards.
    const instances = (window.reproInstances = []);
    for (let instance = 0; instance < modules; instance++) {
      const module = await createModule({ locateFile: (file) => base + file });
      const sqlite = SQLite.Factory(module);
      const vfs = await MemoryVFS.create("memory", module);
      sqlite.vfs_register(vfs, true);
      const db = await sqlite.open_v2("/repro.db", SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE, "memory");
      for (let round = 0; round < rounds; round++) await workload(sqlite, db);
      await sqlite.close(db);
      instances.push(module);
    }
    const elapsedMs = Math.round(performance.now() - started);
    log("done", { build: name, elapsedMs });
    statusElement.textContent = `Finished: ${build.label} in ${elapsedMs} ms. Keep this tab in front; memory peaks in the next few seconds.`;
  } catch (error) {
    log("error", { build: name, error: String(error) });
    statusElement.textContent = `Error: ${error}`;
  }
  remember({ build: name, startedAt, finishedAt: Date.now() });
  setTimeout(() => remember(null), AFTER_WORK_WINDOW_MS);
}

const previous = recall();
if (previous) {
  remember(null);
  const label = BUILDS[previous.build]?.label ?? previous.build;
  const navigationType = performance.getEntriesByType("navigation")[0]?.type ?? null;
  const secondsAfterFinish = previous.finishedAt ? Number(((Date.now() - previous.finishedAt) / 1000).toFixed(1)) : null;
  const when = secondsAfterFinish === null ? `while the ${label} was running` : `${secondsAfterFinish} s after the ${label} finished`;
  statusElement.textContent = `This tab loaded again ${when}. Unless you reloaded it yourself, WebKit restarted the tab after its web content process ended, for example at the iOS per-process memory limit.`;
  log("reloaded", {
    build: previous.build,
    phase: secondsAfterFinish === null ? "during-work" : "after-work",
    secondsAfterFinish,
    navigationType,
  });
}
for (const button of buttons) button.addEventListener("click", () => void start(button.dataset.build));
if (params.get("autostart") === "1" && !previous) void start(params.get("build") ?? "asyncify");
