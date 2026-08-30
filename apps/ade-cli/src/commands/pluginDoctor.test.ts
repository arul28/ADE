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
  PluginWebhookIngressStatus,
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
    webhookIngress: [],
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

  it("fails the places rung for a switched-off plugin, which places nothing at all", () => {
    const off = healthy({ record: record({ enabled: false }) });
    const places = layer(off, "places");
    expect(places.state).toBe("no");
    expect(places.detail).toContain("switched off");
    // The declarations are still named: the reader is asking what comes back
    // when they turn it on.
    expect(places.detail).toContain("composer-action in work");
    expect(places.detail).toContain("ade plugin enable ade-tipsy");
  });

  /**
   * The `pane` surface an author declared, that no client has ever drawn.
   * The parser refuses it now, which removes it from the manifest — so without
   * this rung the doctor would describe a plugin one declaration lighter than
   * the file, and stay green while the author waits for a pane to appear.
   */
  it("fails the places rung when the parse dropped a declaration", () => {
    const dropped = healthy({
      manifestWarnings: [
        'surfaces[0].kind "pane" is not drawn by any client on its own'
        + ' — declare a "work-rail-pane" socket for panel "main" instead — entry dropped',
      ],
    });
    const places = layer(dropped, "places");
    expect(places.state).toBe("no");
    expect(places.detail).toContain("dropped 1 part of plugin.json");
    expect(places.detail).toContain("work-rail-pane");
  });

  it("keeps the places rung quiet about a dropped part when the plugin is not installed here", () => {
    const elsewhere = healthy({ record: null, manifestWarnings: ["surfaces[0] is not an object — entry dropped"] });
    expect(layer(elsewhere, "places").state).not.toBe("no");
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
    // Keyed rather than positional, and `toMatchObject` rather than `toEqual`:
    // this case is about what each rung ANSWERS, and a new rung on the ladder
    // should not fail a test that says nothing about it.
    expect(Object.fromEntries(report.layers.map((entry) => [entry.key, entry.state])))
      .toMatchObject({
        source: "no",
        installed: "no",
        running: "no",
        places: "na",
        customPage: "na",
        lastRun: "unknown",
        panels: "na",
        synced: "no",
        skills: "na",
      });
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

/**
 * The webview rungs — the pair the alpha run needed and did not have.
 *
 * Tipsy declared a `webview` surface with an `entryHtml`, and the app drew its
 * panel. Doctor said "Places: chat-header-action in work" and "Panels: 1
 * published of 1", both true, neither about the tab, so the author rewrote the
 * plugin instead of reading the host's list payload
 * (docs/reports/ade-plugins-agent-diagnostic-2026-08-26.md §2, §6).
 */
describe("webview surfaces on the ladder", () => {
  const dashboard = {
    kind: "webview" as const,
    id: "dashboard",
    title: "Dashboard",
    panelId: "main",
    entryHtml: "web/index.html",
  };

  /** Manifest and live summary agreeing, which is the fixed host. */
  const withPage = (surfaces: PluginDetail["surfaces"]): PluginDoctorSnapshot =>
    healthy({
      manifest: manifest({ surfaces: [dashboard] }),
      live: { ...healthy().live!, detail: detail({ surfaces }) },
    });

  it("names a webview tab in Places, beside the sockets", () => {
    const places = layer(withPage([dashboard]), "places");
    expect(places.state).toBe("ok");
    expect(places.detail).toContain("webview tab in the sidebar");
    expect(places.detail).toContain("composer-action in work");
  });

  it("names an ordinary tab in Places too", () => {
    const snapshot = healthy({
      manifest: manifest({ surfaces: [{ kind: "tab", id: "log", title: "Log", panelId: "main" }] }),
    });
    expect(layer(snapshot, "places").detail).toContain("tab in the sidebar");
  });

  it("keeps a plugin's place when every socket is off but a tab remains", () => {
    const snapshot = healthy({
      manifest: manifest({ surfaces: [dashboard] }),
      record: record({ disabledContributions: ["drink", "sober"] }),
    });
    expect(layer(snapshot, "places").state).toBe("ok");
  });

  it("FAILS when the manifest declares a page and the live summary has none", () => {
    // The exact shape of the bug: `plugin.get`'s `manifest.surfaces` carries
    // `entryHtml` and its `surfaces` does not, so every guest host draws the
    // panel. It is the HOST that is wrong here, and the line has to say so.
    const stripped = layer(
      withPage([{ kind: "webview", id: "dashboard", title: "Dashboard", panelId: "main" }]),
      "customPage",
    );
    expect(stripped.state).toBe("no");
    expect(stripped.detail).toContain('"dashboard"');
    expect(stripped.detail).toContain("older than this manifest");
    expect(stripped.detail).toContain("reload cannot change what the running app serves");
  });

  it("FAILS the same way when the live summary omits the surface entirely", () => {
    expect(layer(withPage([]), "customPage").state).toBe("no");
  });

  it("passes when the summary carries the page, and says what other clients draw", () => {
    const ok = layer(withPage([dashboard]), "customPage");
    expect(ok.state).toBe("ok");
    expect(ok.detail).toContain("dashboard → web/index.html");
    expect(ok.detail).toContain("draw its panel instead, by design");
  });

  it("does not apply to a plugin that declares no page", () => {
    expect(layer(healthy(), "customPage").state).toBe("na");
  });

  it("says nobody could check when ADE is not answering", () => {
    const unreachable = layer(
      healthy({ manifest: manifest({ surfaces: [dashboard] }), live: null }),
      "customPage",
    );
    expect(unreachable.state).toBe("unknown");
    expect(unreachable.detail).toContain("could not ask ADE");
  });

  /**
   * "Renders on" named only sockets, so an author whose whole plugin was a tab
   * got no such line at all and one with a chat button got a line that named
   * only the button — the reading that sent them debugging a tab the doctor
   * never mentioned (the diagnostic report's §6).
   */
  it("names rail surfaces on the Renders-on line beside the sockets", () => {
    const withTab = buildPluginDoctorReport(healthy({
      manifest: manifest({ surfaces: [dashboard] }),
    }));
    expect(withTab.renders).toContain("composer-action");
    expect(withTab.renders).toContain("1 custom-UI tab");
    expect(withTab.renders).toContain("its page on desktop, its panel on web, iPhone and terminal");
  });

  it("still answers for a plugin whose only presence is a tab", () => {
    const tabOnly = buildPluginDoctorReport(healthy({
      manifest: manifest({
        sockets: [],
        surfaces: [{ kind: "tab", id: "board", title: "Board", panelId: "board" }],
      }),
    }));
    expect(tabOnly.renders).toBe("1 sidebar tab on every client");
  });
});

/**
 * The rung the HN dogfood run needed, and the one every other rung hid.
 *
 * A chat button whose handler navigates to a panel, on a plugin with nowhere to
 * put a panel, passes every check above it: it parses, installs, runs, draws,
 * fires and publishes. The press still shows the reader nothing.
 */
describe("panel reach", () => {
  const chatButton = {
    socket: "chat-header-action" as const,
    surface: "work" as const,
    id: "hn",
    label: "HN",
    actionId: "openStories",
  };
  const railPane = {
    socket: "work-rail-pane" as const,
    surface: "work" as const,
    id: "stories",
    label: "HN",
    panelId: "main",
  };
  const tab = { kind: "tab" as const, id: "stories", title: "Hacker News", panelId: "main" };

  it("FAILS a chat button whose panel has nowhere to land", () => {
    const reach = layer(healthy({ manifest: manifest({ sockets: [chatButton] }) }), "panelReach");
    expect(reach.state).toBe("no");
    expect(reach.detail).toContain("chat-header-action");
    expect(reach.detail).toContain("nowhere to land");
    // Both fixes named, in the order the placement rule prefers them.
    expect(reach.detail).toContain("work-rail-pane");
    expect(reach.detail).toContain("`tab` surface");
  });

  it("passes, and says the panel opens beside the conversation, once a pane exists", () => {
    const reach = layer(
      healthy({ manifest: manifest({ sockets: [chatButton, railPane] }) }),
      "panelReach",
    );
    expect(reach.state).toBe("ok");
    expect(reach.detail).toContain("beside the conversation");
  });

  it("passes with a tab alone, and says the reader loses the chat", () => {
    const reach = layer(
      healthy({ manifest: manifest({ sockets: [chatButton], surfaces: [tab] }) }),
      "panelReach",
    );
    expect(reach.state).toBe("ok");
    expect(reach.detail).toContain("taking the reader off the chat");
  });

  it("says nothing about a plugin with no chat header button", () => {
    const reach = layer(
      healthy({
        manifest: manifest({
          sockets: [{ socket: "slash-command", surface: "work", id: "s", command: "go", actionId: "go" }],
        }),
      }),
      "panelReach",
    );
    expect(reach.state).toBe("na");
    expect(reach.detail).toContain("nothing depends on where a navigate lands");
  });

  it("says nothing about a plugin with no panels at all", () => {
    const reach = layer(
      healthy({ manifest: manifest({ panels: [], sockets: [chatButton] }) }),
      "panelReach",
    );
    expect(reach.state).toBe("na");
  });

  it("leaves a composer button alone, on purpose", () => {
    // `composer-action` also invokes without drawing, and the default fixture
    // declares one beside an unplaced panel. It is NOT flagged: a composer
    // button's canonical uses are about the draft, so a panel it never opens is
    // an ordinary plugin. Narrowing the rung to the one shape where an unplaced
    // panel is evidence is what keeps the ladder scannable.
    expect(layer(healthy(), "panelReach").state).toBe("na");
  });
});

/* ── Network and provider keys ──────────────────────────────────────────── */

describe("buildPluginDoctorReport network rung", () => {
  it("says a plugin that declares no host reaches nothing", () => {
    const found = layer(healthy(), "network");
    expect(found.state).toBe("na");
    expect(found.detail).toContain("reaches nothing");
  });

  it("lists the declared hosts", () => {
    const snapshot = healthy({ manifest: manifest({ network: { hosts: ["api.cursor.com"] } }) });
    const found = layer(snapshot, "network");
    expect(found.state).toBe("ok");
    expect(found.detail).toContain("api.cursor.com");
  });

  it("counts refusals off the plugin's own log and points at the logs", () => {
    const snapshot = healthy({
      manifest: manifest({ network: { hosts: ["api.cursor.com"] } }),
      live: {
        ...healthy().live!,
        detail: detail({
          logs: [
            {
              at: "2026-08-25T11:59:00.000Z",
              level: "warn",
              message: "refused",
              fields: { code: "network_host_not_declared", host: "evil.test" },
            },
          ],
        }),
      },
    });
    const found = layer(snapshot, "network");
    // ✗, not ✓: the plugin IS being stopped from doing something it tried to
    // do, and the reader is here because it does not work.
    expect(found.state).toBe("no");
    expect(found.detail).toContain("1 request refused");
    expect(found.detail).toContain("ade plugin logs");
  });

  it("says nothing about the network for a plugin that runs no code", () => {
    const snapshot = healthy({ manifest: { ...manifest(), entry: undefined } });
    expect(layer(snapshot, "network").state).toBe("na");
  });
});

describe("buildPluginDoctorReport provider-keys rung", () => {
  it("stays out of the way for a plugin that reads none of ADE's keys", () => {
    expect(layer(healthy(), "providerKeys").state).toBe("na");
  });

  it("passes when every declared key is connected", () => {
    const snapshot = healthy({
      manifest: manifest({ providerKeys: ["cursor"] }),
      live: {
        ...healthy().live!,
        detail: detail({ providerKeys: [{ provider: "cursor", present: true }] }),
      },
    });
    const found = layer(snapshot, "providerKeys");
    expect(found.state).toBe("ok");
    expect(found.detail).toContain("Cursor");
  });

  it("names the missing key and where to add it", () => {
    const snapshot = healthy({
      manifest: manifest({ providerKeys: ["cursor"] }),
      live: {
        ...healthy().live!,
        detail: detail({ providerKeys: [{ provider: "cursor", present: false }] }),
      },
    });
    const found = layer(snapshot, "providerKeys");
    expect(found.state).toBe("no");
    expect(found.detail).toContain("no Cursor key is connected");
    expect(found.detail).toContain("Settings");
  });

  it("says it cannot tell on a host that does not report presence", () => {
    const snapshot = healthy({ manifest: manifest({ providerKeys: ["cursor"] }) });
    // `detail()` carries no `providerKeys`, which is what an older host sends.
    expect(layer(snapshot, "providerKeys").state).toBe("unknown");
  });

  it("says it cannot tell when ADE is not answering at all", () => {
    const snapshot = healthy({ manifest: manifest({ providerKeys: ["cursor"] }), live: null });
    const found = layer(snapshot, "providerKeys");
    expect(found.state).toBe("unknown");
    expect(found.detail).toContain("could not ask ADE");
  });
});

/**
 * Declaration only, and readable with ADE closed. Whether the named secret is
 * actually set is the project's business, and a doctor report gets pasted into
 * issues — so the rung answers "may it, and which ones", never "and here is
 * what your .env holds".
 */
describe("buildPluginDoctorReport project-secrets rung", () => {
  it("stays out of the way for a plugin that reads none of them", () => {
    const found = layer(healthy(), "projectSecrets");
    expect(found.state).toBe("na");
    expect(found.detail).toContain("none of this project's secrets");
  });

  it("names the declared secrets, and says they are the only ones", () => {
    const snapshot = healthy({ manifest: manifest({ projectSecrets: ["STRIPE_API_KEY"] }) });
    const found = layer(snapshot, "projectSecrets");
    expect(found.state).toBe("ok");
    expect(found.detail).toContain("STRIPE_API_KEY");
    expect(found.detail).toContain("no other project secret");
  });
});

/**
 * "I pasted the URL into Stripe and nothing happens" has four causes that look
 * identical from outside. Each case below is one of them, and the assertion is
 * that the rung names THAT one rather than a generic failure.
 */
describe("buildPluginDoctorReport webhooks rung", () => {
  const channels = [{ id: "default", label: "Build events" }];

  function ingress(
    overrides: Partial<PluginWebhookIngressStatus> = {},
  ): PluginWebhookIngressStatus {
    return {
      pluginId: "ade-tipsy",
      state: "ready",
      relayBaseUrl: "https://relay.example",
      channels: [{
        channelId: "default",
        label: "Build events",
        url: "https://relay.example/plugin/ade-tipsy/webhook",
        verified: false,
        lastReceivedAt: null,
      }],
      lastReceivedAt: null,
      lastPolledAt: null,
      lastError: null,
      pendingDeliveries: 0,
      abandonedDeliveries: 0,
      ...overrides,
    };
  }

  function withIngress(status: PluginWebhookIngressStatus | null | undefined): PluginDoctorSnapshot {
    return healthy({
      manifest: manifest({ webhookIngress: channels }),
      live: { ...healthy().live!, webhookIngress: status },
    });
  }

  it("stays out of the way for a plugin that receives no webhooks", () => {
    expect(layer(healthy(), "ingress").state).toBe("na");
  });

  it("prints the URL so the reader can compare it with what they pasted", () => {
    const found = layer(withIngress(ingress()), "ingress");
    expect(found.state).toBe("ok");
    expect(found.detail).toContain("nothing has arrived yet");
    expect(found.detail).toContain("https://relay.example/plugin/ade-tipsy/webhook");
  });

  it("names an unfinished relay registration rather than blaming the sender", () => {
    const found = layer(withIngress(ingress({ state: "unconfigured" })), "ingress");
    expect(found.state).toBe("no");
    expect(found.detail).toContain("not registered with the relay yet");
  });

  it("names the missing signing secret, the one failure where events do arrive", () => {
    const found = layer(withIngress(ingress({
      channels: [{
        channelId: "default",
        label: "Build events",
        url: "https://relay.example/plugin/ade-tipsy/webhook",
        verified: true,
        missingSecretRef: "STRIPE_SIGNING_SECRET",
        lastReceivedAt: "2026-08-25T11:59:00.000Z",
      }],
    })), "ingress");
    expect(found.state).toBe("no");
    expect(found.detail).toContain("STRIPE_SIGNING_SECRET");
    expect(found.detail).toContain("being refused");
  });

  // Abandoned means ADE handed the delivery over five times and the plugin
  // never acked. That is the plugin's bug, and the rung says so.
  it("reports deliveries the plugin never acknowledged", () => {
    const found = layer(withIngress(ingress({
      lastReceivedAt: "2026-08-25T11:59:00.000Z",
      abandonedDeliveries: 2,
    })), "ingress");
    expect(found.state).toBe("no");
    expect(found.detail).toContain("given up on");
  });

  it("says nobody could check on a host that predates the feature", () => {
    const found = layer(withIngress(undefined), "ingress");
    expect(found.state).toBe("unknown");
    expect(found.detail).toContain("does not receive webhooks");
  });

  it("says nobody could check when ADE is not answering at all", () => {
    const snapshot = healthy({ manifest: manifest({ webhookIngress: channels }), live: null });
    expect(layer(snapshot, "ingress").state).toBe("unknown");
  });
});
