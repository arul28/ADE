import { describe, expect, it } from "vitest";
import {
  clampPluginInvokeTimeoutMs,
  comparePluginContributions,
  isPluginEntityKind,
  isPluginSocketKind,
  isPluginSurfaceId,
  parsePluginContributionPayload,
  pluginSocketInvokeTimeoutMs,
  splitPluginRowBadges,
  PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS,
  PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS,
  PLUGIN_SOCKET_INVOKE_TIMEOUT_MAX_MS,
  PLUGIN_SOCKET_KINDS,
  PLUGIN_SOCKET_REQUIREMENTS,
  type PluginContribution,
} from "./sockets";
import { pluginContributionKeyForContext, type PluginComposerContext } from "./context";
import { parsePluginManifestJson } from "./manifest";

function badge(id: string, order?: number, pluginId = "a"): PluginContribution<"row-badge"> {
  return {
    pluginId,
    socket: "row-badge",
    surface: "lanes",
    id,
    ...(order === undefined ? {} : { order }),
    payload: { text: id, tone: "neutral" },
  };
}

describe("parsePluginContributionPayload", () => {
  it("accepts a well-formed payload for each kind", () => {
    expect(parsePluginContributionPayload("toolbar-action", { label: "Sync", actionId: "sync" }))
      .toEqual({ label: "Sync", actionId: "sync" });
    expect(parsePluginContributionPayload("row-menu-item", { label: "Open", actionId: "open", danger: true }))
      .toEqual({ label: "Open", actionId: "open", danger: true });
    expect(parsePluginContributionPayload("filter-chip", { label: "Mine", filterKey: "mine", count: 3.7 }))
      .toEqual({ label: "Mine", filterKey: "mine", count: 3 });
    expect(parsePluginContributionPayload("file-viewer", { panelId: "player", extensions: [".MP4", "mov"] }))
      .toEqual({ panelId: "player", extensions: [".mp4"] });
  });

  // A contribution missing its action or label is a plugin bug; rendering a
  // blank button would hide it, so the payload is refused outright.
  it("refuses a payload missing the field that makes it actionable", () => {
    expect(parsePluginContributionPayload("toolbar-action", { label: "Sync" })).toBeNull();
    expect(parsePluginContributionPayload("row-menu-item", { actionId: "open" })).toBeNull();
    expect(parsePluginContributionPayload("detail-section", {})).toBeNull();
    expect(parsePluginContributionPayload("row-badge", { text: "   " })).toBeNull();
    expect(parsePluginContributionPayload("row-badge", "nope")).toBeNull();
  });

  // House rule, same as `normalizeAdeCardTone`: failure is amber, never red.
  it("folds any red-ish tone a plugin invents into warning", () => {
    for (const tone of ["danger", "error", "critical"]) {
      expect(parsePluginContributionPayload("row-badge", { text: "x", tone })).toMatchObject({ tone: "warning" });
    }
    expect(parsePluginContributionPayload("row-badge", { text: "x", tone: "nonsense" }))
      .toMatchObject({ tone: "neutral" });
  });

  it("truncates nothing and instead rejects over-long text", () => {
    expect(parsePluginContributionPayload("row-badge", { text: "x".repeat(33) })).toBeNull();
  });
});

describe("composer-action", () => {
  it("parses the same payload a toolbar action does", () => {
    expect(parsePluginContributionPayload("composer-action", { label: "Refine", actionId: "refine", icon: "sparkle" }))
      .toEqual({ label: "Refine", actionId: "refine", icon: "sparkle" });
    expect(parsePluginContributionPayload("composer-action", { label: "Refine", actionId: "refine", disabled: true }))
      .toEqual({ label: "Refine", actionId: "refine", disabled: true });
  });

  it("refuses a button with nothing to invoke", () => {
    expect(parsePluginContributionPayload("composer-action", { label: "Refine" })).toBeNull();
    expect(parsePluginContributionPayload("composer-action", { actionId: "refine" })).toBeNull();
  });

  it("is a member of the closed list, so a manifest and a row can both name it", () => {
    expect(isPluginSocketKind("composer-action")).toBe(true);
    expect(PLUGIN_SOCKET_KINDS).toContain("composer-action");
  });

  // The table is what the manifest parser warns from; a kind missing an entry
  // parses clean and contributes nothing, with nothing telling the author why.
  it("declares its requirements in the one table three layers read", () => {
    for (const kind of PLUGIN_SOCKET_KINDS) {
      expect(PLUGIN_SOCKET_REQUIREMENTS[kind]).toBeTruthy();
    }
    expect(PLUGIN_SOCKET_REQUIREMENTS["composer-action"])
      .toEqual({ manifest: ["label", "actionId"], payload: ["label", "actionId"] });
  });
});

/**
 * The path a shipped plugin actually takes.
 *
 * `ade-voice` declares its Dictate button in a real `plugin.json`, so the
 * manifest PARSER — not just the payload validator the fixtures exercise — has
 * to accept the kind and enforce its requirements. The two layers read the same
 * `PLUGIN_SOCKET_REQUIREMENTS` row, and this is where that is held to account.
 */
describe("a composer-action declared in a plugin.json", () => {
  const manifestJson = (socket: Record<string, unknown>): string => JSON.stringify({
    name: "ade-voice",
    version: "1.0.0",
    displayName: "Voice",
    sockets: [socket],
  });

  it("parses, keeping the fields the button renders from", () => {
    const result = parsePluginManifestJson(manifestJson({
      socket: "composer-action",
      surface: "work",
      id: "dictate",
      label: "Dictate",
      icon: "Microphone",
      actionId: "dictate",
      order: 1,
    }));

    expect(result.errors).toEqual([]);
    expect(result.manifest?.sockets).toEqual([{
      socket: "composer-action",
      surface: "work",
      id: "dictate",
      order: 1,
      label: "Dictate",
      icon: "Microphone",
      actionId: "dictate",
    }]);
  });

  // The failure this table exists to prevent: a socket that parses clean,
  // installs clean, and contributes nothing, with nothing saying why.
  it("is dropped with a warning naming the field when it cannot be invoked", () => {
    const result = parsePluginManifestJson(manifestJson({
      socket: "composer-action",
      surface: "work",
      id: "dictate",
      label: "Dictate",
    }));

    expect(result.manifest?.sockets).toEqual([]);
    expect(result.warnings.join(" ")).toContain("actionId");
    expect(result.warnings.join(" ")).toContain("composer-action");
    // A bad socket entry costs its own slot, never the plugin.
    expect(result.errors).toEqual([]);
    expect(result.manifest?.name).toBe("ade-voice");
  });

  it("keeps the payload validator and the manifest parser agreeing", () => {
    const parsed = parsePluginManifestJson(manifestJson({
      socket: "composer-action",
      surface: "work",
      id: "dictate",
      label: "Dictate",
      icon: "Microphone",
      actionId: "dictate",
    })).manifest?.sockets[0];
    if (!parsed) throw new Error("expected the manifest socket to survive parsing");

    // What the renderer builds from that manifest entry must survive the
    // payload gate — the round trip a contributed button actually makes.
    expect(parsePluginContributionPayload("composer-action", {
      label: parsed.label,
      icon: parsed.icon,
      actionId: parsed.actionId,
    })).toEqual({ label: "Dictate", icon: "Microphone", actionId: "dictate" });
  });
});

describe("socket invoke budgets", () => {
  // The budget follows the FEEDBACK, not the plugin: a composer button stays
  // visibly active for its whole run, so minutes are safe there; a row button
  // shows nothing, so it must fail while the user still remembers pressing it.
  it("gives composer actions minutes and everything else the default", () => {
    expect(pluginSocketInvokeTimeoutMs("composer-action")).toBe(PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS);
    expect(PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS).toBeGreaterThan(PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS);
    for (const kind of PLUGIN_SOCKET_KINDS) {
      if (kind === "composer-action") continue;
      expect(pluginSocketInvokeTimeoutMs(kind)).toBe(PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS);
    }
    expect(pluginSocketInvokeTimeoutMs(null)).toBe(PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS);
    expect(pluginSocketInvokeTimeoutMs(undefined)).toBe(PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS);
  });

  // The hint crosses renderer → preload → host, so it is untrusted input at
  // every layer. Unbounded, a wedged child becomes a promise that never settles.
  it("clamps an untrusted hint and reads nonsense as no hint at all", () => {
    expect(clampPluginInvokeTimeoutMs(5_000)).toBe(5_000);
    expect(clampPluginInvokeTimeoutMs(PLUGIN_SOCKET_INVOKE_TIMEOUT_MAX_MS + 1))
      .toBe(PLUGIN_SOCKET_INVOKE_TIMEOUT_MAX_MS);
    expect(clampPluginInvokeTimeoutMs(1_500.9)).toBe(1_500);
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "60000", null, undefined, {}]) {
      expect(clampPluginInvokeTimeoutMs(value)).toBeNull();
    }
  });

  it("accepts a caller asking for less patience than the default", () => {
    // One-directional would be an arbitrary restriction: a short budget is a
    // caller's own business and cannot wedge anything.
    expect(clampPluginInvokeTimeoutMs(1_000)).toBe(1_000);
  });
});

describe("composer context", () => {
  function composer(overrides: Partial<PluginComposerContext> = {}): PluginComposerContext {
    return {
      kind: "composer",
      sessionId: "chat-1",
      projectKey: "local:/repo",
      projectRoot: "/repo",
      laneId: "lane-1",
      draft: "ship it",
      cursor: 4,
      ...overrides,
    };
  }

  it("keys dynamic rows on the chat the composer sends to", () => {
    expect(pluginContributionKeyForContext(composer()))
      .toEqual({ entityKind: "session", entityId: "chat-1" });
  });

  // A hero composer has no chat yet. Keying on nothing would collide every
  // unstarted composer onto one entity and show one chat's rows in another.
  it("carries no entity key before the chat exists", () => {
    expect(pluginContributionKeyForContext(composer({ sessionId: null }))).toBeNull();
  });

  it("carries the full draft and the caret verbatim", () => {
    const context = composer({ draft: "  keep\tthe whitespace  ", cursor: 0 });
    expect(context.draft).toBe("  keep\tthe whitespace  ");
    expect(context.cursor).toBe(0);
  });
});

describe("contribution placement", () => {
  it("orders by explicit order, then plugin, then contribution id", () => {
    const sorted = [badge("z", 2), badge("a"), badge("b", 1), badge("c", 1, "b")]
      .sort(comparePluginContributions)
      .map((entry) => `${entry.pluginId}:${entry.id}`);
    expect(sorted).toEqual(["a:b", "b:c", "a:z", "a:a"]);
  });

  it("caps visible row badges and reports the overflow", () => {
    const split = splitPluginRowBadges([badge("d", 4), badge("a", 1), badge("b", 2), badge("c", 3)]);
    expect(split.visible.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(split.overflowCount).toBe(2);
  });

  it("reports no overflow when everything fits", () => {
    const split = splitPluginRowBadges([badge("a", 1)]);
    expect(split.visible).toHaveLength(1);
    expect(split.overflowCount).toBe(0);
  });
});

describe("closed-list guards", () => {
  it("narrows only a member of each list, and rejects everything else (NEW-B2)", () => {
    expect(isPluginSocketKind("row-badge")).toBe(true);
    expect(isPluginSocketKind("row-badges")).toBe(false);
    expect(isPluginSocketKind(undefined)).toBe(false);
    expect(isPluginSocketKind(42)).toBe(false);

    expect(isPluginSurfaceId("lanes")).toBe(true);
    expect(isPluginSurfaceId("lane")).toBe(false);

    expect(isPluginEntityKind("pr")).toBe(true);
    expect(isPluginEntityKind("pull_request")).toBe(false);
    expect(isPluginEntityKind(null)).toBe(false);
  });
});
