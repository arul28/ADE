// Start-up probe for scripts/perf/desktop-main-start.mjs. Loaded into the desktop
// main process with NODE_OPTIONS=--require, and only when the bench sets
// ADE_PERF_START_PROBE to a file path, so product code is not changed for it.
// Every mark is performance.now(): milliseconds since process start.
//   bundle  require() of dist/main/main.cjs returned (its top level has run)
//   ready   Electron's app 'ready' event
//   window  the first BrowserWindow was constructed
// At `window` it writes the marks and exits with app.exit(0), which skips
// before-quit handlers, so no confirm dialog can block the run.
"use strict";
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const probeFile = process.env.ADE_PERF_START_PROBE;
if (probeFile) {
  const marks = {
    timeOrigin: performance.timeOrigin,
    node: process.versions.node,
    electron: process.versions.electron,
  };
  const bundleSuffix = path.join("dist", "main", "main.cjs");
  const loadModule = Module._load;
  let armed = false;
  // `electron` is not resolvable during --require, so the app listeners are
  // attached when the bundle is first requested, which is before it evaluates
  // and well before 'ready' can fire.
  const arm = () => {
    const electron = require("electron");
    if (!electron || typeof electron !== "object" || !electron.app) return;
    const { app } = electron;
    app.once("ready", () => { marks.ready = performance.now(); });
    app.once("browser-window-created", () => {
      marks.window = performance.now();
      fs.writeFileSync(probeFile, JSON.stringify(marks));
      setImmediate(() => app.exit(0));
    });
  };
  Module._load = function probeLoad(request) {
    const isBundle = typeof request === "string" && request.endsWith(bundleSuffix);
    if (isBundle && !armed) {
      armed = true;
      arm();
    }
    const loaded = loadModule.apply(this, arguments);
    if (isBundle && marks.bundle === undefined) marks.bundle = performance.now();
    return loaded;
  };
}
