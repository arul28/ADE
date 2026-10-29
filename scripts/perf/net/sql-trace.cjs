// Preload for a measurement brain: times every node:sqlite statement and transaction in the process.
//   ADE_PERF_EXTRA_REQUIRE=<abs path>/sql-trace.cjs ADE_PERF_SQLTRACE_FILE=<file.jsonl> node scripts/perf/net/measure-brain.mjs start ...
// Appends JSON lines to $ADE_PERF_SQLTRACE_FILE (default <os temp>/sql-<pid>.jsonl): every statement of
// 0.2 ms or more ({ at, thread, kind, ms, sql }), or every statement with ADE_PERF_SQLTRACE_ALL=1, and every
// transaction span ({ kind: "txn", ms, stmtMs, n }).
// `at` is wall-clock ms; `thread` is the worker thread id (0 is the event loop; the off-thread sync export
// runs on a worker, which preloads also reach). Measurement brains only; never the installed app.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite = require("node:sqlite");
const { threadId } = require("node:worker_threads");

const out = process.env.ADE_PERF_SQLTRACE_FILE || path.join(os.tmpdir(), `sql-${process.pid}.jsonl`);
const minMs = process.env.ADE_PERF_SQLTRACE_ALL === "1" ? 0 : 0.2;
let buf = [];
const flush = () => {
  if (!buf.length) return;
  try {
    fs.appendFileSync(out, `${buf.join("\n")}\n`);
  } catch {
    // Tracing must never break the process it watches.
  }
  buf = [];
};
setInterval(flush, 1000).unref();
process.on("exit", flush);

let txnStart = null;
let txnSql = null;
let txnStmts = 0;
let txnMs = 0;
const note = (kind, sql, ms) => {
  const text = String(sql || "").replace(/\s+/g, " ").trim();
  const head = text.slice(0, 12).toLowerCase();
  const now = performance.now();
  if (/^(begin|savepoint)/.test(head) && txnStart === null) {
    txnStart = now - ms;
    txnStmts = 0;
    txnMs = 0;
    txnSql = null;
  } else if (txnStart !== null) {
    txnStmts += 1;
    txnMs += ms;
    if (!txnSql && !/^(commit|release|rollback|end)/.test(head)) txnSql = text.slice(0, 160);
  }
  if (txnStart !== null && /^(commit|end|rollback)/.test(head)) {
    buf.push(JSON.stringify({ at: Date.now(), thread: threadId, kind: "txn", ms: +(now - txnStart).toFixed(2), stmtMs: +txnMs.toFixed(2), n: txnStmts, sql: txnSql }));
    txnStart = null;
  }
  if (ms >= minMs) buf.push(JSON.stringify({ at: Date.now(), thread: threadId, kind, ms: +ms.toFixed(2), sql: text.slice(0, 200) }));
};

const statement = sqlite.StatementSync.prototype;
for (const method of ["all", "get", "run", "iterate"]) {
  const original = statement[method];
  if (typeof original !== "function") continue;
  statement[method] = function timed(...args) {
    const started = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      note(method, this.sourceSQL, performance.now() - started);
    }
  };
}
const database = sqlite.DatabaseSync.prototype;
const exec = database.exec;
database.exec = function timedExec(sql) {
  const started = performance.now();
  try {
    return exec.call(this, sql);
  } finally {
    note("exec", sql, performance.now() - started);
  }
};
