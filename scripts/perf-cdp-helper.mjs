#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";

const cdpPort = Number(process.env.ADE_APP_CONTROL_CDP_PORT ?? process.env.ADE_ELECTRON_REMOTE_DEBUGGING_PORT ?? 9222);
const command = process.argv[2];

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening CDP websocket")), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket error"));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event.data));
    await this.send("Runtime.enable");
  }

  onMessage(data) {
    const message = JSON.parse(String(data));
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "CDP command failed"));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP websocket is not open");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function findTarget(timeoutMs = 30_000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const pages = Array.isArray(targets) ? targets : [];
      const target = pages.find((entry) => {
        const title = String(entry.title ?? "").toLowerCase();
        const url = String(entry.url ?? "");
        return entry.type === "page"
          && entry.webSocketDebuggerUrl
          && !title.includes("devtools")
          && !title.includes("developer tools")
          && (url.includes("localhost:") || url.includes("127.0.0.1:") || url.startsWith("file://"));
      }) ?? pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (target?.webSocketDebuggerUrl) return target;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`No ADE renderer target on CDP ${cdpPort}${lastError ? `: ${lastError.message}` : ""}`);
}

async function evaluate(client, source, arg = undefined) {
  const expression = `(${source})(${JSON.stringify(arg)})`;
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function withClient(fn) {
  const target = await findTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const value = await fn(client);
    if (value !== undefined) console.log(JSON.stringify(value, null, 2));
  } finally {
    client.close();
  }
}

async function main() {
  if (command === "mark") {
    const [name, phase] = process.argv.slice(3);
    if (!name || !phase) throw new Error("Usage: perf-cdp-helper.mjs mark <name> <start|end>");
    await withClient((client) => evaluate(client, async (args) => {
      return await window.ade.perf.recordEvent({ kind: "manualStep", ts: Date.now(), name: args.name, phase: args.phase });
    }, { name, phase }));
    return;
  }

  if (command === "finalize") {
    await withClient((client) => evaluate(client, async () => window.ade.perf.finalize()));
    return;
  }

  if (command === "snapshot") {
    await withClient((client) => evaluate(client, async () => ({
      href: window.location.href,
      title: document.title,
      project: await window.ade.app.getProject(),
      lanes: await window.ade.lanes.list().catch((error) => ({ error: String(error) })),
      perf: await window.ade.perf.getConfig(),
    })));
    return;
  }

  if (command === "route") {
    const path = process.argv[3];
    if (!path?.startsWith("/")) throw new Error("Usage: perf-cdp-helper.mjs route /path");
    await withClient((client) => evaluate(client, async (args) => {
      window.location.assign(args.path);
      return { href: window.location.href, next: args.path };
    }, { path }));
    return;
  }

  if (command === "setup-lanes") {
    const projectRoot = process.argv[3];
    if (!projectRoot) throw new Error("Usage: perf-cdp-helper.mjs setup-lanes <projectRoot>");
    await withClient((client) => evaluate(client, async (args) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let project = await window.ade.app.getProject();
      if (project?.rootPath !== args.projectRoot) {
        project = await window.ade.project.switchToPath(args.projectRoot);
      }
      const startedAt = Date.now();
      while (Date.now() - startedAt < 30_000) {
        project = await window.ade.app.getProject();
        if (project?.rootPath === args.projectRoot) break;
        await wait(100);
      }

      const config = await window.ade.projectConfig.get();
      if (config.trust?.requiresSharedTrust) {
        await window.ade.projectConfig.confirmTrust();
      }
      await window.ade.onboarding?.complete?.().catch(() => {});

      let lanes = await window.ade.lanes.list({ includeArchived: false });
      const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0] ?? null;
      const runSuffix = Date.now().toString(36).slice(-6);
      const desired = [
        { name: `UI audit lane 1 ${runSuffix}`, branchName: `perf/ui-audit-${runSuffix}-lane-1` },
        { name: `UI audit lane 2 ${runSuffix}`, branchName: `perf/ui-audit-${runSuffix}-lane-2` },
        { name: `UI audit lane 3 ${runSuffix}`, branchName: `perf/ui-audit-${runSuffix}-lane-3` },
        { name: `UI audit lane 4 ${runSuffix}`, branchName: `perf/ui-audit-${runSuffix}-lane-4` },
      ];
      for (const lane of desired) {
        if (lanes.some((existing) => existing.branchRef === lane.branchName || existing.name === lane.name)) continue;
        await window.ade.lanes.create({
          name: lane.name,
          branchName: lane.branchName,
          ...(primary ? { parentLaneId: primary.id } : {}),
        });
        lanes = await window.ade.lanes.list({ includeArchived: false });
      }

      const rootLane = lanes.find((lane) => lane.name === desired[0].name);
      const childNames = [`UI audit child A ${runSuffix}`, `UI audit child B ${runSuffix}`];
      if (rootLane) {
        for (const [index, name] of childNames.entries()) {
          if (lanes.some((existing) => existing.name === name)) continue;
          await window.ade.lanes.createChild({
            parentLaneId: rootLane.id,
            name,
            branchName: `perf/ui-audit-${runSuffix}-child-${index + 1}`,
          });
          lanes = await window.ade.lanes.list({ includeArchived: false });
        }
      }

      const workspaces = await window.ade.files.listWorkspaces({ includeArchived: false });
      for (const [workspaceIndex, workspace] of workspaces.entries()) {
        if (workspace.kind === "primary") continue;
        const dir = `lane-stress-${workspaceIndex}`;
        await window.ade.files.createDirectory({ workspaceId: workspace.id, path: dir }).catch(() => {});
        for (let file = 0; file < 8; file += 1) {
          const path = `${dir}/stress-${file}.ts`;
          const text = [
            `export const laneStress${workspaceIndex}_${file} = ${workspaceIndex * 100 + file};`,
            `export const marker = "PERF_NEEDLE lane ${workspace.name} file ${file}";`,
            "",
          ].join("\n");
          await window.ade.files.createFile({ workspaceId: workspace.id, path, content: text }).catch(async () => {
            await window.ade.files.writeText({ workspaceId: workspace.id, path, text }).catch(() => {});
          });
        }
        await window.ade.files.writeText({
          workspaceId: workspace.id,
          path: "src/feature-00/component-000.ts",
          text: `export const laneSpecific = "${workspace.name}";\nexport const marker = "PERF_NEEDLE edited in lane";\n`,
        }).catch(() => {});
      }

      window.history.pushState(null, "", "/files");
      window.dispatchEvent(new PopStateEvent("popstate"));

      return {
        project,
        lanes: await window.ade.lanes.list({ includeArchived: false }),
        workspaces: await window.ade.files.listWorkspaces({ includeArchived: false }),
      };
    }, { projectRoot }));
    return;
  }

  throw new Error("Usage: perf-cdp-helper.mjs <mark|finalize|snapshot|route|setup-lanes> ...");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
