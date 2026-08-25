import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import {
  PluginSdkError,
  type PluginDetail,
  type PluginDomainService,
  type PluginEventPayload,
  type PluginHostFrame,
  type PluginRuntimeHookPayload,
  type PluginRuntimeStatus,
  type PluginSdkMethod,
} from "../../../shared/plugins/sdk";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { requirePluginInstallService } from "../../../../../ade-cli/src/services/plugins/pluginInstallServiceRef";
import {
  publishPluginContribution,
  readAllPluginPresence,
  replacePluginPresenceForMachine,
} from "../../../../../ade-cli/src/services/plugins/pluginTableWriters";
import type { createPluginChildSupervisor, PluginChildSupervisor } from "./pluginChildSupervisor";
import { createPluginDataStore, type PluginDataStore } from "./pluginDataStore";
import { emitPluginChange } from "./pluginEvents";
import {
  emitPluginRuntimeHook,
  resetPluginRuntimeHookListenersForTests,
} from "./pluginRuntimeHooks";
import { disposeSharedPluginHostService, getSharedPluginHostService } from "./pluginHostService";

/**
 * `plugin.setConfig` — the settings writer.
 *
 * Driven through the real `hello-plugin` fixture rather than a stub manifest,
 * because the whole contract is "does this key exist in the manifest, and what
 * does the plugin read back afterwards".
 */

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/hello-plugin",
);

const scratchDirs: string[] = [];

function testLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
}

/**
 * A supervisor that records instead of spawning.
 *
 * The host starts every enabled plugin now, so a test that installs a fixture
 * would otherwise fork a real node child per case. Recording the calls is also
 * what lets the start/stop tests below assert on what the host ASKED for.
 */
type RecordedSupervisor = PluginChildSupervisor & {
  starts: number;
  disposals: number;
  sent: PluginHostFrame[];
  /** What `send` reports back — false once a child stops draining its stdin. */
  acceptsWrites: boolean;
  /** Make an SDK call the way the real child would, over its own supervisor. */
  sdk: (method: PluginSdkMethod, params: Record<string, unknown>) => Promise<unknown>;
};

function recordingSupervisors() {
  const built: RecordedSupervisor[] = [];
  const create = ((supervisorArgs: Parameters<typeof createPluginChildSupervisor>[0]) => {
    let status: PluginRuntimeStatus = "idle";
    const supervisor: RecordedSupervisor = {
      pluginId: supervisorArgs.pluginId,
      starts: 0,
      disposals: 0,
      sent: [],
      status: () => status,
      restartCount: () => 0,
      lastCrashAt: () => null,
      pid: () => 4_242,
      start: async () => {
        supervisor.starts += 1;
        status = "running";
      },
      invoke: async () => null,
      send: (frame) => {
        supervisor.sent.push(frame);
        // A real supervisor returns what `stdin.write` returned: false once the
        // child has stopped draining. Tests flip this to prove the host drops
        // rather than keeps queueing into a buffer nobody empties.
        return supervisor.acceptsWrites;
      },
      logs: () => [],
      dispose: async () => {
        supervisor.disposals += 1;
        status = "stopped";
      },
      acceptsWrites: true,
      /** Stand in for the child's `ade.events.on` / its unsubscribe. */
      sdk: (method, params) => supervisorArgs.onSdkCall(method, params),
    };
    built.push(supervisor);
    return supervisor;
  }) as typeof createPluginChildSupervisor;
  return {
    built,
    create,
    /** The live supervisor for a plugin: `built` keeps the replaced ones too. */
    latest: (pluginId: string) => [...built].reverse().find((entry) => entry.pluginId === pluginId) ?? null,
  };
}

/**
 * The fixture plugin, with its `sockets[]` replaced.
 *
 * Copied to a scratch directory rather than edited in place: the checked-in
 * fixture declares exactly one socket and several tests above depend on that.
 */
/**
 * A private, writable copy of the fixture, for a test that edits its SOURCE.
 *
 * A reload re-copies a `local` plugin from the folder it was installed from, so
 * a test that wants a reload to see an edit has to make that edit at the source
 * — and it cannot make it in the checked-in fixture directory every other test
 * installs from.
 */
function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-fixture-"));
  scratchDirs.push(dir);
  fs.cpSync(fixtureRoot, dir, { recursive: true });
  return dir;
}

function fixtureWithSockets(sockets: unknown[]): string {
  const dir = copyFixture();
  const manifestPath = path.join(dir, "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.sockets = sockets;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/** A logger that keeps its warnings, for the cases whose output IS the contract. */
function recordingLogger() {
  const warnings: { event: string; detail: Record<string, unknown> }[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (event: string, detail?: Record<string, unknown>) => {
      warnings.push({ event, detail: detail ?? {} });
    },
    error: () => {},
  } as unknown as Logger;
  return { logger, warnings };
}

async function hostWithFixture(
  options: { source?: string; attachProject?: boolean; logger?: Logger } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-host-"));
  scratchDirs.push(dir);
  const pluginsRoot = path.join(dir, "plugins");
  const supervisors = recordingSupervisors();
  const host = getSharedPluginHostService({
    logger: options.logger ?? testLogger(),
    pluginsRoot,
    createSupervisor: supervisors.create,
  });
  const plugins = host.domainService(null);
  let store: PluginDataStore | null = null;
  let projectDb: AdeDb | null = null;
  let attachedRoot: string | null = null;
  if (options.attachProject !== false) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-project-"));
    scratchDirs.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), silentLogger());
    openDatabases.push(db);
    host.attachProject({ projectId: "project-1", projectRoot, db, invokeAdeAction: async () => null });
    store = createPluginDataStore({ db });
    projectDb = db;
    attachedRoot = projectRoot;
  }
  await plugins.install({ source: options.source ?? fixtureRoot });
  return { plugins, pluginsRoot, host, supervisors, store, db: projectDb, projectRoot: attachedRoot };
}

/** Databases every describe block below closes in its own `afterEach`. */
const openDatabases: AdeDb[] = [];

async function closeScratch(): Promise<void> {
  await disposeSharedPluginHostService();
  while (openDatabases.length) openDatabases.pop()?.close();
  while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
}

function storedConfig(pluginsRoot: string): Record<string, unknown> {
  const decoded = JSON.parse(fs.readFileSync(path.join(pluginsRoot, "config.json"), "utf8")) as {
    config?: Record<string, unknown>;
  };
  return decoded.config ?? {};
}

describe("plugin.setConfig", () => {
  afterEach(closeScratch);

  it("stores a declared setting and reads it back over the manifest default", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    const before = await plugins.get({ pluginId: "hello-plugin" });
    expect(before?.config.greeting).toBe("Hello");

    const detail = await plugins.setConfig({ pluginId: "hello-plugin", values: { greeting: "Hei" } });

    expect(detail.config.greeting).toBe("Hei");
    expect(storedConfig(pluginsRoot)).toEqual({ "hello-plugin": { greeting: "Hei" } });
    expect((await plugins.get({ pluginId: "hello-plugin" }))?.config.greeting).toBe("Hei");
  });

  it("refuses a key the manifest never declared instead of storing it", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    // A typo that persisted would read back as a setting the plugin never sees,
    // which from inside the plugin is indistinguishable from a broken host.
    const rejected = await plugins
      .setConfig({ pluginId: "hello-plugin", values: { greetign: "Hei" } })
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(PluginSdkError);
    expect((rejected as PluginSdkError).code).toBe("invalid_args");
    expect(fs.existsSync(path.join(pluginsRoot, "config.json"))).toBe(false);
  });

  it("treats null as a reset, restoring the manifest default rather than storing null", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    await plugins.setConfig({ pluginId: "hello-plugin", values: { greeting: "Hei" } });
    const detail = await plugins.setConfig({ pluginId: "hello-plugin", values: { greeting: null } });

    // Stored null would shadow the default with nothing, so the override is
    // removed instead — the plugin reads its declared default again.
    expect(detail.config.greeting).toBe("Hello");
    expect(storedConfig(pluginsRoot)).toEqual({ "hello-plugin": {} });
  });

  it("leaves settings this call did not name alone", async () => {
    const { plugins } = await hostWithFixture();

    await plugins.setConfig({ pluginId: "hello-plugin", values: { greeting: "Hei" } });
    const detail = await plugins.setConfig({ pluginId: "hello-plugin", values: {} });

    expect(detail.config.greeting).toBe("Hei");
  });

  it("refuses to configure a plugin that is not installed", async () => {
    const { plugins } = await hostWithFixture();

    const rejected = await plugins
      .setConfig({ pluginId: "not-installed", values: {} })
      .catch((error: unknown) => error);

    expect((rejected as PluginSdkError).code).toBe("plugin_not_found");
  });
});

describe("plugin contributions, readme and source inspection", () => {
  afterEach(closeScratch);

  it("persists a disabled contribution as an OFF list that survives a reload", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    const before = await plugins.list({});
    // On by default: an empty list has to mean "everything this plugin
    // declares is live", or a plugin installed before the field existed would
    // read as fully switched off.
    expect(before[0]?.disabledContributions).toEqual([]);

    const summary = await plugins.setContributionEnabled({
      pluginId: "hello-plugin",
      socketId: "greeting",
      enabled: false,
    });
    expect(summary.disabledContributions).toEqual(["greeting"]);

    // Persisted in the machine install registry, not held in memory.
    const state = JSON.parse(fs.readFileSync(path.join(pluginsRoot, "state.json"), "utf8")) as {
      plugins: Record<string, { disabledContributions?: string[] }>;
    };
    expect(state.plugins["hello-plugin"]?.disabledContributions).toEqual(["greeting"]);
    expect((await plugins.list({}))[0]?.disabledContributions).toEqual(["greeting"]);

    const reenabled = await plugins.setContributionEnabled({
      pluginId: "hello-plugin",
      socketId: "greeting",
      enabled: true,
    });
    expect(reenabled.disabledContributions).toEqual([]);
  });

  it("keeps a switched-off contribution switched off across a reinstall", async () => {
    const { plugins } = await hostWithFixture();

    await plugins.setContributionEnabled({
      pluginId: "hello-plugin",
      socketId: "greeting",
      enabled: false,
    });

    // An upgrade replaces the code, not the user's settings: a badge they
    // turned off coming back on would be indistinguishable from ADE ignoring
    // the switch.
    const reinstalled = await plugins.install({ source: fixtureRoot });
    expect(reinstalled.disabledContributions).toEqual(["greeting"]);
    expect((await plugins.list({}))[0]?.disabledContributions).toEqual(["greeting"]);
  });

  it("reads an installed plugin's readme and answers null when it ships none", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    expect(await plugins.getReadme({ pluginId: "hello-plugin" })).toBeNull();

    fs.writeFileSync(path.join(pluginsRoot, "hello-plugin", "README.md"), "# Hello\n", "utf8");
    expect(await plugins.getReadme({ pluginId: "hello-plugin" })).toBe("# Hello\n");
    expect(await plugins.getReadme({ pluginId: "not-installed" })).toBeNull();
  });

  it("inspects a local source without installing it, and never fetches a remote one", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    const local = await plugins.inspectSource({ source: fixtureRoot });
    expect(local?.manifest?.name).toBe("hello-plugin");

    // A URL is reported as itself with no manifest: reading a source must never
    // be the step that puts code on the machine.
    const remote = await plugins.inspectSource({ source: "https://example.test/graph.git" });
    expect(remote).toEqual({ source: "https://example.test/graph.git", manifest: null });
    expect(fs.readdirSync(pluginsRoot).sort()).toEqual(["hello-plugin", "state.json"]);
  });

  it("reports no presence rows when no project database is attached", async () => {
    const { plugins } = await hostWithFixture();

    // Empty reads as "this machine only" rather than as an error — the rows
    // live in a project database this host has not been given.
    expect(await plugins.presence()).toEqual([]);
  });

  it("reads a plugin's manifest and its log ring, without inventing either", async () => {
    const { plugins } = await hostWithFixture();

    expect((await plugins.getManifest({ pluginId: "hello-plugin" }))?.name).toBe("hello-plugin");
    expect(await plugins.getManifest({ pluginId: "not-installed" })).toBeNull();
    // A plugin that has never started has no lines rather than an error.
    expect(await plugins.openLogs({ pluginId: "hello-plugin" })).toEqual([]);
  });

  it("refuses logs for a plugin that is not installed", async () => {
    const { plugins } = await hostWithFixture();

    const rejected = await plugins.openLogs({ pluginId: "not-installed" }).catch((error: unknown) => error);
    expect((rejected as PluginSdkError).code).toBe("plugin_not_found");
  });
});

/**
 * Starting and materializing — what makes an installed plugin visible at all.
 *
 * Nothing but an explicit `invoke` used to start a plugin or write a panel row,
 * so a freshly installed plugin sat idle behind empty surfaces until someone
 * happened to call one of its actions. These pin both halves: enabled plugins
 * start, and a panel a manifest DECLARES exists without the plugin running —
 * which is the only way a plugin that ships no code can render.
 */
/** A plugin with a declared panel and no `entry` — a theme, or a static tab. */
function codelessPluginDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-codeless-"));
  scratchDirs.push(dir);
  const root = path.join(dir, "quiet-plugin");
  fs.mkdirSync(path.join(root, "panels"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "plugin.json"),
    JSON.stringify({
      name: "quiet-plugin",
      version: "1.0.0",
      displayName: "Quiet",
      description: "Ships a panel and no code at all.",
      vocabVersion: 1,
      surfaces: [{ kind: "tab", id: "quiet", title: "Quiet", panelId: "main" }],
      panels: [{ id: "main", schemaFile: "panels/main.json", title: "Quiet" }],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "panels", "main.json"),
    JSON.stringify({
      v: 1,
      title: "Quiet",
      fallback: { title: "Quiet", text: "Open ADE to see this." },
      body: [{ component: "text", text: "Declared, never published." }],
    }),
    "utf8",
  );
  return root;
}

describe("plugin start and panel materialization", () => {
  afterEach(closeScratch);

  it("starts an enabled plugin as soon as it is installed", async () => {
    const { supervisors } = await hostWithFixture();

    // No invoke anywhere in this test: installing is enough.
    expect(supervisors.latest("hello-plugin")?.starts).toBe(1);
    expect(supervisors.latest("hello-plugin")?.status()).toBe("running");
  });

  it("starts enabled plugins when a project binds, and stops one that is disabled", async () => {
    const { plugins, host, supervisors } = await hostWithFixture();

    await plugins.disable({ pluginId: "hello-plugin" });
    expect(supervisors.latest("hello-plugin")?.disposals).toBe(1);

    await plugins.enable({ pluginId: "hello-plugin" });
    const running = supervisors.latest("hello-plugin");
    expect(running?.starts).toBe(1);

    // A second project binding re-runs the pass without restarting anything.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-project-2-"));
    scratchDirs.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), silentLogger());
    openDatabases.push(db);
    host.attachProject({ projectId: "project-2", projectRoot, db, invokeAdeAction: async () => null });
    expect(supervisors.latest("hello-plugin")).toBe(running);
    expect(running?.starts).toBe(2);
  });

  it("materializes a declared panel from the manifest, with nothing invoked", async () => {
    const { store } = await hostWithFixture();

    const panel = store!.readPanel("hello-plugin", "main");
    expect(panel?.title).toBe("Hello");
    expect(panel?.schema).toMatchObject({ v: 1, title: "Hello" });
  });

  it("renders a plugin that ships no code, and never builds a supervisor for it", async () => {
    const { plugins, store, supervisors } = await hostWithFixture({ source: codelessPluginDir() });

    const summary = (await plugins.list({})).find((entry) => entry.pluginId === "quiet-plugin");
    expect(summary?.hasEntry).toBe(false);
    expect(summary?.status).toBe("no-entry");
    // The panel is the whole plugin, and it is there.
    expect(store!.readPanel("quiet-plugin", "main")?.schema).toMatchObject({ title: "Quiet" });
    expect(supervisors.built.some((entry) => entry.pluginId === "quiet-plugin")).toBe(false);
  });

  it("leaves a panel the plugin published alone until the code changes", async () => {
    const source = copyFixture();
    const { plugins, store } = await hostWithFixture({ source });

    // What a running plugin publishes outranks its shipped default.
    store!.updatePanel("hello-plugin", "main", { schema: { v: 1, title: "Live" }, vocabVersion: 1 });
    await plugins.enable({ pluginId: "hello-plugin" });
    expect(store!.readPanel("hello-plugin", "main")?.schema).toMatchObject({ title: "Live" });

    // A reload is the `ade plugin dev` loop: the author edits the SOURCE, the
    // reload copies it over the installed tree, and the file on disk is then
    // newer than anything the last run published, so it replaces it.
    fs.writeFileSync(
      path.join(source, "panels", "main.json"),
      JSON.stringify({ v: 1, title: "Edited", fallback: { title: "Edited", text: "x" }, body: [] }),
      "utf8",
    );
    await plugins.reload({ pluginId: "hello-plugin" });
    expect(store!.readPanel("hello-plugin", "main")?.schema).toMatchObject({ title: "Edited" });
  });

  it("restarts the child on reload and runs the manifest that is on disk now", async () => {
    const source = copyFixture();
    const { plugins, pluginsRoot, supervisors } = await hostWithFixture({ source });
    const before = supervisors.latest("hello-plugin")!;
    expect(before.disposals).toBe(0);

    // The `ade plugin dev` loop edits the SOURCE tree. Nothing has copied it
    // over the install yet, so the registry still records what was installed.
    const manifestPath = path.join(source, "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.version = "0.2.0";
    manifest.sockets = [
      ...(manifest.sockets as unknown[]),
      { socket: "row-badge", surface: "prs", id: "pr-greeting", label: "Greeting" },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const recordedVersion = () => (JSON.parse(
      fs.readFileSync(path.join(pluginsRoot, "state.json"), "utf8"),
    ) as { plugins: Record<string, { version: string }> }).plugins["hello-plugin"]!.version;
    expect(recordedVersion()).toBe("0.1.0");

    const summary = await plugins.reload({ pluginId: "hello-plugin" });

    // (a) The child that was holding the old code is gone, and a fresh one is
    // running in its place — a reload that only re-read the manifest would
    // leave the previous build answering every invoke.
    expect(before.disposals).toBe(1);
    const after = supervisors.latest("hello-plugin")!;
    expect(after).not.toBe(before);
    expect(after.starts).toBe(1);
    expect(after.status()).toBe("running");

    // (b) The manifest was re-read, and the re-read is what the host now
    // reports AND what it persisted: the registry's cached version had drifted
    // from disk, and this is the write that heals it.
    expect(summary.version).toBe("0.2.0");
    expect(recordedVersion()).toBe("0.2.0");
    const sockets = (await plugins.getManifest({ pluginId: "hello-plugin" }))?.sockets ?? [];
    expect(sockets.map((socket) => socket.id)).toEqual(["greeting", "pr-greeting"]);

    // (c) The other half of the split: the SOURCE is the truth for a local
    // install, so an edit made directly in the install directory does not
    // survive the next reload — the copy is a full replace, as an install is.
    fs.writeFileSync(
      path.join(pluginsRoot, "hello-plugin", "plugin.json"),
      JSON.stringify({ ...manifest, version: "0.9.9-hand-edited" }, null, 2),
      "utf8",
    );
    expect((await plugins.reload({ pluginId: "hello-plugin" })).version).toBe("0.2.0");
  });

  it("re-reads the install directory in place for a plugin with no local source", async () => {
    // The behaviour SPLIT, pinned. A `git` or bundled install has no folder on
    // this machine to re-copy from and nothing fetches on a reload, so the
    // install directory stays the truth for it and an edit there is what runs.
    // Reading the source kind wrong in either direction is a silent bug: a
    // local plugin serving stale bytes, or a git plugin losing its own tree.
    const { plugins, pluginsRoot, supervisors } = await hostWithFixture();
    const before = supervisors.latest("hello-plugin")!;

    // Rewrite the record as a git install, the way a clone would have left it.
    const statePath = path.join(pluginsRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      plugins: Record<string, { source: unknown }>;
    };
    state.plugins["hello-plugin"]!.source = { kind: "git", url: "https://example.test/hello.git" };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

    const manifestPath = path.join(pluginsRoot, "hello-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.version = "0.3.0";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const summary = await plugins.reload({ pluginId: "hello-plugin" });

    expect(summary.version).toBe("0.3.0");
    expect(summary.warnings).toEqual([]);
    // Still a real reload: the child is replaced either way.
    expect(before.disposals).toBe(1);
    expect(supervisors.latest("hello-plugin")).not.toBe(before);
  });

  it("stops the running child before an install replaces its directory", async () => {
    const { plugins, supervisors } = await hostWithFixture();
    const first = supervisors.latest("hello-plugin")!;
    expect(first.disposals).toBe(0);

    await plugins.install({ source: fixtureRoot });

    // The old child is gone rather than left running against a directory that
    // was renamed out from under it, and a fresh one took its place.
    expect(first.disposals).toBe(1);
    const second = supervisors.latest("hello-plugin")!;
    expect(second).not.toBe(first);
    expect(second.starts).toBe(1);
  });

  it("does not reset another plugin's live panel when a different plugin installs (R1)", async () => {
    // `codelessPluginDir` seeds itself as `quiet-plugin`; `hostWithFixture`
    // then installs it as plugin B, and this test installs `hello-plugin`
    // (plugin A) a second time on top. `reconcile`'s `replacePanelsFor` must
    // name ONLY the plugin that just changed — a bare boolean would have
    // clobbered every OTHER installed plugin's live panel with its shipped
    // default on someone else's install.
    const { plugins, store } = await hostWithFixture({ source: codelessPluginDir() });
    store!.updatePanel("quiet-plugin", "main", { schema: { v: 1, title: "Live from quiet-plugin" }, vocabVersion: 1 });
    expect(store!.readPanel("quiet-plugin", "main")?.schema).toMatchObject({ title: "Live from quiet-plugin" });

    await plugins.install({ source: fixtureRoot });

    expect(store!.readPanel("quiet-plugin", "main")?.schema).toMatchObject({ title: "Live from quiet-plugin" });
  });

  it("corrects a stale mobile flag on a live panel without replacing its content", async () => {
    // `mobile` is the host's answer, not the plugin's: it moves when a manifest
    // changes it or a new ADE resolves it differently. A codeless plugin never
    // republishes, so a convergence pass has to fix the flag in place —
    // otherwise the phone keeps listing a panel the manifest has taken off it,
    // forever. Fixing it must not cost the live content, which is the whole
    // reason a plain pass does not replace panels.
    const { plugins, store } = await hostWithFixture({ source: codelessPluginDir() });
    store!.updatePanel("quiet-plugin", "main", {
      schema: { v: 1, title: "Live" },
      vocabVersion: 1,
      mobile: false,
    });
    expect(store!.readPanel("quiet-plugin", "main")?.schema).toMatchObject({ title: "Live", mobile: false });

    await plugins.enable({ pluginId: "quiet-plugin" });

    // The manifest's tab surface says nothing about mobile, so it is mobile.
    expect(store!.readPanel("quiet-plugin", "main")?.schema).toMatchObject({ title: "Live", mobile: true });
  });

  it("tells running plugins that the install set moved", async () => {
    vi.useFakeTimers();
    try {
      const { plugins, supervisors } = await hostWithFixture();
      const running = supervisors.latest("hello-plugin")!;
      running.sent.length = 0;

      await plugins.disable({ pluginId: "hello-plugin" });
      await plugins.enable({ pluginId: "hello-plugin" });
      vi.runOnlyPendingTimers();

      // `sdk.events.on("install.changed")` is documented, and this is the frame
      // that makes it fire: before it, no host ever sent an event frame.
      const live = supervisors.latest("hello-plugin")!;
      expect(live.sent).toContainEqual({
        type: "event",
        payload: { event: "install.changed", ids: ["hello-plugin"], projectId: "project-1" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("flags overflow rather than silently truncating an install burst past the id cap", async () => {
    vi.useFakeTimers();
    try {
      const { supervisors } = await hostWithFixture();
      const running = supervisors.latest("hello-plugin")!;
      running.sent.length = 0;

      // 55 distinct plugin ids in one coalescing window — well past the
      // 50-id cap `flushInstallEvent` carries per delivery. Before `overflow`
      // existed, the ids past 50 vanished with nothing on the wire to say so.
      for (let index = 0; index < 55; index += 1) {
        emitPluginChange({ kind: "installs", pluginId: `synthetic-${index}` });
      }
      vi.runOnlyPendingTimers();

      const frame = running.sent.find(
        (entry): entry is { type: "event"; payload: PluginEventPayload } =>
          entry.type === "event" && entry.payload.event === "install.changed",
      );
      expect(frame?.payload.ids).toHaveLength(50);
      expect(frame?.payload.overflow).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Observe-only runtime hooks, at the host's end.
 *
 * The chat runtime's half is pinned in `chat/pluginRuntimeHookObserver.test.ts`.
 * What this side owes is the delivery contract, and all four of these are
 * requirements rather than implementation details: a hook reaches only the
 * children that asked for it, it never touches the emitter's stack, a child
 * that stopped reading loses its hooks instead of holding the turn, and a
 * restarted child does not inherit the subscriptions of the process it
 * replaced.
 */
describe("runtime hook fan-out", () => {
  afterEach(async () => {
    resetPluginRuntimeHookListenersForTests();
    await closeScratch();
  });

  const turnStart = (): void => {
    emitPluginRuntimeHook({
      event: "turn.start",
      sessionId: "session-1",
      projectRoot: null,
      runtime: "claude",
    });
  };

  const hookFrames = (supervisor: RecordedSupervisor): PluginRuntimeHookPayload[] => supervisor.sent
    .filter((entry): entry is { type: "event"; payload: PluginRuntimeHookPayload } =>
      entry.type === "event" && entry.payload.event !== "install.changed")
    .map((entry) => entry.payload);

  it("delivers a hook only to the children that subscribed to that kind", async () => {
    vi.useFakeTimers();
    try {
      const { supervisors } = await hostWithFixture();
      const child = supervisors.latest("hello-plugin")!;
      child.sent.length = 0;

      // Nobody has called `ade.events.on("turn.start")` yet. `tool.before`
      // fires dozens of times a turn, so a plugin that never asked must not be
      // written to at all — not written to and ignored, not written to at all.
      turnStart();
      vi.runOnlyPendingTimers();
      expect(hookFrames(child)).toEqual([]);

      // A different kind is not this kind: subscribing to tool.before must not
      // start turn.start deliveries.
      await child.sdk("events.subscribe", { event: "tool.before", subscribed: true });
      turnStart();
      vi.runOnlyPendingTimers();
      expect(hookFrames(child)).toEqual([]);

      await child.sdk("events.subscribe", { event: "turn.start", subscribed: true });
      turnStart();
      vi.runOnlyPendingTimers();
      expect(hookFrames(child)).toEqual([
        { event: "turn.start", sessionId: "session-1", projectId: null, runtime: "claude" },
      ]);

      // And the unsubscribe half: dropping the last listener stops the writes
      // rather than merely making the child ignore them.
      child.sent.length = 0;
      await child.sdk("events.subscribe", { event: "turn.start", subscribed: false });
      turnStart();
      vi.runOnlyPendingTimers();
      expect(hookFrames(child)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves the turn's project from the host's own bindings", async () => {
    vi.useFakeTimers();
    try {
      const { supervisors, projectRoot } = await hostWithFixture();
      const child = supervisors.latest("hello-plugin")!;
      await child.sdk("events.subscribe", { event: "turn.end", subscribed: true });
      child.sent.length = 0;

      emitPluginRuntimeHook({
        event: "turn.end",
        sessionId: "session-1",
        projectRoot,
        runtime: "codex",
        outcome: "error",
        durationMs: 1_200,
      });
      // A checkout no host has a binding for answers null rather than
      // borrowing whichever project the plugin happens to be scoped to.
      emitPluginRuntimeHook({
        event: "turn.end",
        sessionId: "session-2",
        projectRoot: "/somewhere/else",
        runtime: "codex",
        outcome: "completed",
      });
      vi.runOnlyPendingTimers();

      expect(hookFrames(child)).toEqual([
        {
          event: "turn.end",
          sessionId: "session-1",
          projectId: "project-1",
          runtime: "codex",
          outcome: "error",
          durationMs: 1_200,
        },
        {
          event: "turn.end",
          sessionId: "session-2",
          projectId: null,
          runtime: "codex",
          outcome: "completed",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never writes to a child on the emitter's own stack", async () => {
    vi.useFakeTimers();
    try {
      const { supervisors } = await hostWithFixture();
      const child = supervisors.latest("hello-plugin")!;
      await child.sdk("events.subscribe", { event: "tool.before", subscribed: true });
      child.sent.length = 0;

      // This is the decoupling that makes the tier safe. `emitPluginRuntimeHook`
      // is called from inside the commit path that writes the user's
      // transcript; if a write to a child happened here, the cost of every
      // plugin on the machine would land on the turn loop.
      for (let index = 0; index < 5; index += 1) {
        emitPluginRuntimeHook({
          event: "tool.before",
          sessionId: "session-1",
          projectRoot: null,
          runtime: "claude",
          toolName: "Bash",
        });
      }
      expect(child.sent).toEqual([]);

      vi.runOnlyPendingTimers();
      expect(hookFrames(child)).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops and counts rather than queueing into a child that stopped reading", async () => {
    vi.useFakeTimers();
    const logger = testLogger();
    try {
      const { supervisors } = await hostWithFixture({ logger });
      const child = supervisors.latest("hello-plugin")!;
      await child.sdk("events.subscribe", { event: "tool.before", subscribed: true });
      child.sent.length = 0;

      // 300 tool calls in one tick — past the 256-frame queue cap. A wedged
      // child (one stopped at a debugger, one looping synchronously) keeps
      // accepting writes into a buffer it never drains, so the ceiling has to
      // be the host's, not the pipe's.
      child.acceptsWrites = false;
      for (let index = 0; index < 300; index += 1) {
        emitPluginRuntimeHook({
          event: "tool.before",
          sessionId: "session-1",
          projectRoot: null,
          runtime: "claude",
          toolName: `tool-${index}`,
        });
      }
      vi.runOnlyPendingTimers();

      // One write attempted; it reported the buffer full, so the rest of the
      // queue went nowhere. 44 were refused entry at the cap, 255 more were
      // abandoned behind the failed write.
      expect(hookFrames(child)).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "plugin.runtime_hooks_dropped",
        expect.objectContaining({ pluginId: "hello-plugin", dropped: 299 }),
      );

      // And it recovers: a child that starts draining again is written to on
      // the next tick, with no restart and no resubscribe.
      child.acceptsWrites = true;
      child.sent.length = 0;
      emitPluginRuntimeHook({
        event: "tool.before",
        sessionId: "session-1",
        projectRoot: null,
        runtime: "claude",
        toolName: "Read",
      });
      vi.runOnlyPendingTimers();
      expect(hookFrames(child)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a child's subscriptions when its process goes away", async () => {
    vi.useFakeTimers();
    try {
      const { supervisors } = await hostWithFixture();
      const child = supervisors.latest("hello-plugin")!;
      await child.sdk("events.subscribe", { event: "turn.start", subscribed: true });
      child.sent.length = 0;

      // A crashed child has forgotten every listener it registered and will
      // register them again from `activate`. Holding the host's copy across
      // that would leave a plugin subscribed to hooks its new process has no
      // listener for — deliveries nobody reads, charged to every turn.
      emitPluginChange({ kind: "status", pluginId: "hello-plugin", status: "crashed" });
      turnStart();
      vi.runOnlyPendingTimers();
      expect(hookFrames(child)).toEqual([]);

      await child.sdk("events.subscribe", { event: "turn.start", subscribed: true });
      turnStart();
      vi.runOnlyPendingTimers();
      expect(hookFrames(child)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an event name it does not know instead of subscribing to nothing", async () => {
    const { supervisors } = await hostWithFixture();
    const child = supervisors.latest("hello-plugin")!;
    // A plugin that typo'd a kind would otherwise subscribe successfully and
    // wait forever for an event that does not exist.
    await expect(child.sdk("events.subscribe", { event: "turn.starrt", subscribed: true }))
      .rejects.toMatchObject({ code: "invalid_args" });
  });
});

/**
 * A remote peer's `plugins.install`/`uninstall`/`enable`/`disable` reach the
 * host through `pluginInstallServiceAdapter`, not through `domainService`
 * directly — `requirePluginInstallService()` is exactly the handle
 * `syncRemoteCommandService.ts` resolves to answer those actions from another
 * machine. Before `afterChange` was wired, the adapter only ever touched the
 * install REGISTRY: nothing stopped the old child, no codeless plugin's
 * declared panels were seeded, and an uninstall left the child running with
 * its data and secrets intact.
 */
describe("remote install lifecycle through the sync adapter (R2)", () => {
  afterEach(closeScratch);

  it("seeds a codeless plugin's declared panels on a remote install, exactly as a local one does", async () => {
    const { store } = await hostWithFixture();
    const remote = requirePluginInstallService();

    const record = await remote.install({ kind: "path", path: codelessPluginDir() });

    expect(record.pluginId).toBe("quiet-plugin");
    // `install()` alone never reads a manifest's declared panels — only
    // `afterChange` reconciling with `replacePanelsFor` makes this appear.
    expect(store!.readPanel("quiet-plugin", "main")?.schema).toMatchObject({ title: "Quiet" });
  });

  it("stops the old child on a remote install of an existing plugin, not just the registry row", async () => {
    const { supervisors } = await hostWithFixture();
    const remote = requirePluginInstallService();
    const first = supervisors.latest("hello-plugin")!;

    await remote.install({ kind: "path", path: fixtureRoot });

    expect(first.disposals).toBe(1);
    const second = supervisors.latest("hello-plugin")!;
    expect(second).not.toBe(first);
    expect(second.starts).toBe(1);
  });

  it("stops the child and frees data on a remote uninstall, not just the registry row", async () => {
    const { store, supervisors } = await hostWithFixture();
    const remote = requirePluginInstallService();
    const running = supervisors.latest("hello-plugin")!;
    store!.updatePanel("hello-plugin", "main", { schema: { v: 1, title: "Live" }, vocabVersion: 1 });
    expect(store!.readPanel("hello-plugin", "main")).not.toBeNull();

    await remote.uninstall("hello-plugin");

    expect(running.disposals).toBe(1);
    expect(store!.readPanel("hello-plugin", "main")).toBeNull();
  });

  it("drops the account connection the plugin owned, so a reinstall has to reconnect", async () => {
    // Uninstalling a plugin takes its whole vertical: pane, action domains,
    // skills — and the third-party connection it existed to hold. A Linear
    // token surviving the removal would be a credential on disk with nothing
    // left on the machine that could use it.
    const { host, plugins } = await hostWithFixture();
    const disconnected: string[] = [];
    host.setMachineContext({
      disconnectAccountsForPlugin: (pluginId) => {
        disconnected.push(pluginId);
      },
    });

    await plugins.uninstall({ pluginId: "hello-plugin" });

    expect(disconnected).toEqual(["hello-plugin"]);
  });

  it("still frees data and secrets when the account disconnect throws", async () => {
    const { host, plugins, store } = await hostWithFixture();
    host.setMachineContext({
      disconnectAccountsForPlugin: () => {
        throw new Error("credential store is unreachable");
      },
    });
    store!.updatePanel("hello-plugin", "main", { schema: { v: 1, title: "Live" }, vocabVersion: 1 });

    await expect(plugins.uninstall({ pluginId: "hello-plugin" })).resolves.toBeDefined();

    expect(store!.readPanel("hello-plugin", "main")).toBeNull();
  });

  it("stops a running child on a remote disable and restarts it on a remote enable", async () => {
    const { supervisors } = await hostWithFixture();
    const remote = requirePluginInstallService();
    const running = supervisors.latest("hello-plugin")!;

    await remote.setEnabled("hello-plugin", false);
    expect(running.disposals).toBe(1);
    expect(running.status()).toBe("stopped");

    await remote.setEnabled("hello-plugin", true);
    expect(supervisors.latest("hello-plugin")?.starts).toBe(1);
    expect(supervisors.latest("hello-plugin")?.status()).toBe("running");
  });
});

describe("install failure and race handling (R5, R6)", () => {
  afterEach(closeScratch);

  it("reconciles a plugin back up when its install fails after the old child already stopped (R5)", async () => {
    const { plugins, pluginsRoot, supervisors } = await hostWithFixture();
    expect(supervisors.latest("hello-plugin")?.status()).toBe("running");

    // `beforeReplace` has already stopped the running child by the time the
    // rename itself fails — nothing in `pluginInstallService` knows how to
    // restart a plugin; only `reconcile` (via the host's catch) does.
    //
    // Targeted at THIS install root rather than at the next rename to happen:
    // an install also refreshes the machine's registry index cache, which is
    // written atomically, and a bare `mockImplementationOnce` failed that write
    // instead — where it is caught and ignored — leaving the real rename to
    // succeed and the test asserting a rejection that never came.
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).startsWith(pluginsRoot)) throw new Error("simulated rename failure");
      realRename(from, to);
    });
    try {
      await expect(plugins.install({ source: fixtureRoot })).rejects.toThrow(/simulated rename failure/);
    } finally {
      renameSpy.mockRestore();
    }

    // The child `beforeReplace` stopped is back up, not left stopped with
    // nothing having noticed the install failed.
    expect(supervisors.latest("hello-plugin")?.status()).toBe("running");
  });

  it("stops a supervisor a racing reconcile resurrected mid-install, unconditionally (R6)", async () => {
    const { plugins, host, supervisors } = await hostWithFixture();
    const first = supervisors.latest("hello-plugin")!;
    const originalDispose = first.dispose;
    let raced = false;
    // `beforeReplace` stops `first` before the rename. While that dispose is
    // in flight — the old directory is still fully on disk — simulate an
    // unrelated `attachProject` (equally: another `enable`/`setConfig`)
    // landing in the same window and reconciling, which resurrects a
    // supervisor for "hello-plugin" from whatever is on disk at that instant.
    first.dispose = async () => {
      await originalDispose();
      if (!raced) {
        raced = true;
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-race-"));
        scratchDirs.push(projectRoot);
        const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), silentLogger());
        openDatabases.push(db);
        host.attachProject({ projectId: "race-project", projectRoot, db, invokeAdeAction: async () => null });
      }
    };

    await plugins.install({ source: fixtureRoot });

    const raceEntries = supervisors.built.filter((entry) => entry.pluginId === "hello-plugin");
    // The original, the race-resurrected one, and the final one from the
    // install's own reconcile: at least three distinct supervisor objects.
    expect(raceEntries.length).toBeGreaterThanOrEqual(3);
    const latest = supervisors.latest("hello-plugin")!;
    // Nothing but the very last one survives — including the one the race
    // brought back, which an "only if the id changed" stop would have missed.
    for (const entry of raceEntries) {
      if (entry === latest) continue;
      expect(entry.disposals).toBeGreaterThanOrEqual(1);
    }
    expect(latest.status()).toBe("running");
    expect(latest.starts).toBe(1);
  });
});

/**
 * `listContributions` — the dynamic half of the socket taxonomy.
 *
 * The fixture declares one socket: a `row-badge` on `lanes`, id `greeting`.
 * Everything here turns on the manifest join, because the table stores a socket
 * KIND and only the manifest says which surface it belongs to.
 */
describe("plugin.listContributions", () => {
  afterEach(closeScratch);

  async function hostWithProject(options: { source?: string; logger?: Logger } = {}) {
    const { plugins, pluginsRoot, store, db } = await hostWithFixture(options);
    return { plugins, pluginsRoot, store: store!, db: db! };
  }

  it("returns only the sockets the manifest declares for the surface asked for", async () => {
    const { plugins, store } = await hostWithProject();

    store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "3 refs", tone: "accent" });

    const lanes = await plugins.listContributions({ surface: "lanes" });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({
      pluginId: "hello-plugin",
      entityKind: "lane",
      entityId: "lane-1",
      socket: "row-badge",
      surface: "lanes",
      // The manifest socket id, which the row itself does not carry — it is
      // what per-socket toggles and ordering key on.
      socketId: "greeting",
      payload: { text: "3 refs", tone: "accent" },
    });

    // The same row is not a PRs contribution: this plugin declares no PR socket.
    expect(await plugins.listContributions({ surface: "prs" })).toEqual([]);
  });

  it("drops a row whose entityKind is not one of the closed list, rather than passing it through (NEW-B2)", async () => {
    const { plugins, store } = await hostWithProject();
    // Simulates a row this build predates (a future entity kind) or a
    // corrupted one — nothing upstream of this read restricts `entityKind`
    // the way a manifest-declared `socket` is restricted, so this is the one
    // guard `listContributions` cannot get for free from the `declared` map
    // lookup.
    store.publishContribution("hello-plugin", "not-a-real-kind" as never, "x-1", "row-badge", { text: "ok", tone: "success" });
    store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "ok", tone: "success" });

    const lanes = await plugins.listContributions({ surface: "lanes" });

    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ entityKind: "lane", entityId: "lane-1" });
  });

  it("drops rows whose socket the user switched off, and restores them when re-enabled", async () => {
    const { plugins, store } = await hostWithProject();
    store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "ok", tone: "success" });

    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "greeting", enabled: false });
    expect(await plugins.listContributions({ surface: "lanes" })).toEqual([]);

    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "greeting", enabled: true });
    expect(await plugins.listContributions({ surface: "lanes" })).toHaveLength(1);
  });

  /**
   * Two declarations of one kind, on one surface.
   *
   * The join used to key on `pluginId + socket KIND`, so the second
   * declaration overwrote the first and every published badge row was stamped
   * with whichever the manifest happened to list LAST. That made the two
   * per-contribution toggles the same switch, and it made this machine
   * disagree with the phone, which resolves per declaration.
   */
  describe("two declarations of one socket kind", () => {
    const twoBadges = () => fixtureWithSockets([
      { socket: "row-badge", surface: "lanes", id: "risk", label: "Risk" },
      { socket: "row-badge", surface: "lanes", id: "size", label: "Size" },
    ]);

    /**
     * Written straight to the table, because that is the ONLY way such a row
     * exists.
     *
     * `contributions.publish` takes no socket id, and the data store re-encodes
     * the payload through `parsePluginContributionPayload`, whose per-kind
     * whitelist drops `id`. So a desktop plugin cannot address a declaration
     * through the SDK at all. What CAN carry one is a row written by a client
     * that did not go through this host's publish path — the phone writes
     * `plugin_contributions` through cr-sqlite directly, and those rows sync
     * here. That is the case these cover, and it is why the renderer's
     * `contributionsFromRows` has always read `raw.id`.
     *
     * What `id` does NOT buy is capacity. `plugin_contributions` is keyed
     * `(entity_kind, entity_id, plugin_id, socket)`, so one entity holds ONE
     * published value per socket kind and a second publish replaces the first
     * — from any client, synced or local. So `id` selects WHICH of the two
     * declarations the surviving row fills; it never lets both hold a value
     * for one lane. That is why the cases below put their two rows on two
     * different lanes. Lifting the limit is a CRR migration, deferred to
     * PLUGINABILITY.md Wave 5.
     */
    function writeSyncedRow(db: AdeDb, entityId: string, payload: Record<string, unknown>): void {
      publishPluginContribution(db as unknown as Parameters<typeof publishPluginContribution>[0], {
        entityKind: "lane",
        entityId,
        pluginId: "hello-plugin",
        socket: "row-badge",
        payloadJson: JSON.stringify(payload),
        nowIso: "2026-08-13T00:00:00.000Z",
      });
    }

    it("resolves each row to the declaration its payload names", async () => {
      const { plugins, db } = await hostWithProject({ source: twoBadges() });

      writeSyncedRow(db, "lane-1", { id: "risk", text: "High", tone: "warning" });
      writeSyncedRow(db, "lane-2", { id: "size", text: "XL", tone: "neutral" });

      const lanes = await plugins.listContributions({ surface: "lanes" });
      expect(lanes).toHaveLength(2);
      expect(lanes.map((row) => [row.entityId, row.socketId]).sort()).toEqual([
        ["lane-1", "risk"],
        ["lane-2", "size"],
      ]);
    });

    it("gives the two contributions independent toggles", async () => {
      const { plugins, db } = await hostWithProject({ source: twoBadges() });
      writeSyncedRow(db, "lane-1", { id: "risk", text: "High", tone: "warning" });
      writeSyncedRow(db, "lane-2", { id: "size", text: "XL", tone: "neutral" });

      await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "risk", enabled: false });

      // Switching off Risk must not take Size with it. Before the fix both rows
      // resolved to whichever declaration the manifest listed last, so one
      // switch governed both and the other switch did nothing.
      const lanes = await plugins.listContributions({ surface: "lanes" });
      expect(lanes.map((row) => row.socketId)).toEqual(["size"]);
    });

    it("drops a row naming a socket id the plugin no longer declares", async () => {
      const { plugins, db } = await hostWithProject({ source: twoBadges() });
      // Rows outlive a manifest edit and sync between machines. Adopting a
      // different declaration would move the row to a slot its author never
      // chose, which is the same guessing the ambiguous case refuses.
      writeSyncedRow(db, "lane-1", { id: "removed", text: "?", tone: "neutral" });

      expect(await plugins.listContributions({ surface: "lanes" })).toEqual([]);
    });

    it("refuses to guess for an id-less row, and tells the author once", async () => {
      const { logger, warnings } = recordingLogger();
      const { plugins, store } = await hostWithProject({ source: twoBadges(), logger });

      store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "High", tone: "warning" });
      store.publishContribution("hello-plugin", "lane", "lane-2", "row-badge", { text: "XL", tone: "neutral" });

      // No non-arbitrary answer exists, so the rows are left unmatched rather
      // than adopted by whichever declaration sorted last.
      expect(await plugins.listContributions({ surface: "lanes" })).toEqual([]);

      // Once per (plugin, kind), not once per row — a surface asks for this on
      // every render.
      const ambiguous = warnings.filter((entry) => entry.event === "plugin.contribution_id_ambiguous");
      expect(ambiguous).toHaveLength(1);
      expect(ambiguous[0]?.detail).toMatchObject({
        pluginId: "hello-plugin",
        socket: "row-badge",
        surface: "lanes",
      });
    });
  });

  it("keeps resolving an id-less row when its kind is declared exactly once", async () => {
    const { logger, warnings } = recordingLogger();
    const { plugins, store } = await hostWithProject({ logger });
    // The checked-in fixture declares one `row-badge`. An id-less row is
    // unambiguous there, so it resolves exactly as it always has — this is the
    // path every shipped plugin is on, and it must not have changed.
    store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "3 refs", tone: "accent" });

    const lanes = await plugins.listContributions({ surface: "lanes" });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ socketId: "greeting", entityId: "lane-1" });
    expect(warnings.filter((entry) => entry.event === "plugin.contribution_id_ambiguous")).toEqual([]);
  });

  it("drops rows from a disabled plugin and narrows by entity kind", async () => {
    const { plugins, store } = await hostWithProject();
    store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "ok", tone: "success" });

    expect(await plugins.listContributions({ surface: "lanes", entityKind: "pr" })).toEqual([]);
    expect(await plugins.listContributions({ surface: "lanes", entityKind: "lane" })).toHaveLength(1);

    await plugins.disable({ pluginId: "hello-plugin" });
    // A disabled plugin contributes nothing, without anything having to delete
    // its rows — they come back untouched when it is enabled again.
    expect(await plugins.listContributions({ surface: "lanes" })).toEqual([]);
  });
});

/**
 * Uninstall has to reach the one piece of plugin state that keeps ACTING.
 *
 * Rows and secrets left behind are inert clutter; a surviving schedule wakes a
 * plugin that is no longer installed, on a timer the user has no surface left
 * to cancel it from. This is the concrete reason plugin schedules are owned
 * rather than borrowed — a chat cron a plugin created through
 * `chat.createScheduledWork` carries no owner and could not be found here.
 */
/**
 * The per-contribution toggle, enforced where the action RUNS.
 *
 * The rail's switch used to reach only the surfaces that draw the contribution.
 * Everything else that can call `plugin.invoke` — the phone, the CLI, a
 * renderer holding a stale menu — went straight past it, so a user who turned
 * a contribution off could still be one deeplink away from running it.
 */
describe("plugin.invoke honours disabledContributions", () => {
  afterEach(closeScratch);

  /** Two contributions, one shared action, plus an action nothing declares. */
  const sharedActionFixture = () => fixtureWithSockets([
    { socket: "row-badge", surface: "lanes", id: "risk", label: "Risk", actionId: "openIssue" },
    { socket: "row-menu-item", surface: "lanes", id: "menu", label: "Open", actionId: "openIssue" },
  ]);

  it("refuses the action once EVERY contribution offering it is switched off", async () => {
    const { plugins } = await hostWithFixture({ source: sharedActionFixture() });

    // One off: the other contribution still offers the action, so a toggle on
    // the badge must not disable the menu item's button.
    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "risk", enabled: false });
    await expect(plugins.invoke({ pluginId: "hello-plugin", action: "openIssue" })).resolves.toBeNull();

    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "menu", enabled: false });
    await expect(plugins.invoke({ pluginId: "hello-plugin", action: "openIssue" }))
      .rejects.toMatchObject({ code: "not_permitted" });
  });

  it("leaves an action no contribution declares alone", async () => {
    const { plugins } = await hostWithFixture({ source: sharedActionFixture() });
    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "risk", enabled: false });
    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "menu", enabled: false });

    // A handler reached from a schedule or a CLI word has no toggle to obey.
    await expect(plugins.invoke({ pluginId: "hello-plugin", action: "syncNow" })).resolves.toBeNull();
  });

  it("re-enabling a contribution restores the action", async () => {
    const { plugins } = await hostWithFixture({ source: sharedActionFixture() });
    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "risk", enabled: false });
    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "menu", enabled: false });
    await expect(plugins.invoke({ pluginId: "hello-plugin", action: "openIssue" })).rejects.toThrow();

    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "menu", enabled: true });
    await expect(plugins.invoke({ pluginId: "hello-plugin", action: "openIssue" })).resolves.toBeNull();
  });
});

describe("uninstall sweeps a plugin's schedules", () => {
  afterEach(closeScratch);

  const readSchedules = (pluginsRoot: string): { pluginId: string }[] => {
    const file = path.join(pluginsRoot, "schedules.json");
    if (!fs.existsSync(file)) return [];
    return (JSON.parse(fs.readFileSync(file, "utf8")).schedules ?? []) as { pluginId: string }[];
  };

  /**
   * Seeds the ledger BEFORE the host exists. The schedule service reads its
   * file lazily on first use, and the host's own catch-up pass would otherwise
   * cache an empty list before the test could write one.
   */
  async function hostWithSeededSchedules() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-host-sched-"));
    scratchDirs.push(dir);
    const pluginsRoot = path.join(dir, "plugins");
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsRoot, "schedules.json"),
      JSON.stringify({
        version: 1,
        schedules: [
          {
            id: "plugin:hello-plugin:a",
            pluginId: "hello-plugin",
            action: "sync",
            kind: "cron",
            cron: "0 9 * * *",
            args: {},
            createdAt: "2026-08-13T00:00:00.000Z",
            // Far enough out that the host's catch-up pass never fires it.
            fireAt: Date.now() + 60 * 60 * 1000,
          },
          {
            id: "plugin:other-plugin:b",
            pluginId: "other-plugin",
            action: "sync",
            kind: "cron",
            cron: "0 9 * * *",
            args: {},
            createdAt: "2026-08-13T00:00:00.000Z",
            fireAt: Date.now() + 60 * 60 * 1000,
          },
        ],
      }),
      "utf8",
    );
    const host = getSharedPluginHostService({
      logger: testLogger(),
      pluginsRoot,
      createSupervisor: recordingSupervisors().create,
    });
    const plugins = host.domainService(null);
    await plugins.install({ source: fixtureRoot });
    return { plugins, pluginsRoot };
  }

  it("removes the uninstalled plugin's schedules and leaves every other plugin's alone", async () => {
    const { plugins, pluginsRoot } = await hostWithSeededSchedules();
    expect(readSchedules(pluginsRoot)).toHaveLength(2);

    await plugins.uninstall({ pluginId: "hello-plugin" });

    expect(readSchedules(pluginsRoot).map((row) => row.pluginId)).toEqual(["other-plugin"]);
  });
});

/**
 * Presence is the one leftover another COMPUTER can see.
 *
 * Collections, contributions and panels left behind are inert clutter in a
 * database only this machine reads. A surviving `plugin_presence` row is a
 * statement broadcast to the account: this machine still has that plugin,
 * enabled — which is the exact stale signal the coverage matrix exists to
 * prevent. The republish the uninstall action already runs cannot be relied on
 * to reach here: it goes through the presence service, which holds ONE
 * project's database, while these rows sit in every project this machine has
 * attached.
 */
describe("uninstall clears this machine's presence rows", () => {
  afterEach(closeScratch);

  const otherPlugin = {
    pluginId: "other-plugin",
    version: "1.0.0",
    enabled: true,
    displayName: "Other",
    icon: "",
    accent: "",
  };

  const presenceIn = (db: AdeDb, machineKey: string): string[] =>
    readAllPluginPresence(db)
      .filter((row) => row.machineKey === machineKey)
      .map((row) => row.pluginId);

  it("drops the uninstalled plugin's row and leaves other plugins and other machines alone", async () => {
    const { host, plugins, db } = await hostWithFixture();
    host.setMachineContext({ localMachineKey: () => "machine-a" });
    replacePluginPresenceForMachine(
      db!,
      "machine-a",
      [{ ...otherPlugin, pluginId: "hello-plugin", displayName: "Hello" }, otherPlugin],
      "2026-08-14T07:19:03.919Z",
    );
    replacePluginPresenceForMachine(
      db!,
      "machine-b",
      [{ ...otherPlugin, pluginId: "hello-plugin", displayName: "Hello" }],
      "2026-08-14T07:19:03.919Z",
    );

    await plugins.uninstall({ pluginId: "hello-plugin" });

    expect(presenceIn(db!, "machine-a")).toEqual(["other-plugin"]);
    // Another machine having the plugin is not this uninstall's business.
    expect(presenceIn(db!, "machine-b")).toEqual(["hello-plugin"]);
  });

  it("records the removal as a replicated change, so peers stop reporting the plugin", async () => {
    const { host, plugins, db } = await hostWithFixture();
    host.setMachineContext({ localMachineKey: () => "machine-a" });
    replacePluginPresenceForMachine(
      db!,
      "machine-a",
      [{ ...otherPlugin, pluginId: "hello-plugin", displayName: "Hello" }],
      "2026-08-14T07:19:03.919Z",
    );
    const changes = (): number => db!.get<{ count: number }>(
      "select count(*) as count from crsql_changes where \"table\" = 'plugin_presence'",
    )?.count ?? 0;
    const before = changes();

    await plugins.uninstall({ pluginId: "hello-plugin" });

    expect(changes()).not.toBe(before);
    expect(changes()).toBeGreaterThan(0);
  });

  it("leaves every machine's rows alone when this machine has no account key", async () => {
    // An unpaired machine has no key. Sweeping by plugin id alone would delete
    // rows belonging to computers that never uninstalled anything.
    const { host, plugins, db } = await hostWithFixture();
    host.setMachineContext({ localMachineKey: () => null });
    replacePluginPresenceForMachine(
      db!,
      "machine-b",
      [{ ...otherPlugin, pluginId: "hello-plugin", displayName: "Hello" }],
      "2026-08-14T07:19:03.919Z",
    );

    await plugins.uninstall({ pluginId: "hello-plugin" });

    expect(presenceIn(db!, "machine-b")).toEqual(["hello-plugin"]);
  });
});

/**
 * The last invoke per action, on `plugin.get`.
 *
 * Round-2 alpha finding #6: an action that silently did nothing and an action
 * that was never reached were indistinguishable from outside the host, so
 * `ade plugin doctor` could only report "0 rows published right now" for both
 * and the reader had to reproduce the press by hand to tell them apart.
 */
describe("plugin.get reports the last invoke per action", () => {
  afterEach(closeScratch);

  const lastInvokes = async (
    plugins: PluginDomainService,
  ): Promise<NonNullable<PluginDetail["lastInvokes"]>> => {
    const detail = await plugins.get({ pluginId: "hello-plugin" });
    return detail?.lastInvokes ?? [];
  };

  it("starts empty, then records the action that ran", async () => {
    const { plugins } = await hostWithFixture();
    expect(await lastInvokes(plugins)).toEqual([]);

    await plugins.invoke({ pluginId: "hello-plugin", action: "openIssue" });

    const recorded = await lastInvokes(plugins);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: "openIssue", ok: true });
    expect(recorded[0]!.errorCode).toBeUndefined();
    expect(Number.isFinite(Date.parse(recorded[0]!.at))).toBe(true);
  });

  it("records a REFUSED invoke with its code — a refusal is an attempt", async () => {
    const { plugins } = await hostWithFixture({
      source: fixtureWithSockets([
        { socket: "row-badge", surface: "lanes", id: "risk", label: "Risk", actionId: "openIssue" },
      ]),
    });
    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "risk", enabled: false });

    await expect(plugins.invoke({ pluginId: "hello-plugin", action: "openIssue" })).rejects.toThrow();

    expect(await lastInvokes(plugins)).toEqual([
      expect.objectContaining({ action: "openIssue", ok: false, errorCode: "not_permitted" }),
    ]);
  });

  it("keeps one row per action, newest first", async () => {
    const { plugins } = await hostWithFixture();
    await plugins.invoke({ pluginId: "hello-plugin", action: "openIssue" });
    await plugins.invoke({ pluginId: "hello-plugin", action: "syncNow" });
    await plugins.invoke({ pluginId: "hello-plugin", action: "openIssue" });

    expect((await lastInvokes(plugins)).map((entry) => entry.action)).toEqual(["openIssue", "syncNow"]);
  });

  it("forgets a plugin's history when it is uninstalled", async () => {
    // A reinstall that inherited the old history would answer "yes, it ran"
    // about code that is no longer on the machine.
    const { plugins } = await hostWithFixture();
    await plugins.invoke({ pluginId: "hello-plugin", action: "openIssue" });
    await plugins.uninstall({ pluginId: "hello-plugin" });
    await plugins.install({ source: fixtureRoot });

    expect(await lastInvokes(plugins)).toEqual([]);
  });
});
