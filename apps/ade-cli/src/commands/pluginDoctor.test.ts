import { describe, expect, it } from "vitest";

import {
  buildPluginDoctorReport,
  formatPluginDoctorReport,
  type PluginDoctorLayerKey,
  type PluginDoctorSnapshot,
} from "./pluginDoctor";
import type { PluginManifest } from "../../../desktop/src/shared/plugins/manifest";
import type {
  PluginContributionRecord,
  PluginDetail,
  PluginInstallRecord,
} from "../../../desktop/src/shared/plugins/sdk";

/**
 * The ladder, one rung at a time.
 *
 * Each case below is a state the alpha test actually produced and could not
 * explain: installed but switched off, running but contributing nothing,
 * contributing plenty and invisible on the phone, ADE not answering at all. The
 * assertion in every one is that the FIRST failing rung is the one that reads
 * as failed — a doctor whose lines all say the same thing is the status quo
 * this command exists to replace.
 */

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "ade-tipsy",
    version: "0.3.0",
    displayName: "Tipsy",
    description: "A drink counter.",
    vocabVersion: 1,
    entry: "index.js",
    surfaces: [],
    panels: [{ id: "main", schemaFile: "panels/main.json", title: "Tipsy" }],
    sockets: [
      { socket: "composer-action", surface: "work", id: "drink", label: "Take a drink", actionId: "drink" },
      { socket: "slash-command", surface: "work", id: "sober", command: "sober-up", actionId: "sober" },
    ],
    collections: {},
    settings: [],
    cli: ["status"],
    skills: [],
    tools: [],
    automationTriggers: [],
    automationSteps: [],
    searchProviders: [],
    keybindings: [],
    official: false,
    ...overrides,
  };
}

function record(overrides: Partial<PluginInstallRecord> = {}): PluginInstallRecord {
  return {
    pluginId: "ade-tipsy",
    version: "0.3.0",
    enabled: true,
    source: { kind: "git", url: "https://github.com/arul/ade-tipsy" },
    installedAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Partial<PluginDetail> = {}): PluginDetail {
  return {
    pluginId: "ade-tipsy",
    version: "0.3.0",
    displayName: "Tipsy",
    description: "A drink counter.",
    icon: null,
    accent: null,
    enabled: true,
    status: "running",
    warnings: [],
    errors: [],
    source: { kind: "git", url: "https://github.com/arul/ade-tipsy" },
    installedAt: "2026-08-14T00:00:00.000Z",
    hasEntry: true,
    surfaces: [],
    theme: null,
    cli: ["status"],
    restartCount: 0,
    lastCrashAt: null,
    manifest: null,
    settings: [],
    config: {},
    root: "/Users/arul/.ade-alpha/plugins/ade-tipsy",
    logs: [],
    lastInvokes: [{ action: "drink", at: "2026-08-25T11:58:00.000Z", ok: true }],
    ...overrides,
  };
}

/** Two minutes after the healthy fixture's last invoke. */
const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function contribution(): PluginContributionRecord {
  return {
    entityKind: "session",
    entityId: "session-1",
    pluginId: "ade-tipsy",
    socket: "composer-action",
    surface: "work",
    socketId: "drink",
    payload: { label: "3 drinks in!", actionId: "drink" },
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function healthy(overrides: Partial<PluginDoctorSnapshot> = {}): PluginDoctorSnapshot {
  return {
    pluginId: "ade-tipsy",
    record: record(),
    manifest: manifest(),
    manifestErrors: [],
    live: {
      detail: detail(),
      presence: [],
      contributions: [contribution()],
      usage: {
        pluginId: "ade-tipsy",
        collectionRows: 4,
        collectionBytes: 900,
        contributionRows: 1,
        panelRows: 1,
        syncBytesOut: 0,
        syncBytesIn: 0,
      },
    },
    ...overrides,
  };
}

function layer(snapshot: PluginDoctorSnapshot, key: PluginDoctorLayerKey) {
  const found = buildPluginDoctorReport(snapshot, NOW).layers.find((entry) => entry.key === key);
  if (!found) throw new Error(`no ${key} layer`);
  return found;
}

describe("buildPluginDoctorReport", () => {
  it("passes every rung for a plugin that is installed, on, running and publishing", () => {
    const report = buildPluginDoctorReport(healthy());
    expect(report.layers.filter((entry) => entry.state === "no")).toEqual([]);
    expect(layer(healthy(), "installed").detail).toContain("turned on");
    expect(layer(healthy(), "running").state).toBe("ok");
    expect(layer(healthy(), "synced").detail).toBe("1 place, 1 panel, 4 stored rows");
  });

  it("names the source, or says this computer has none", () => {
    expect(layer(healthy(), "source").detail).toBe("https://github.com/arul/ade-tipsy");
    expect(layer(healthy({ record: record({ source: { kind: "local", path: "/src/tipsy" } }) }), "source").detail)
      .toBe("the folder /src/tipsy");
    expect(layer(healthy({ record: null }), "source").state).toBe("no");
  });

  it("separates not installed here from installed and switched off", () => {
    const absent = layer(healthy({ record: null, manifest: null }), "installed");
    expect(absent.state).toBe("no");
    expect(absent.detail).toContain("ade plugin install");

    const off = layer(healthy({ record: record({ enabled: false }) }), "installed");
    expect(off.state).toBe("no");
    expect(off.detail).toContain("ade plugin enable ade-tipsy");
  });

  it("counts the other computers that have it on", () => {
    const snapshot = healthy();
    snapshot.live!.presence = [
      { machineKey: "m2", machineName: "Studio", pluginId: "ade-tipsy", version: "0.3.0", enabled: true, online: true, isThisMachine: false },
      { machineKey: "m1", machineName: "Laptop", pluginId: "ade-tipsy", version: "0.3.0", enabled: true, online: true, isThisMachine: true },
    ];
    expect(layer(snapshot, "installed").detail).toContain("also on 1 other computer");
  });

  it("reports a crashed child with the command that shows why", () => {
    const crashed = layer(healthy({
      live: { ...healthy().live!, detail: detail({ status: "crashed" }) },
    }), "running");
    expect(crashed.state).toBe("no");
    expect(crashed.detail).toContain("ade plugin logs ade-tipsy");
  });

  it("does not ask a code-free plugin to be running", () => {
    const themeOnly = healthy({
      manifest: manifest({ entry: undefined, sockets: [], panels: [] }),
    });
    expect(layer(themeOnly, "running").state).toBe("na");
  });

  it("counts declared places by kind and surface, beside the rows published now", () => {
    const places = layer(healthy(), "places");
    expect(places.state).toBe("ok");
    expect(places.detail).toContain("composer-action in work");
    expect(places.detail).toContain("slash-command in work");
    expect(places.detail).toContain("1 row published right now");
  });

  it("reads installed-with-no-contributions as not applicable, never as failure", () => {
    const noSockets = healthy({ manifest: manifest({ sockets: [] }) });
    const places = layer(noSockets, "places");
    expect(places.state).toBe("na");
    expect(places.detail).toContain("no place in ADE's own screens");
    expect(buildPluginDoctorReport(noSockets).renders).toBe("");
  });

  it("fails the places rung when the user has switched every one of them off", () => {
    const allOff = healthy({
      record: record({ disabledContributions: ["drink", "sober"] }),
    });
    const places = layer(allOff, "places");
    expect(places.state).toBe("no");
    expect(places.detail).toContain("2 switched off here");
  });

  it("says a panel is declared but never published", () => {
    const unpublished = healthy({
      live: { ...healthy().live!, usage: { ...healthy().live!.usage!, panelRows: 0 } },
    });
    const panels = layer(unpublished, "panels");
    expect(panels.state).toBe("no");
    expect(panels.detail).toContain("none published yet of 1 panel");
  });

  it("says nothing has reached this project's database yet", () => {
    const empty = layer(healthy({ live: { ...healthy().live!, usage: null } }), "synced");
    expect(empty.state).toBe("no");
    expect(empty.detail).toContain("other devices have nothing to show");
  });

  it("marks the live rungs unchecked rather than absent when ADE is not answering", () => {
    const offline = healthy({ live: null });
    for (const key of ["running", "panels", "synced"] as const) {
      expect(layer(offline, key).state).toBe("unknown");
      expect(layer(offline, key).detail).toContain("could not ask ADE");
    }
    // The registry half still answers with the app closed.
    expect(layer(offline, "source").state).toBe("ok");
    expect(layer(offline, "installed").state).toBe("ok");
    expect(layer(offline, "places").detail).toContain("published rows unknown");
  });

  it("carries the next-turn promise for a plugin shipping a skill, and stays quiet otherwise", () => {
    expect(layer(healthy(), "skills").state).toBe("na");
    const withSkill = layer(healthy({ manifest: manifest({ skills: ["skills/tipsy"] }) }), "skills");
    expect(withSkill.state).toBe("ok");
    expect(withSkill.detail).toContain("running turns keep their current behavior");
  });

  it("answers per client from the declared kinds, including the one the phone drops", () => {
    const report = buildPluginDoctorReport(healthy());
    expect(report.renders).toContain("desktop ✓ (composer-action, slash-command)");
    expect(report.renders).toContain("iPhone ✓ composer-action / ✗ slash-command (not drawn on phones)");
    expect(report.clients.find((entry) => entry.client === "tui")?.renders).toBe(false);
  });

  it("still reports a plugin this computer has never heard of", () => {
    const report = buildPluginDoctorReport({
      pluginId: "ade-tipsy",
      record: null,
      manifest: null,
      manifestErrors: [],
      live: { detail: null, presence: [], contributions: [], usage: null },
    });
    expect(report.displayName).toBe("ade-tipsy");
    expect(report.version).toBeNull();
    // Last run reads "unknown", not "no": ADE answered, but it has no plugin
    // to have run anything, and claiming "nothing ran" would be an assertion
    // about code that is not on this computer.
    expect(report.layers.map((entry) => entry.state)).toEqual([
      "no", "no", "no", "na", "unknown", "na", "no", "na",
    ]);
  });

  it("separates an action that never fired from one that fired and did nothing", () => {
    // Finding #6 of the round-2 alpha report: a press that silently did
    // nothing looked exactly like a press that never happened, because Places
    // said "1 row published right now" either way.
    const neverRan = layer(healthy({ live: { ...healthy().live!, detail: detail({ lastInvokes: [] }) } }), "lastRun");
    expect(neverRan.state).toBe("no");
    expect(neverRan.detail).toContain("no action has run since ADE started");
    // The suggestion has to be runnable as printed, action included.
    expect(neverRan.detail).toContain('"action":"drink"');

    const ran = layer(healthy(), "lastRun");
    expect(ran.state).toBe("ok");
    expect(ran.detail).toContain("drink ran 2 minutes ago");
    // `sober` and `status` are declared and have never run; saying so is what
    // stops "something ran" from reading as "everything ran".
    expect(ran.detail).toContain("2 actions never run");
  });

  it("names the failing action and its error code", () => {
    const failed = layer(
      healthy({
        live: {
          ...healthy().live!,
          detail: detail({
            lastInvokes: [{ action: "sober", at: "2026-08-25T11:59:00.000Z", ok: false, errorCode: "invalid_args" }],
          }),
        },
      }),
      "lastRun",
    );
    expect(failed.state).toBe("no");
    expect(failed.detail).toContain("sober failed 1 minute ago (invalid_args)");
  });

  it("says it cannot tell, rather than 'never', on a host that does not track runs", () => {
    const older = layer(
      healthy({ live: { ...healthy().live!, detail: detail({ lastInvokes: undefined }) } }),
      "lastRun",
    );
    expect(older.state).toBe("unknown");
    expect(older.detail).toContain("does not keep track");
  });

  it("counts every declared route to an action, not only sockets", () => {
    const report = buildPluginDoctorReport(healthy({
      manifest: manifest({
        cli: ["status"],
        tools: [{
          name: "getDrunkLevel",
          description: "How drunk?",
          input: { type: "object", properties: {}, required: [] },
          action: "level",
        }],
      }),
    }), NOW);
    const actions = Object.fromEntries(report.actions.map((entry) => [entry.action, entry.declaredBy]));
    expect(actions.drink).toEqual(["composer-action"]);
    expect(actions.status).toEqual(["cli"]);
    expect(actions.level).toEqual(["agent tool"]);
    expect(report.actions.find((entry) => entry.action === "drink")?.lastInvoke?.ok).toBe(true);
    expect(report.actions.find((entry) => entry.action === "status")?.lastInvoke).toBeNull();
  });

  it("marks a local source that has moved away, because a reload cannot re-copy it", () => {
    const gone = healthy({
      record: record({ source: { kind: "local", path: "/src/tipsy" } }),
      sourcePresent: false,
    });
    expect(layer(gone, "source").state).toBe("no");
    expect(layer(gone, "source").detail).toContain("gone, so a reload keeps running the installed copy");

    const present = healthy({
      record: record({ source: { kind: "local", path: "/src/tipsy" } }),
      sourcePresent: true,
    });
    expect(layer(present, "source").state).toBe("ok");
    expect(layer(present, "source").detail).toBe("the folder /src/tipsy");
  });
});

describe("formatPluginDoctorReport", () => {
  it("prints one aligned line per rung, then the per-client sentence", () => {
    const text = formatPluginDoctorReport(buildPluginDoctorReport(healthy()));
    expect(text.startsWith("Tipsy (ade-tipsy) 0.3.0\n")).toBe(true);
    expect(text).toContain("✓ Source        ");
    expect(text).toContain("Renders on: desktop ✓");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("draws a failed rung as ✗ and one that does not apply as –", () => {
    const text = formatPluginDoctorReport(buildPluginDoctorReport(healthy({
      record: record({ enabled: false }),
      manifest: manifest({ skills: [] }),
    })));
    expect(text).toContain("✗ Installed here");
    expect(text).toContain("– Agent skills");
  });
});
