import { describe, expect, it } from "vitest";

import { splitPluginRowBadges } from "../../../../shared/plugins/sockets";
import type { PluginLaneContext, PluginSurfaceContext } from "../../../../shared/plugins/context";
import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import { resolveViewerKind } from "../../files/v2/viewerRegistry";
import type { PluginContributionRow, PluginSocketSource } from "./contributionBridge";
import { pluginAutomationContext } from "./surfaceContexts";
import {
  buildContributionSet,
  buildPluginMenuEntries,
  contributionsFromSource,
  entityMatchesPluginFilters,
  matchPluginViewer,
  parsePluginViewerKind,
  pluginChangeAffects,
  pluginViewerKind,
  pluginViewerRegistrations,
  selectContributions,
  surfaceContributionEntityKinds,
} from "./contributionModel";

/**
 * The socket taxonomy's rules, tested as pure functions.
 *
 * Every assertion here is about a decision the product makes rather than about
 * markup: which contribution wins, what order they land in, what gets dropped.
 * Rendering is deliberately absent — a test that mounts a Lanes row to check a
 * badge breaks when the row's layout changes and proves nothing about the rule.
 */

function source(
  pluginId: string,
  sockets: unknown[],
  overrides: Partial<PluginSocketSource> = {},
): PluginSocketSource {
  return {
    pluginId,
    displayName: pluginId,
    enabled: true,
    accent: null,
    icon: null,
    disabledContributions: [],
    manifest: { name: pluginId, version: "1.0.0", sockets },
    ...overrides,
  };
}

const LANE_CONTEXT: PluginLaneContext = {
  kind: "lane",
  id: "lane-1",
  name: "Feature",
  branch: "feature",
  machineKey: null,
  dirty: false,
};

function laneBadgeRow(pluginId: string, payload: Record<string, unknown>): PluginContributionRow {
  return {
    entityKind: "lane",
    entityId: "lane-1",
    pluginId,
    socket: "row-badge",
    payload,
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

describe("manifest sockets → contributions", () => {
  it("translates each socket kind into its payload shape", () => {
    const contributions = contributionsFromSource(
      source("graph", [
        { socket: "toolbar-action", surface: "lanes", id: "sync", label: "Sync", actionId: "sync" },
        { socket: "row-menu-item", surface: "lanes", id: "open", label: "Open graph", actionId: "open" },
        { socket: "detail-section", surface: "lanes", id: "panel", label: "Graph", panelId: "main" },
        { socket: "filter-chip", surface: "lanes", id: "chip", label: "Stacked", filterKey: "stacked" },
      ]),
    );

    expect(contributions.map((entry) => entry.socket)).toEqual([
      "toolbar-action",
      "row-menu-item",
      "detail-section",
      "filter-chip",
    ]);
    expect(contributions[0]?.payload).toMatchObject({ label: "Sync", actionId: "sync" });
    expect(contributions[2]?.payload).toMatchObject({ panelId: "main", title: "Graph" });
  });

  /**
   * Every kind gets an arm, and every arm is exercised here.
   *
   * The bug this table closes is silent by construction: a kind with no arm in
   * `payloadFromManifestSocket` parses in the manifest, installs clean, and
   * contributes nothing, with no warning anywhere. So the assertion is not
   * "the mapping is right" so much as "the mapping EXISTS for all sixteen" —
   * which is why it is one table rather than sixteen scattered cases.
   */
  it("translates every socket kind a manifest can declare", () => {
    const contributions = contributionsFromSource(
      source("kitchen-sink", [
        { socket: "toolbar-action", surface: "lanes", id: "a", label: "Sync", actionId: "sync" },
        { socket: "row-badge", surface: "lanes", id: "b", label: "Risk" },
        { socket: "row-menu-item", surface: "lanes", id: "c", label: "Open", actionId: "open" },
        { socket: "detail-section", surface: "lanes", id: "d", label: "Graph", panelId: "graph" },
        { socket: "empty-state", surface: "lanes", id: "e", label: "Nothing yet", actionId: "start" },
        { socket: "filter-chip", surface: "lanes", id: "f", label: "Stacked", filterKey: "stacked" },
        { socket: "file-viewer", surface: "files", id: "g", panelId: "proto", extensions: [".proto"] },
        { socket: "composer-action", surface: "work", id: "h", label: "Dictate", actionId: "dictate" },
        { socket: "chat-card", surface: "work", id: "i", label: "Lint report", panelId: "report" },
        { socket: "slash-command", surface: "work", id: "j", label: "Fix the lint", command: "lint", actionId: "fix", description: "Fix every lint problem", argumentHint: "<path>" },
        { socket: "command-palette-action", surface: "work", id: "k", label: "Run lint", actionId: "lint" },
        { socket: "settings-section", surface: "settings", id: "l", label: "Lint", panelId: "settings", section: "integrations" },
        { socket: "work-rail-pane", surface: "work", id: "m", label: "Lint", panelId: "rail" },
        { socket: "drawer-tab", surface: "work", id: "n", label: "Lint", panelId: "drawer" },
        { socket: "activity-entry", surface: "app", id: "o", label: "3 problems", actionId: "review" },
        { socket: "dialog-section", surface: "lanes", id: "p", label: "Lint", panelId: "dialog", dialog: "create-lane" },
      ]),
    );

    // Sixteen declared, sixteen renderable. A kind that lost its arm shows up
    // here as a missing entry rather than as a plugin author's bug report.
    expect(contributions).toHaveLength(16);
    const payloadFor = (socket: string) =>
      contributions.find((entry) => entry.socket === socket)?.payload;

    expect(payloadFor("chat-card")).toMatchObject({ panelId: "report", title: "Lint report" });
    expect(payloadFor("slash-command")).toMatchObject({
      command: "lint",
      actionId: "fix",
      description: "Fix every lint problem",
      argumentHint: "<path>",
    });
    expect(payloadFor("command-palette-action")).toMatchObject({ label: "Run lint", actionId: "lint" });
    expect(payloadFor("settings-section")).toEqual({
      panelId: "settings",
      title: "Lint",
      section: "integrations",
    });
    expect(payloadFor("work-rail-pane")).toMatchObject({ label: "Lint", panelId: "rail" });
    expect(payloadFor("drawer-tab")).toMatchObject({ label: "Lint", panelId: "drawer" });
    // Neutral, like a manifest row badge: a static entry cannot know whether
    // the thing it describes currently needs anyone.
    expect(payloadFor("activity-entry")).toMatchObject({
      title: "3 problems",
      tone: "neutral",
      actionId: "review",
    });
    expect(payloadFor("activity-entry")).not.toHaveProperty("actionLabel");
    expect(payloadFor("dialog-section")).toMatchObject({
      dialog: "create-lane",
      panelId: "dialog",
      title: "Lint",
    });
  });

  /**
   * The three optional per-kind extras, which are passthroughs rather than
   * requirements: dropping a whole contribution over a missing menu subtitle
   * would be wrong, so an absent one is absent and the contribution still
   * renders.
   */
  it("falls back to the label for a slash command written before `description` existed", () => {
    const contributions = contributionsFromSource(
      source("lint", [
        { socket: "slash-command", surface: "work", id: "a", label: "Fix the lint", command: "lint", actionId: "fix" },
      ]),
    );

    // Mirrors the host's mapping in `main/services/chat/pluginSlashCommands.ts`
    // exactly; the two feed one command menu from different sides.
    expect(contributions[0]?.payload).toMatchObject({ description: "Fix the lint" });
    expect(contributions[0]?.payload).not.toHaveProperty("argumentHint");
  });

  it("keeps a settings section renderable when it names no page", () => {
    const contributions = contributionsFromSource(
      source("lint", [{ socket: "settings-section", surface: "settings", id: "a", label: "Lint", panelId: "p" }]),
    );

    expect(contributions).toHaveLength(1);
    expect(contributions[0]?.payload).toEqual({ panelId: "p", title: "Lint" });
  });

  /**
   * `bounded` REFUSES an over-length value rather than truncating it, so a
   * description past the payload cap comes back absent — and deliberately does
   * NOT fall back to the label. The host's mapping has the same behaviour, and
   * a renderer that quietly substituted something else would print one subtitle
   * in the composer and another in `getSlashCommands`.
   */
  it("drops an over-long description instead of truncating or substituting it", () => {
    const contributions = contributionsFromSource(
      source("lint", [
        {
          socket: "slash-command",
          surface: "work",
          id: "a",
          label: "Fix the lint",
          command: "lint",
          actionId: "fix",
          description: "x".repeat(121),
        },
      ]),
    );

    expect(contributions).toHaveLength(1);
    expect(contributions[0]?.payload).not.toHaveProperty("description");
  });

  it("drops a new-kind socket that is missing the one field its kind needs", () => {
    // The requirement table is per kind, and these are the fields the four
    // generic ones (`label`/`actionId`/`panelId`/`extensions`) do not cover.
    const contributions = contributionsFromSource(
      source("kitchen-sink", [
        // No `command` — a slash entry with no word to type.
        { socket: "slash-command", surface: "work", id: "a", label: "Fix", actionId: "fix" },
        // No `dialog` — a section that cannot say which dialog it mounts on.
        { socket: "dialog-section", surface: "lanes", id: "b", label: "Lint", panelId: "dialog" },
        // No `panelId` — a rail pane with nothing to reveal.
        { socket: "work-rail-pane", surface: "work", id: "c", label: "Lint" },
      ]),
    );
    expect(contributions).toEqual([]);
  });

  it("drops a socket whose implied payload is incomplete", () => {
    // A toolbar action with no label would render as a nameless button.
    const contributions = contributionsFromSource(
      source("graph", [{ socket: "toolbar-action", surface: "lanes", id: "sync", actionId: "sync" }]),
    );
    expect(contributions).toEqual([]);
  });

  it("drops contributions the user switched off, and every socket of a disabled plugin", () => {
    const withDisabledSocket = contributionsFromSource(
      source(
        "graph",
        [
          { socket: "toolbar-action", surface: "lanes", id: "sync", label: "Sync", actionId: "sync" },
          { socket: "toolbar-action", surface: "lanes", id: "prune", label: "Prune", actionId: "prune" },
        ],
        { disabledContributions: ["prune"] },
      ),
    );
    expect(withDisabledSocket.map((entry) => entry.id)).toEqual(["sync"]);

    const disabledPlugin = contributionsFromSource(
      source("graph", [{ socket: "toolbar-action", surface: "lanes", id: "sync", label: "Sync", actionId: "sync" }], {
        enabled: false,
      }),
    );
    expect(disabledPlugin).toEqual([]);
  });
});

describe("composer actions", () => {
  it("maps a manifest composer-action to a renderable contribution", () => {
    const contributions = contributionsFromSource(source("ade-voice", [
      { socket: "composer-action", surface: "work", id: "dictate", label: "Dictate", icon: "Microphone", actionId: "dictate", order: 1 },
    ]));

    expect(contributions).toEqual([{
      pluginId: "ade-voice",
      socket: "composer-action",
      surface: "work",
      id: "dictate",
      order: 1,
      payload: { label: "Dictate", icon: "Microphone", actionId: "dictate" },
    }]);
  });

  // The composer's own selection: it passes a composer context, which keys on
  // the chat, so a plugin can publish a per-session row for its button.
  it("selects for the chat the composer sends to", () => {
    const set = buildContributionSet(
      [source("ade-voice", [
        { socket: "composer-action", surface: "work", id: "dictate", label: "Dictate", actionId: "dictate" },
      ])],
      [{
        entityKind: "session",
        entityId: "chat-1",
        pluginId: "ade-voice",
        socket: "composer-action",
        socketId: "dictate",
        payload: { label: "Stop", actionId: "dictate" },
        updatedAt: "2026-08-12T00:00:00.000Z",
      }],
      "work",
    );

    const composer: PluginSurfaceContext = {
      kind: "composer",
      sessionId: "chat-1",
      projectKey: null,
      projectRoot: null,
      laneId: null,
      draft: "half a prompt",
      cursor: 4,
    };
    // The published row replaces the manifest declaration it fills, so the
    // button reads "Stop" in this chat and "Dictate" everywhere else.
    expect(selectContributions(set, "composer-action", composer).map((entry) => entry.payload))
      .toEqual([{ label: "Stop", actionId: "dictate" }]);

    const otherChat = { ...composer, sessionId: "chat-2" };
    expect(selectContributions(set, "composer-action", otherChat).map((entry) => entry.payload))
      .toEqual([{ label: "Dictate", actionId: "dictate" }]);
  });

  // Before the chat exists there is no entity to key on; the declaration is all
  // there is, and it must still render.
  it("falls back to the declaration on a composer with no chat yet", () => {
    const set = buildContributionSet(
      [source("ade-voice", [
        { socket: "composer-action", surface: "work", id: "dictate", label: "Dictate", actionId: "dictate" },
      ])],
      [],
      "work",
    );

    expect(selectContributions(set, "composer-action", {
      kind: "composer",
      sessionId: null,
      projectKey: null,
      projectRoot: null,
      laneId: null,
      draft: "",
      cursor: null,
    }).map((entry) => entry.payload)).toEqual([{ label: "Dictate", actionId: "dictate" }]);
  });
});

/**
 * Rows a plugin publishes against the TAB rather than against a row on it.
 *
 * A plugin can only reach a client with no manifest feed by publishing, so the
 * phone receives toolbar actions, empty states and filter chips as
 * `{entityKind: "surface", entityId: <surface>}` rows. Desktop asked only for
 * the entity kind its surface carries, so those rows were fetched by nobody and
 * the same plugin lit up on iOS and stayed dark here.
 */
describe("surface-scoped contribution rows", () => {
  const surfaceRow = (
    pluginId: string,
    socket: PluginContributionRow["socket"],
    payload: Record<string, unknown>,
    surface: PluginSurfaceId = "lanes",
  ): PluginContributionRow => ({
    entityKind: "surface",
    entityId: surface,
    pluginId,
    socket,
    surface,
    payload,
    updatedAt: "2026-08-13T00:00:00.000Z",
  });

  it("reads both the surface's own entity kind and `surface`, deduped", () => {
    // Lanes lists lanes, so it needs both. The three subject-less surfaces
    // already ARE `surface`; asking twice there would double every row.
    expect(surfaceContributionEntityKinds("lanes")).toEqual(["lane", "surface"]);
    expect(surfaceContributionEntityKinds("work")).toEqual(["session", "surface"]);
    expect(surfaceContributionEntityKinds("prs")).toEqual(["pr", "surface"]);
    expect(surfaceContributionEntityKinds("cto")).toEqual(["surface"]);
    expect(surfaceContributionEntityKinds("app")).toEqual(["surface"]);
    expect(surfaceContributionEntityKinds("settings")).toEqual(["surface"]);
  });

  it("renders a surface-published contribution on the surface", () => {
    const set = buildContributionSet(
      [source("graph", [])],
      [surfaceRow("graph", "toolbar-action", { label: "Sync", actionId: "sync" })],
      "lanes",
    );

    // Both spellings of "no subject" reach it: an explicit surface-only
    // context, and a caller that passes none at all.
    const withContext = selectContributions(set, "toolbar-action", { kind: "surface", surface: "lanes" });
    expect(withContext.map((entry) => entry.payload)).toEqual([{ label: "Sync", actionId: "sync" }]);
    expect(selectContributions(set, "toolbar-action")).toHaveLength(1);
  });

  it("does not leak a surface row onto the entities the surface lists", () => {
    // A row addressed to the tab is about the tab. Folding it into an entity
    // lookup would print one toolbar contribution onto every lane on the list.
    const set = buildContributionSet(
      [source("graph", [])],
      [surfaceRow("graph", "row-badge", { text: "Tab", tone: "neutral" })],
      "lanes",
    );

    expect(selectContributions(set, "row-badge", LANE_CONTEXT)).toEqual([]);
    expect(selectContributions(set, "row-badge", { kind: "surface", surface: "lanes" })).toHaveLength(1);
  });

  it("keeps entity rows working exactly as before", () => {
    const set = buildContributionSet(
      [source("graph", [])],
      [
        laneBadgeRow("graph", { text: "Risk", tone: "warning" }),
        surfaceRow("graph", "row-badge", { text: "Tab", tone: "neutral" }),
      ],
      "lanes",
    );

    expect(selectContributions(set, "row-badge", LANE_CONTEXT).map((entry) => entry.payload))
      .toEqual([{ text: "Risk", tone: "warning" }]);
  });

  /**
   * The regression this fix could most easily have caused.
   *
   * `entityMatchesPluginFilters` reads a null from
   * `pluginContributionKeyForContext` as "this subject is not filterable, keep
   * it". Teaching THAT function about surfaces — rather than routing the
   * surface key through `pluginSurfaceContributionKey` as this fix does — would
   * make selecting any chip look up a surface in `filterKeysByEntity`, miss,
   * and silently hide every row on the tab.
   */
  it("does not make surface subjects filterable, so selecting a chip hides nothing", () => {
    const set = buildContributionSet(
      [source("graph", [])],
      [
        surfaceRow("graph", "filter-chip", { label: "Stacked", filterKey: "stacked" }),
        laneBadgeRow("graph", { text: "Risk", tone: "warning", filterKey: "stacked" }),
      ],
      "lanes",
    );

    const surfaceContext: PluginSurfaceContext = { kind: "surface", surface: "lanes" };
    expect(entityMatchesPluginFilters(set, surfaceContext, [])).toBe(true);
    expect(entityMatchesPluginFilters(set, surfaceContext, ["stacked"])).toBe(true);
    // A chip nobody tagged still filters the ENTITIES it was meant to filter.
    expect(entityMatchesPluginFilters(set, LANE_CONTEXT, ["stacked"])).toBe(true);
    expect(entityMatchesPluginFilters(set, LANE_CONTEXT, ["unrelated"])).toBe(false);
  });
});

describe("static and dynamic merge", () => {
  it("lets a dynamic row replace the plugin's static badge for that entity", () => {
    const set = buildContributionSet(
      [source("graph", [{ socket: "row-badge", surface: "lanes", id: "state", label: "Graph" }])],
      [laneBadgeRow("graph", { text: "3 ahead", tone: "accent" })],
      "lanes",
    );

    const badges = selectContributions(set, "row-badge", LANE_CONTEXT);
    expect(badges).toHaveLength(1);
    expect(badges[0]?.payload.text).toBe("3 ahead");
  });

  it("keeps the static declaration for entities the plugin published nothing for", () => {
    const set = buildContributionSet(
      [source("graph", [{ socket: "row-badge", surface: "lanes", id: "state", label: "Graph" }])],
      [laneBadgeRow("graph", { text: "3 ahead", tone: "accent" })],
      "lanes",
    );

    const otherLane: PluginLaneContext = { ...LANE_CONTEXT, id: "lane-2" };
    const badges = selectContributions(set, "row-badge", otherLane);
    expect(badges.map((entry) => entry.payload.text)).toEqual(["Graph"]);
  });

  it("ignores rows from a plugin that is not installed", () => {
    const set = buildContributionSet([source("graph", [])], [laneBadgeRow("ghost", { text: "x", tone: "neutral" })], "lanes");
    expect(selectContributions(set, "row-badge", LANE_CONTEXT)).toEqual([]);
  });

  it("ignores rows whose payload does not match the socket", () => {
    const set = buildContributionSet(
      [source("graph", [])],
      [laneBadgeRow("graph", { tone: "accent" })],
      "lanes",
    );
    expect(selectContributions(set, "row-badge", LANE_CONTEXT)).toEqual([]);
  });

  it("keeps a surface's contributions out of the other five", () => {
    const set = buildContributionSet(
      [
        source("graph", [
          { socket: "toolbar-action", surface: "lanes", id: "a", label: "Lanes", actionId: "a" },
          { socket: "toolbar-action", surface: "prs", id: "b", label: "PRs", actionId: "b" },
        ]),
      ],
      [],
      "lanes",
    );
    expect(selectContributions(set, "toolbar-action").map((entry) => entry.payload.label)).toEqual(["Lanes"]);
  });
});

describe("socketId identity", () => {
  const twoBadges = source("graph", [
    { socket: "row-badge", surface: "lanes", id: "ahead", label: "Ahead" },
    { socket: "row-badge", surface: "lanes", id: "stack", label: "Stack" },
  ]);

  it("replaces only the declaration the row fills, not the plugin's others", () => {
    const set = buildContributionSet(
      [twoBadges],
      [{ ...laneBadgeRow("graph", { text: "3 ahead", tone: "accent" }), socketId: "ahead" }],
      "lanes",
    );

    // "stack" was declared and never published for this lane; it must survive.
    expect(selectContributions(set, "row-badge", LANE_CONTEXT).map((entry) => entry.payload.text))
      .toEqual(["3 ahead", "Stack"]);
  });

  it("honours the per-contribution toggle on published rows, not just declarations", () => {
    // The user switched "ahead" off. Filtering only the static side would leave
    // the published badge on screen and make the switch look broken.
    const set = buildContributionSet(
      [{ ...twoBadges, disabledContributions: ["ahead"] }],
      [{ ...laneBadgeRow("graph", { text: "3 ahead", tone: "accent" }), socketId: "ahead" }],
      "lanes",
    );
    expect(selectContributions(set, "row-badge", LANE_CONTEXT).map((entry) => entry.payload.text))
      .toEqual(["Stack"]);
  });

  it("drops a row that names a different surface", () => {
    const set = buildContributionSet(
      [twoBadges],
      [{ ...laneBadgeRow("graph", { text: "3 ahead", tone: "accent" }), socketId: "ahead", surface: "prs" }],
      "lanes",
    );
    expect(selectContributions(set, "row-badge", LANE_CONTEXT).map((entry) => entry.payload.text))
      .toEqual(["Ahead", "Stack"]);
  });

  it("falls back to per-plugin replacement on a host that sends no socketId", () => {
    // Such a host can only express one contribution per plugin per socket, so
    // its row replaces both declarations rather than sitting beside the
    // placeholder it exists to fill in.
    const set = buildContributionSet(
      [twoBadges],
      [laneBadgeRow("graph", { text: "3 ahead", tone: "accent" })],
      "lanes",
    );
    expect(selectContributions(set, "row-badge", LANE_CONTEXT).map((entry) => entry.payload.text))
      .toEqual(["3 ahead"]);
  });
});

describe("automation entities", () => {
  it("keys an automation context on its id, matching the row's entity id", () => {
    const set = buildContributionSet(
      [source("graph", [])],
      [
        {
          entityKind: "automation",
          entityId: "rule-7",
          pluginId: "graph",
          socket: "row-badge",
          socketId: "state",
          payload: { text: "ran 2m ago", tone: "success" },
          updatedAt: null,
        },
      ],
      "automations",
    );

    const context = pluginAutomationContext({ id: "rule-7", name: "Nightly", enabled: true });
    expect(selectContributions(set, "row-badge", context).map((entry) => entry.payload.text))
      .toEqual(["ran 2m ago"]);
    expect(selectContributions(set, "row-badge", pluginAutomationContext({ id: "rule-8" }))).toEqual([]);
  });

  it("names an unnamed rule the way the list does", () => {
    expect(pluginAutomationContext({ id: "rule-7", name: "  " }).name).toBe("Untitled automation");
    expect(pluginAutomationContext({ id: "rule-7" }).enabled).toBe(true);
  });
});

describe("ordering and caps", () => {
  it("sorts by order, then plugin id, then contribution id", () => {
    const set = buildContributionSet(
      [
        source("zeta", [{ socket: "toolbar-action", surface: "lanes", id: "a", label: "Z", actionId: "z" }]),
        source("alpha", [
          { socket: "toolbar-action", surface: "lanes", id: "b", label: "A2", actionId: "a2" },
          { socket: "toolbar-action", surface: "lanes", id: "a", label: "A1", actionId: "a1" },
          { socket: "toolbar-action", surface: "lanes", id: "first", label: "First", actionId: "f", order: 1 },
        ]),
      ],
      [],
      "lanes",
    );

    expect(selectContributions(set, "toolbar-action").map((entry) => entry.payload.label)).toEqual([
      "First",
      "A1",
      "A2",
      "Z",
    ]);
  });

  /**
   * The half the test above does not reach.
   *
   * Everything it orders is a STATIC manifest contribution, and statics never
   * pass through `parsePluginContributionPayload`. Published rows do, and
   * `order` was stripped there — so every published contribution fell back to
   * `Number.MAX_SAFE_INTEGER` and sorted last while the statics beside them
   * ordered correctly. One merged list, two halves disagreeing about whether
   * ordering worked, and a green suite either way.
   *
   * `order` beating the plugin-id tie-break is what makes this discriminating:
   * `zeta` sorts after `alpha` on every other term, so it can only come first
   * if its published `order` was actually read. The companion assertion lives
   * at the writer (`pluginDataStore.test.ts`, that `order` survives publish);
   * together they cover the seam that let this ship.
   */
  it("honours order on a published row, not just on a manifest declaration", () => {
    const set = buildContributionSet(
      [source("alpha", []), source("zeta", [])],
      [
        laneBadgeRow("alpha", { text: "Unordered" }),
        laneBadgeRow("zeta", { text: "Ordered", order: 1 }),
      ],
      "lanes",
    );

    expect(selectContributions(set, "row-badge", LANE_CONTEXT).map((entry) => entry.payload.text))
      .toEqual(["Ordered", "Unordered"]);
  });

  it("shows two badges and folds the rest into an overflow count", () => {
    const set = buildContributionSet(
      [
        source(
          "graph",
          [1, 2, 3, 4].map((index) => ({
            socket: "row-badge",
            surface: "lanes",
            id: `b${index}`,
            label: `B${index}`,
            order: index,
          })),
        ),
      ],
      [],
      "lanes",
    );

    const { visible, overflowCount } = splitPluginRowBadges(selectContributions(set, "row-badge", LANE_CONTEXT));
    expect(visible.map((entry) => entry.payload.text)).toEqual(["B1", "B2"]);
    expect(overflowCount).toBe(2);
  });

  it("caps how many contributions one plugin can put in a single slot", () => {
    const set = buildContributionSet(
      [
        source(
          "greedy",
          Array.from({ length: 12 }, (_, index) => ({
            socket: "toolbar-action",
            surface: "lanes",
            id: `a${index}`,
            label: `A${index}`,
            actionId: `a${index}`,
            order: index,
          })),
        ),
      ],
      [],
      "lanes",
    );
    expect(selectContributions(set, "toolbar-action")).toHaveLength(8);
  });
});

describe("menu entries", () => {
  const set = buildContributionSet(
    [
      source("graph", [
        { socket: "row-menu-item", surface: "lanes", id: "open", label: "Open graph", actionId: "graph.open" },
      ]),
    ],
    [],
    "lanes",
  );

  it("builds one entry per contribution, tagged for the tour", () => {
    const entries = buildPluginMenuEntries({
      set,
      surface: "lanes",
      context: LANE_CONTEXT,
      invoke: () => {},
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "action", label: "Open graph", dataTour: "plugin:lanes.row-menu-item" });
  });

  it("closes the menu, then invokes with the entity's typed context", () => {
    const calls: Array<[string, string, PluginSurfaceContext]> = [];
    const order: string[] = [];
    const entries = buildPluginMenuEntries({
      set,
      surface: "lanes",
      context: LANE_CONTEXT,
      invoke: (pluginId, actionId, context) => {
        order.push("invoke");
        calls.push([pluginId, actionId, context]);
      },
      onClose: () => order.push("close"),
    });

    entries[0]?.onSelect();
    expect(order).toEqual(["close", "invoke"]);
    expect(calls[0]).toEqual(["graph", "graph.open", LANE_CONTEXT]);
  });

  it("returns nothing for a surface with no contributed entries", () => {
    expect(
      buildPluginMenuEntries({ set, surface: "prs", context: LANE_CONTEXT, invoke: () => {} }),
    ).toEqual([]);
  });
});

describe("filter chips", () => {
  const set = buildContributionSet(
    [source("graph", [{ socket: "filter-chip", surface: "lanes", id: "c", label: "Stacked", filterKey: "stacked" }])],
    [laneBadgeRow("graph", { text: "3 ahead", tone: "accent", filterKey: "stacked" })],
    "lanes",
  );

  it("matches every entity when nothing is selected", () => {
    expect(entityMatchesPluginFilters(set, LANE_CONTEXT, [])).toBe(true);
    expect(entityMatchesPluginFilters(set, { ...LANE_CONTEXT, id: "lane-9" }, [])).toBe(true);
  });

  it("keeps only entities the plugin tagged with the selected key", () => {
    expect(entityMatchesPluginFilters(set, LANE_CONTEXT, ["stacked"])).toBe(true);
    expect(entityMatchesPluginFilters(set, { ...LANE_CONTEXT, id: "lane-9" }, ["stacked"])).toBe(false);
  });
});

describe("change-event routing", () => {
  it("refetches contributions when a plugin publishes them, and not the registry", () => {
    expect(pluginChangeAffects("contributions", "contributions")).toBe(true);
    expect(pluginChangeAffects("sources", "contributions")).toBe(false);
  });

  it("refetches both when what is installed changes", () => {
    // A new plugin may have rows waiting; a removed one's rows must stop.
    expect(pluginChangeAffects("sources", "installs")).toBe(true);
    expect(pluginChangeAffects("contributions", "installs")).toBe(true);
  });

  it("treats child-process health as a registry change only", () => {
    expect(pluginChangeAffects("sources", "status")).toBe(true);
    expect(pluginChangeAffects("contributions", "status")).toBe(false);
  });

  it("ignores panel and collection writes on both reads", () => {
    for (const kind of ["panels", "collections"]) {
      expect(pluginChangeAffects("sources", kind)).toBe(false);
      expect(pluginChangeAffects("contributions", kind)).toBe(false);
    }
  });

  it("refetches everything for a kind this build has never heard of", () => {
    // The daemon's kind list grows without a renderer release. A stale badge
    // with nothing to correct it is worse than one redundant round trip.
    expect(pluginChangeAffects("sources", "secrets")).toBe(true);
    expect(pluginChangeAffects("contributions", "secrets")).toBe(true);
    expect(pluginChangeAffects("contributions", "")).toBe(true);
  });
});

describe("file viewer resolution", () => {
  const viewers = pluginViewerRegistrations([
    source("player", [
      {
        socket: "file-viewer",
        surface: "files",
        id: "player",
        panelId: "play",
        extensions: [".fbx", ".GLB"],
      },
    ]),
  ]);

  it("registers the plugin's extensions, normalized", () => {
    expect(viewers).toEqual([
      { pluginId: "player", panelId: "play", displayName: "player", extensions: [".fbx", ".glb"] },
    ]);
  });

  it("leaves a readable file with the editor even when a plugin registered its extension", () => {
    // `code` is core's default for anything textual, so a plugin claiming it
    // would replace the editor for ordinary source files.
    expect(resolveViewerKind({ path: "/scene.glb", pluginViewers: viewers })).toBe("code");
  });

  it("takes over the binary and large-text fallbacks", () => {
    expect(resolveViewerKind({ path: "/scene.fbx", isBinary: true, pluginViewers: viewers })).toBe("plugin:player:play");
    expect(resolveViewerKind({ path: "/scene.fbx", isPartial: true, pluginViewers: viewers })).toBe("plugin:player:play");
  });

  it("never takes a format a built-in viewer already owns", () => {
    const videoPlugin = pluginViewerRegistrations([
      source("player", [
        { socket: "file-viewer", surface: "files", id: "p", panelId: "play", extensions: [".mp4", ".md"] },
      ]),
    ]);
    expect(resolveViewerKind({ path: "/clip.mp4", pluginViewers: videoPlugin })).toBe("video");
    expect(resolveViewerKind({ path: "/readme.md", pluginViewers: videoPlugin })).toBe("markdown");
  });

  it("resolves normally when no plugin registers anything", () => {
    expect(resolveViewerKind({ path: "/scene.glb" })).toBe("code");
    expect(resolveViewerKind({ path: "/scene.glb", pluginViewers: [] })).toBe("code");
  });

  it("round-trips a viewer kind, and tolerates one whose plugin is gone", () => {
    const kind = pluginViewerKind("player", "play");
    expect(parsePluginViewerKind(kind)).toEqual({ pluginId: "player", panelId: "play" });
    // A persisted tab from an uninstalled plugin: still parses (so the host can
    // name it), but matches no registration, which is what sends the tab to the
    // binary fallback instead of a blank pane.
    expect(parsePluginViewerKind("plugin:ghost:panel")).toEqual({ pluginId: "ghost", panelId: "panel" });
    expect(matchPluginViewer(viewers, ".glb")?.pluginId).toBe("player");
    expect(matchPluginViewer(viewers, ".ghost")).toBeNull();
    expect(parsePluginViewerKind("code")).toBeNull();
    expect(parsePluginViewerKind("plugin:onlyone")).toBeNull();
  });

  it("matches an extension whether or not the caller included the dot", () => {
    expect(matchPluginViewer(viewers, "glb")?.panelId).toBe("play");
    expect(matchPluginViewer(viewers, ".GLB")?.panelId).toBe("play");
  });
});
