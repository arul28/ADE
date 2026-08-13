/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import type { ProjectInfo } from "../../../../shared/types";
import type {
  SyncMobileProjectSummary,
  SyncRemoteCommandDescriptor,
} from "../../../../shared/types/sync";
import type { AdeSyncClient } from "../../sync";
import { createAdeWebAdapter } from "../index";

/**
 * The socket data path, end to end, over the sync transport.
 *
 * Every other test in this directory checks one member of the adapter. This one
 * checks the thing those members exist for: that a plugin's badge reaches the
 * screen in a browser, through the REAL socket layer — `useSurfaceContributions`
 * joining `readPluginSocketSources` against `readSurfaceContributionRows`, with
 * nothing about it mocked. It is written this way because the bug it guards is
 * not in any single member: for the whole of this platform's life the hosted
 * client rendered zero sockets while every component that draws them was
 * already shipping in the web bundle, because the two host reads behind them
 * had no remote command and `manifestOf()` came back null.
 *
 * The two halves are exercised separately on purpose. The STATIC half rides the
 * `plugins.list` record and is what a plugin declares everywhere; the DYNAMIC
 * half is its own command and is what a plugin says about lane 7 today. A host
 * can serve the first without the second, and that must degrade to a declared
 * badge rather than to nothing.
 */

const project: ProjectInfo = { rootPath: "/repo", displayName: "Repo", baseRef: "main" };

const PLUGIN_ACTIONS = ["plugins.list", "plugins.contributions", "plugins.invoke"];

function descriptors(actions: string[]): SyncRemoteCommandDescriptor[] {
  return actions.map((action) => ({
    action,
    scope: action === "plugins.contributions" ? ("project" as const) : ("runtime" as const),
    policy: { viewerAllowed: true },
  }));
}

/** A plugin that declares one lane badge, as `plugins.list` sends it. */
function listedPlugin(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "risk",
    version: "1.0.0",
    enabled: true,
    displayName: "Risk",
    icon: "",
    accent: "#c46b3f",
    source: "registry",
    installedAt: "2026-08-11T00:00:00.000Z",
    sockets: [{ socket: "row-badge", surface: "lanes", id: "risk-badge", label: "Risk" }],
    ...overrides,
  };
}

class FakeSyncClient {
  descriptors: SyncRemoteCommandDescriptor[] = descriptors(PLUGIN_ACTIONS);
  commandResults = new Map<string, unknown>();
  projects: SyncMobileProjectSummary[] = [];

  asClient(): AdeSyncClient {
    return this as never as AdeSyncClient;
  }

  getStatus() {
    return {
      state: "connected" as const,
      endpoint: "ws://localhost:8787",
      envId: "env-1",
      hostDeviceId: "host-1",
      hostName: "Host",
      connectedAt: "2026-08-11T00:00:00.000Z",
      lastSeenAt: "2026-08-11T00:00:00.000Z",
      error: null,
      activeProjectId: "project-1",
      selectedEnvId: "env-1",
    };
  }

  subscribe(): () => void { return () => {}; }
  onTablesChanged(): () => void { return () => {}; }
  onProjectCatalog(): () => void { return () => {}; }
  onActiveProjectChanged(): () => void { return () => {}; }
  onChatEvent(): () => void { return () => {}; }
  onBrainStatus(): () => void { return () => {}; }
  subscribePluginPanel(): () => void { return () => {}; }

  getCommandDescriptors(): SyncRemoteCommandDescriptor[] { return this.descriptors; }

  async getProjectCatalog(): Promise<{ projects: SyncMobileProjectSummary[] }> {
    return { projects: this.projects };
  }

  calls: { action: string; args: Record<string, unknown> }[] = [];

  /**
   * Answers like the host does, which for contributions means FILTERING.
   *
   * A surface reveal makes two contribution reads, not one — the row entity
   * kind (`lane`) and the surface itself (`surface`), which is where toolbar
   * actions and empty-state extras live. A fake that ignored `entityKind` would
   * answer both with the same lane row and hand the renderer a duplicate that
   * the real `plugins.contributions` could never produce, since it filters on
   * `entity_kind` in SQL.
   */
  async sendCommand(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ action, args });
    if (!this.commandResults.has(action)) return null;
    const result = this.commandResults.get(action);
    if (action !== "plugins.contributions") return result;
    const rows = (result as { contributions?: { surface?: string; entityKind?: string }[] })
      ?.contributions ?? [];
    return {
      contributions: rows.filter((row) =>
        row.surface === args.surface
        && (args.entityKind === undefined || row.entityKind === args.entityKind)),
    };
  }
}

let adapter: { dispose: () => void } | null = null;

/**
 * Install the adapter and take a FRESH copy of the socket layer.
 *
 * The socket layer keeps its joined sources and per-surface rows in
 * module-level stores — deliberately, because a row must never fetch and six
 * surfaces share one read. That makes them survive `cleanup()`, so without a
 * fresh module graph the second test in this file would assert against the
 * first one's answer. The two halves still meet through `window.ade`, which is
 * read at call time, so only the socket layer needs re-importing.
 */
async function mount(fake: FakeSyncClient) {
  const created = createAdeWebAdapter(fake.asClient());
  created.bindProject(project, "project-1");
  (globalThis as unknown as { window: Window }).window.ade = created.ade as never;
  adapter = created;
  vi.resetModules();
  const { PluginRowBadges } = await import("../../../components/plugins/sockets/PluginRowBadges");
  return PluginRowBadges;
}

/**
 * The same install, read back through the socket layer's own join.
 *
 * `PluginRowBadges` is the right probe for a badge and the wrong one for a
 * slash command or a settings section, which no component in this file's reach
 * renders. What those two need proved is narrower and more important anyway:
 * that the fields a declaration carries survive the trip. So this drops one
 * level and asks the real `readPluginSocketSources` +`contributionsFromSource`
 * — the identical functions the surfaces call — what the wire actually
 * delivered.
 */
async function readContributions(fake: FakeSyncClient) {
  const created = createAdeWebAdapter(fake.asClient());
  created.bindProject(project, "project-1");
  (globalThis as unknown as { window: Window }).window.ade = created.ade as never;
  adapter = created;
  vi.resetModules();
  const { readPluginSocketSources } = await import(
    "../../../components/plugins/sockets/contributionBridge"
  );
  const { contributionsFromSource } = await import(
    "../../../components/plugins/sockets/contributionModel"
  );
  const sources = await readPluginSocketSources();
  return sources.flatMap((source) => contributionsFromSource(source));
}

/**
 * The typed lane context a Lanes row hands its sockets.
 *
 * `id` is the field the contribution key is derived from
 * (`pluginContributionKeyForContext`), so it is what a published row's
 * `entityId` has to match for the row to reach this badge at all.
 */
const laneContext = {
  kind: "lane",
  id: "lane-1",
  name: "feature/web-sockets",
  branch: "feature/web-sockets",
  machineKey: null,
  dirty: false,
} as const;

let fake: FakeSyncClient;

beforeEach(() => {
  fake = new FakeSyncClient();
  fake.commandResults.set("plugins.list", { plugins: [listedPlugin()] });
});

afterEach(() => {
  cleanup();
  adapter?.dispose();
  adapter = null;
  delete (globalThis as unknown as { window: { ade?: unknown } }).window.ade;
});

describe("plugin sockets over sync", () => {
  it("renders a plugin's declared badge on a lane row in the browser", async () => {
    const PluginRowBadges = await mount(fake);
    render(<PluginRowBadges surface="lanes" context={laneContext} />);

    // The manifest declaration alone is enough to draw something: a plugin that
    // has not published a row for this lane yet is still a plugin that says it
    // badges lanes, and rendering nothing would make it invisible.
    expect(await screen.findByText("Risk")).toBeTruthy();
  });

  it("lets a published row replace the declaration it fills", async () => {
    fake.commandResults.set("plugins.contributions", {
      contributions: [{
        entityKind: "lane",
        entityId: "lane-1",
        pluginId: "risk",
        socket: "row-badge",
        surface: "lanes",
        socketId: "risk-badge",
        payload: { text: "3 risks", tone: "warning" },
        updatedAt: "2026-08-13T00:00:00.000Z",
      }],
    });
    const PluginRowBadges = await mount(fake);
    render(<PluginRowBadges surface="lanes" context={laneContext} />);

    // What the plugin says about THIS lane wins over what it says in general —
    // matched on the socket id, which is why the row carries one.
    expect(await screen.findByText("3 risks")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Risk")).toBeNull());
  });

  it("shows the declaration when the host serves no contributions command", async () => {
    fake.descriptors = descriptors(["plugins.list"]);
    const PluginRowBadges = await mount(fake);
    render(<PluginRowBadges surface="lanes" context={laneContext} />);

    // Half the path is still half a working surface. An older host means "this
    // plugin badges lanes, nothing specific to say here", not a blank row.
    expect(await screen.findByText("Risk")).toBeTruthy();
  });

  it("draws nothing for a socket the user switched off", async () => {
    fake.commandResults.set("plugins.list", {
      plugins: [listedPlugin({ disabledContributions: ["risk-badge"] })],
    });
    const PluginRowBadges = await mount(fake);
    const { container } = render(<PluginRowBadges surface="lanes" context={laneContext} />);

    // The toggles are filtered client-side for the static half, so they only
    // work on web because the record carries them.
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  /**
   * The drift these guard against is not hypothetical. `SyncPluginRecordSocket`
   * was a hand-kept field list and fell behind the manifest within a day: it
   * carried `command` and `dialog` but not `description`, `argumentHint` or
   * `section`, so a wire-resolved slash command arrived with no subtitle and a
   * settings section forgot which page it belonged on — silently, because a
   * dropped optional field errors nowhere. The producer now spreads the
   * declaration whole and a compile-time guard fails the build when the wire
   * type falls behind; these two assert the same thing from the far end.
   */
  it("carries a slash command's description and argument hint over the wire", async () => {
    fake.commandResults.set("plugins.list", {
      plugins: [listedPlugin({
        sockets: [{
          socket: "slash-command",
          surface: "work",
          id: "fix",
          command: "fix",
          actionId: "fix",
          label: "Fix",
          description: "Fix the thing this lane is about",
          argumentHint: "<issue-id>",
        }],
      })],
    });

    const contributions = await readContributions(fake);
    const slash = contributions.find((entry) => entry.socket === "slash-command");

    expect(slash?.payload).toMatchObject({
      command: "fix",
      description: "Fix the thing this lane is about",
      argumentHint: "<issue-id>",
    });
  });

  it("carries a settings section's page over the wire", async () => {
    fake.commandResults.set("plugins.list", {
      plugins: [listedPlugin({
        sockets: [{
          socket: "settings-section",
          surface: "settings",
          id: "risk-settings",
          panelId: "settings",
          label: "Risk",
          section: "integrations",
        }],
      })],
    });

    const contributions = await readContributions(fake);
    const section = contributions.find((entry) => entry.socket === "settings-section");

    // Without `section` the contribution still renders — on whichever page the
    // host defaults to, which is the wrong one. A field that changes WHERE
    // something appears fails more quietly than one that changes whether it
    // appears at all.
    expect(section?.payload).toMatchObject({ section: "integrations", title: "Risk" });
  });

  it("draws nothing on a surface the plugin does not declare", async () => {
    const PluginRowBadges = await mount(fake);
    const { container } = render(
      <PluginRowBadges
        surface="prs"
        context={{
          kind: "pr",
          number: 708,
          title: "Web socket parity",
          branch: null,
          state: "open",
          ciStatus: "unknown",
        }}
      />,
    );

    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
