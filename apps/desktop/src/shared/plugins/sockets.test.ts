import { describe, expect, it } from "vitest";
import {
  clampPluginInvokeTimeoutMs,
  comparePluginContributions,
  isPluginDialogField,
  isPluginDialogKind,
  isPluginEntityKind,
  isPluginSocketKind,
  isPluginSurfaceId,
  normalizePluginSlashCommand,
  parsePluginActionButtonMenu,
  parsePluginContributionPayload,
  pluginSocketInvokeTimeoutMs,
  pluginSocketKindsSupportedOn,
  pluginSocketSupportedOn,
  sanitizePluginActionColor,
  splitPluginRowBadges,
  PLUGIN_ACTION_MENU_ITEM_LIMIT,
  PLUGIN_CLIENT_SURFACES,
  PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS,
  PLUGIN_DIALOG_FIELDS,
  PLUGIN_DIALOG_KINDS,
  PLUGIN_GRAPH_NODE_EDGE_LIMIT,
  PLUGIN_SOCKET_CLIENT_SUPPORT,
  PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS,
  PLUGIN_SOCKET_INVOKE_TIMEOUT_MAX_MS,
  PLUGIN_SOCKET_KINDS,
  PLUGIN_SOCKET_REQUIREMENTS,
  PLUGIN_SURFACE_IDS,
  type PluginContribution,
  type PluginSocketKind,
} from "./sockets";
import {
  pluginContributionKeyForContext,
  pluginSurfaceContributionKey,
  type PluginActivityContext,
  type PluginComposerContext,
  type PluginDialogContext,
  type PluginSurfaceOnlyContext,
} from "./context";
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

  it("folds any red-ish tone a plugin invents into destructive", () => {
    for (const tone of ["danger", "error", "critical"]) {
      expect(parsePluginContributionPayload("row-badge", { text: "x", tone })).toMatchObject({ tone: "destructive" });
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

/**
 * The kind the alpha retrospective asked for by name.
 *
 * The user wanted a control in the chat's HEADER, got one in the composer, and
 * read the difference as the plugin not having been built. What makes this a
 * kind of its own rather than a second `toolbar-action` is the context: the
 * toolbar action a few pixels away in the same header receives the Work tab,
 * this one receives the chat.
 */
describe("chat-header-action", () => {
  it("parses the same payload a toolbar action does", () => {
    expect(parsePluginContributionPayload("chat-header-action", {
      label: "Sober up",
      icon: "beer",
      actionId: "soberUp",
    })).toEqual({ label: "Sober up", icon: "beer", actionId: "soberUp" });
  });

  it("refuses a button with nothing to invoke", () => {
    expect(parsePluginContributionPayload("chat-header-action", { label: "Sober up" })).toBeNull();
    expect(parsePluginContributionPayload("chat-header-action", { actionId: "soberUp" })).toBeNull();
  });

  it("is a member of the closed list, so a manifest and a row can both name it", () => {
    expect(isPluginSocketKind("chat-header-action")).toBe(true);
    expect(PLUGIN_SOCKET_KINDS).toContain("chat-header-action");
  });

  it("declares its requirements in the one table three layers read", () => {
    expect(PLUGIN_SOCKET_REQUIREMENTS["chat-header-action"]).toEqual({
      manifest: ["label", "actionId"],
      payload: ["label", "actionId"],
    });
  });

  /**
   * Desktop, web and the phone; the terminal deliberately absent rather than
   * half-drawn. This row is the honest answer three audiences read, and it is
   * pinned exactly so that flipping a token is a decision someone makes rather
   * than a default that drifts — it shipped `ios: false` for one round while
   * the phone had no host, and this assertion is what made that flip a
   * deliberate edit instead of an oversight.
   */
  it("ships on desktop, web and the phone, and is absent in the terminal", () => {
    expect(PLUGIN_SOCKET_CLIENT_SUPPORT["chat-header-action"])
      .toEqual({ desktop: true, web: true, ios: true, tui: false });
    expect(pluginSocketSupportedOn("chat-header-action", "desktop")).toBe(true);
    expect(pluginSocketSupportedOn("chat-header-action", "ios")).toBe(true);
    expect(pluginSocketSupportedOn("chat-header-action", "tui")).toBe(false);
    expect(pluginSocketKindsSupportedOn("desktop")).toContain("chat-header-action");
    expect(pluginSocketKindsSupportedOn("ios")).toContain("chat-header-action");
    expect(pluginSocketKindsSupportedOn("tui")).not.toContain("chat-header-action");
  });

  // Same rule as the composer button, applied to the same evidence: it draws a
  // persistent busy state, so it gets the budget that state pays for.
  it("gets the long budget, not the row default", () => {
    expect(pluginSocketInvokeTimeoutMs("chat-header-action"))
      .toBe(PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS);
  });

  it("is declarable in a plugin.json and reaches the payload it implies", () => {
    const parsed = parsePluginManifestJson(JSON.stringify({
      name: "tipsy",
      version: "1.0.0",
      displayName: "Tipsy",
      sockets: [
        { socket: "chat-header-action", surface: "work", id: "drink", label: "Drink", actionId: "takeDrink" },
      ],
    }));
    expect(parsed.manifest?.sockets).toEqual([
      { socket: "chat-header-action", surface: "work", id: "drink", label: "Drink", actionId: "takeDrink" },
    ]);
  });

  it("is dropped with a warning naming the field when it cannot be invoked", () => {
    const parsed = parsePluginManifestJson(JSON.stringify({
      name: "tipsy",
      version: "1.0.0",
      displayName: "Tipsy",
      sockets: [{ socket: "chat-header-action", surface: "work", id: "drink", label: "Drink" }],
    }));
    expect(parsed.manifest?.sockets).toEqual([]);
    expect(parsed.warnings.join(" ")).toContain("actionId");
    expect(parsed.warnings.join(" ")).toContain("chat-header-action");
  });
});

/**
 * The split-button dropdown — the retrospective's other direct ask.
 *
 * The user described "a small arrow on the drink button" that exposes a second
 * action. Every existing concept answered a different question, so the visible
 * button acquired no arrow and the whole plugin read as unfinished. The
 * assertions that matter here are the degradations: a malformed menu must never
 * cost a plugin the button it asked for.
 */
describe("the split-button menu", () => {
  const MENU = [
    { label: "Sober up", actionId: "soberUp" },
    { label: "Reset count", actionId: "reset", danger: true },
  ];

  it("rides every action-button kind, at one ceiling", () => {
    for (const kind of ["toolbar-action", "composer-action", "chat-header-action", "command-palette-action"] as const) {
      expect(parsePluginContributionPayload(kind, {
        label: "Drink",
        actionId: "takeDrink",
        menu: MENU,
      })).toEqual({ label: "Drink", actionId: "takeDrink", menu: MENU });
    }
  });

  /**
   * The compatibility promise the field makes. A plugin that declares no menu
   * must produce the byte-identical payload it produced before the field
   * existed — no empty array, no `menu: undefined` key — because a renderer
   * that saw either would start drawing a chevron over nothing.
   */
  it("is absent, not empty, when a plugin declares none", () => {
    const parsed = parsePluginContributionPayload("toolbar-action", { label: "Sync", actionId: "sync" });
    expect(parsed).toEqual({ label: "Sync", actionId: "sync" });
    expect(Object.keys(parsed ?? {})).not.toContain("menu");
  });

  /**
   * The alpha test's "Sober up" row drew a puzzle piece because the entry type
   * had no `icon` at all, so a two-entry dropdown showed the same generic mark
   * twice. The token goes through the button's own ceiling and the button's own
   * resolver, which is what keeps one list across both clients.
   */
  it("carries a menu entry's icon token, at the button's own ceiling", () => {
    const parsed = parsePluginContributionPayload("chat-header-action", {
      label: "Drink",
      actionId: "takeDrink",
      menu: [
        { label: "Sober up", actionId: "soberUp", icon: "beer" },
        { label: "Reset count", actionId: "reset" },
      ],
    });
    expect(parsed?.menu?.[0]).toEqual({ label: "Sober up", actionId: "soberUp", icon: "beer" });
    // Absent, not empty — a renderer reads "no icon declared" from the missing
    // key, exactly as the button above it does.
    expect(Object.keys(parsed?.menu?.[1] ?? {})).not.toContain("icon");
    // Unknown tokens are NOT rejected here: the token lists live in the two
    // renderers, and a shared parser that judged them would drop a glyph the
    // other client can draw. Each client degrades its own unknowns.
    expect(parsePluginContributionPayload("chat-header-action", {
      label: "Drink",
      actionId: "takeDrink",
      menu: [{ label: "Sober up", actionId: "soberUp", icon: "not-a-real-token" }],
    })?.menu?.[0]?.icon).toBe("not-a-real-token");
    // An over-long token costs the entry its glyph, never the entry: the row
    // still has a label and an action, which is the part the user asked for.
    expect(parsePluginActionButtonMenu([
      { label: "Sober up", actionId: "soberUp", icon: "x".repeat(41) },
    ])).toEqual([{ label: "Sober up", actionId: "soberUp" }]);
  });

  it("carries danger through, because the menu draws the product's own red", () => {
    const parsed = parsePluginContributionPayload("chat-header-action", {
      label: "Drink",
      actionId: "takeDrink",
      menu: [{ label: "Reset count", actionId: "reset", danger: true }],
    });
    expect(parsed?.menu?.[0]?.danger).toBe(true);
    // Anything other than a literal true is not danger — a truthy string from
    // a plugin's JSON must not colour a row red.
    expect(parsePluginContributionPayload("chat-header-action", {
      label: "Drink",
      actionId: "takeDrink",
      menu: [{ label: "Reset", actionId: "reset", danger: "yes" }],
    })?.menu?.[0]).toEqual({ label: "Reset", actionId: "reset" });
  });

  it("truncates over-cap entries rather than dropping the button", () => {
    const many = Array.from({ length: PLUGIN_ACTION_MENU_ITEM_LIMIT + 4 }, (_, index) => ({
      label: `Item ${index}`,
      actionId: `item-${index}`,
    }));
    const parsed = parsePluginContributionPayload("toolbar-action", {
      label: "Drink",
      actionId: "takeDrink",
      menu: many,
    });
    expect(parsed?.menu).toHaveLength(PLUGIN_ACTION_MENU_ITEM_LIMIT);
    expect(parsed?.menu?.[0]?.actionId).toBe("item-0");
    expect(parsed?.label).toBe("Drink");
  });

  it("drops a malformed entry and keeps the ones around it", () => {
    expect(parsePluginActionButtonMenu([
      { label: "Good", actionId: "good" },
      { label: "No action" },
      { actionId: "no-label" },
      "not an object",
      null,
      { label: "Also good", actionId: "also" },
    ])).toEqual([
      { label: "Good", actionId: "good" },
      { label: "Also good", actionId: "also" },
    ]);
  });

  it("degrades a wholly unusable menu to a plain button", () => {
    for (const menu of ["nope", 7, {}, null, [], [{ label: "" }], [{}]]) {
      const parsed = parsePluginContributionPayload("composer-action", {
        label: "Drink",
        actionId: "takeDrink",
        menu,
      });
      expect(parsed).toEqual({ label: "Drink", actionId: "takeDrink" });
    }
  });

  it("bounds a menu label like every other piece of plugin-authored text", () => {
    expect(parsePluginActionButtonMenu([{ label: "x".repeat(41), actionId: "long" }])).toEqual([]);
    expect(parsePluginActionButtonMenu([{ label: "ok", actionId: "y".repeat(65) }])).toEqual([]);
  });

  it("is declarable in a plugin.json, so a split button need not be published", () => {
    const parsed = parsePluginManifestJson(JSON.stringify({
      name: "tipsy",
      version: "1.0.0",
      displayName: "Tipsy",
      sockets: [{
        socket: "chat-header-action",
        surface: "work",
        id: "drink",
        label: "Drink",
        actionId: "takeDrink",
        menu: MENU,
      }],
    }));
    expect(parsed.manifest?.sockets[0]?.menu).toEqual(MENU);
  });

  /**
   * A menu is decoration on a button, never a reason to lose one. The manifest
   * parser drops a socket that cannot render — but a split button whose
   * dropdown is garbage still renders perfectly as a button, so the socket
   * survives and only the menu is gone.
   */
  it("never costs a plugin its socket when the manifest menu is garbage", () => {
    const parsed = parsePluginManifestJson(JSON.stringify({
      name: "tipsy",
      version: "1.0.0",
      displayName: "Tipsy",
      sockets: [{
        socket: "toolbar-action",
        surface: "lanes",
        id: "drink",
        label: "Drink",
        actionId: "takeDrink",
        menu: "not a list",
      }],
    }));
    expect(parsed.manifest?.sockets).toHaveLength(1);
    expect(parsed.manifest?.sockets[0]?.menu).toBeUndefined();
  });
});

/**
 * A per-button tint, and the reason it is not simply "whatever hex you sent".
 *
 * The alpha test's plugin could tint its button only by shipping a whole theme,
 * which recolours the entire application. This field is the narrow version —
 * and it is narrow in a second sense: one payload carries ONE colour while the
 * user picks the theme, so a colour that cannot be read on both backgrounds is
 * a button that is invisible for half the installs. That is the whole contract,
 * and every assertion below is about it rather than about hex parsing.
 */
describe("a button's own colour", () => {
  it("takes a legible hex, normalized, and expands the 3-digit form", () => {
    // ADE's own accent. The intended calibration: a plugin's brand colour is
    // expected to work, which is only a real claim if the product's does.
    expect(sanitizePluginActionColor("#7C6FF0")).toBe("#7c6ff0");
    expect(sanitizePluginActionColor("#808080")).toBe("#808080");
    expect(sanitizePluginActionColor("#888")).toBe("#888888");
  });

  /**
   * The failure this field exists to make impossible: a button nobody can see.
   * Each of these is legal CSS and legal hex, and each disappears against one
   * of the two backgrounds the same payload has to survive.
   */
  it("refuses a colour that cannot be read against one of the two themes", () => {
    // Vanishes on the light background.
    expect(sanitizePluginActionColor("#ffffff")).toBeNull();
    expect(sanitizePluginActionColor("#ffff00")).toBeNull();
    // Vanishes on the dark background.
    expect(sanitizePluginActionColor("#000000")).toBeNull();
    expect(sanitizePluginActionColor("#0000ff")).toBeNull();
  });

  it("refuses anything that is not plainly a hex colour", () => {
    for (const value of [
      "red",
      "rgb(1,2,3)",
      "#12345",
      "7C6FF0",
      "#7C6FF0;}",
      "var(--color-accent)",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(sanitizePluginActionColor(value)).toBeNull();
    }
  });

  it("reaches the payload only through the sanitizer, on every button kind", () => {
    for (const kind of ["toolbar-action", "composer-action", "chat-header-action", "command-palette-action"] as const) {
      expect(parsePluginContributionPayload(kind, {
        label: "Drink",
        actionId: "takeDrink",
        color: "#7C6FF0",
      })).toEqual({ label: "Drink", actionId: "takeDrink", color: "#7c6ff0" });
    }
  });

  /**
   * A refused colour is never a refused button. Same bargain as `menu`: the
   * label and the primary press are what the user asked for, and the tint is
   * the bonus — so the field simply goes missing and the renderer draws the
   * platform's own tone.
   */
  it("drops the field rather than the button when the colour is refused", () => {
    const parsed = parsePluginContributionPayload("chat-header-action", {
      label: "Drink",
      actionId: "takeDrink",
      color: "#ffff00",
    });
    expect(parsed).toEqual({ label: "Drink", actionId: "takeDrink" });
    expect(Object.keys(parsed ?? {})).not.toContain("color");
  });

  it("is declarable in a plugin.json, and a refused one still installs", () => {
    const declare = (color: string) => parsePluginManifestJson(JSON.stringify({
      name: "tipsy",
      version: "1.0.0",
      displayName: "Tipsy",
      sockets: [{
        socket: "chat-header-action",
        surface: "work",
        id: "drink",
        label: "Drink",
        actionId: "takeDrink",
        color,
      }],
    }));
    expect(declare("#7C6FF0").manifest?.sockets[0]?.color).toBe("#7c6ff0");
    const refused = declare("#ffffff");
    expect(refused.manifest?.sockets).toHaveLength(1);
    expect(refused.manifest?.sockets[0]?.color).toBeUndefined();
  });
});

describe("socket invoke budgets", () => {
  // The budget follows the FEEDBACK, not the plugin: a composer button stays
  // visibly active for its whole run, so minutes are safe there; a row button
  // shows nothing, so it must fail while the user still remembers pressing it.
  it("gives composer actions minutes, and a row button seconds", () => {
    expect(pluginSocketInvokeTimeoutMs("composer-action")).toBe(PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS);
    expect(PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS).toBeGreaterThan(PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS);

    // The sockets that fire from a row and show no progress anywhere: these
    // must fail while the user still remembers pressing them.
    for (const kind of ["toolbar-action", "row-menu-item", "empty-state", "filter-chip"] as const) {
      expect(pluginSocketInvokeTimeoutMs(kind)).toBe(PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS);
    }

    // Which kinds join the long budget is the taxonomy's call to extend, but
    // every kind must land on one of the two — a third number would be a
    // budget nothing documents.
    for (const kind of PLUGIN_SOCKET_KINDS) {
      expect([PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS, PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS])
        .toContain(pluginSocketInvokeTimeoutMs(kind));
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

/**
 * The chat & agent seam (wave 1).
 *
 * Both kinds are judged by one question the taxonomy cares about more than
 * anything else here: is the contribution portable? A card whose payload is a
 * panel id renders wherever the panel vocabulary renders, which is every client
 * ADE ships. A card carrying markup would have been desktop-only forever.
 */
describe("chat-card", () => {
  it("carries a panel and its frame, and nothing a client could fail to draw", () => {
    const payload = parsePluginContributionPayload("chat-card", {
      panelId: "risk",
      title: "Risk score",
      icon: "ShieldWarning",
    });
    expect(payload).toEqual({ panelId: "risk", title: "Risk score", icon: "ShieldWarning" });
    // The portability rule, asserted rather than described: everything a client
    // must understand to draw the card is a panel id plus two labels.
    expect(Object.keys(payload ?? {}).sort()).toEqual(["icon", "panelId", "title"]);
  });

  it("refuses a card with no panel to render", () => {
    expect(parsePluginContributionPayload("chat-card", { title: "Risk score" })).toBeNull();
  });

  // Buttons inside the card are the panel vocabulary's `button` node dispatching
  // the plugin's own actions, so the socket needs no action payload of its own.
  it("declares only its panel as required, leaving the buttons to the panel", () => {
    expect(PLUGIN_SOCKET_REQUIREMENTS["chat-card"])
      .toEqual({ manifest: ["panelId"], payload: ["panelId"] });
  });
});

describe("slash-command", () => {
  it("parses the word, its action, and the one line a command menu shows", () => {
    expect(parsePluginContributionPayload("slash-command", {
      command: "review",
      actionId: "review",
      description: "Review the current diff",
      argumentHint: "<pr-number>",
    })).toEqual({
      command: "review",
      actionId: "review",
      description: "Review the current diff",
      argumentHint: "<pr-number>",
    });
  });

  // A command with nothing to say about itself still works — requiring a
  // description would drop the whole contribution over a menu subtitle.
  it("treats the description and the argument hint as optional", () => {
    expect(parsePluginContributionPayload("slash-command", { command: "fix", actionId: "fix" }))
      .toEqual({ command: "fix", actionId: "fix" });
    expect(PLUGIN_SOCKET_REQUIREMENTS["slash-command"].payload).toEqual(["command", "actionId"]);
  });

  // A plugin author writes the slash; the client draws it. Both spellings have
  // to mean the same command or the menu shows "//review".
  it("accepts the leading slash an author will write, and normalizes case", () => {
    expect(normalizePluginSlashCommand("/review")).toBe("review");
    expect(normalizePluginSlashCommand("  /Review  ")).toBe("review");
    expect(parsePluginContributionPayload("slash-command", { command: "/Fix-It", actionId: "fix" }))
      .toEqual({ command: "fix-it", actionId: "fix" });
  });

  it("holds the word to the grammar a person types under time pressure", () => {
    expect(normalizePluginSlashCommand("ab")).toBe("ab");
    expect(normalizePluginSlashCommand(`a${"b".repeat(30)}`)).toBe(`a${"b".repeat(30)}`);
    for (const bad of ["a", "1st", "-lead", "has space", "has_underscore", `a${"b".repeat(31)}`, "", null, 7]) {
      expect(normalizePluginSlashCommand(bad)).toBeNull();
    }
  });

  it("refuses a command with nothing to invoke", () => {
    expect(parsePluginContributionPayload("slash-command", { command: "review" })).toBeNull();
    expect(parsePluginContributionPayload("slash-command", { actionId: "review" })).toBeNull();
  });

  // Same act as a composer button by a different gesture: `/transcribe` must
  // not time out where the button beside it succeeds.
  it("gets the composer's long budget, not the row default", () => {
    expect(pluginSocketInvokeTimeoutMs("slash-command")).toBe(PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS);
  });
});

describe("the ambient kinds", () => {
  it("gives a palette entry the same payload a toolbar button has", () => {
    expect(parsePluginContributionPayload("command-palette-action", { label: "Sync issues", actionId: "sync" }))
      .toEqual({ label: "Sync issues", actionId: "sync" });
    expect(parsePluginContributionPayload("command-palette-action", { label: "Sync issues" })).toBeNull();
  });

  // Settings page ids are ADE's own furniture and they move. A plugin naming
  // one this build has never heard of lands somewhere, rather than nowhere.
  it("keeps a settings section's page name opaque and optional", () => {
    expect(parsePluginContributionPayload("settings-section", { panelId: "prefs", section: "integrations" }))
      .toEqual({ panelId: "prefs", section: "integrations" });
    expect(parsePluginContributionPayload("settings-section", { panelId: "prefs" }))
      .toEqual({ panelId: "prefs" });
    expect(parsePluginContributionPayload("settings-section", { section: "integrations" })).toBeNull();
  });

  it("gives the rail and the drawer one shape, so moving one is a manifest edit", () => {
    const rail = parsePluginContributionPayload("work-rail-pane", { label: "Ports", panelId: "ports", icon: "Plug" });
    const drawer = parsePluginContributionPayload("drawer-tab", { label: "Ports", panelId: "ports", icon: "Plug" });
    expect(rail).toEqual(drawer);
    expect(rail).toEqual({ label: "Ports", panelId: "ports", icon: "Plug" });
    // A rail entry sits beside ADE's own one-word labels; a long one pushes them.
    expect(parsePluginContributionPayload("work-rail-pane", { label: "x".repeat(25), panelId: "ports" })).toBeNull();
    expect(parsePluginContributionPayload("drawer-tab", { label: "Ports" })).toBeNull();
  });

  it("folds an activity entry's tone by the house rule and requires a title", () => {
    expect(parsePluginContributionPayload("activity-entry", {
      title: "2 checks failed",
      body: "on lane fix-auth",
      tone: "danger",
      actionId: "open",
      actionLabel: "Open",
    })).toEqual({
      title: "2 checks failed",
      body: "on lane fix-auth",
      tone: "destructive",
      actionId: "open",
      actionLabel: "Open",
    });
    expect(parsePluginContributionPayload("activity-entry", { body: "orphaned" })).toBeNull();
  });
});

describe("dialog-section", () => {
  it("names its dialog in the payload, because two of them share a surface", () => {
    for (const dialog of PLUGIN_DIALOG_KINDS) {
      expect(parsePluginContributionPayload("dialog-section", { dialog, panelId: "issues" }))
        .toEqual({ dialog, panelId: "issues" });
    }
  });

  it("refuses a section with no dialog or no panel", () => {
    expect(parsePluginContributionPayload("dialog-section", { panelId: "issues" })).toBeNull();
    expect(parsePluginContributionPayload("dialog-section", { dialog: "create-lane" })).toBeNull();
    expect(parsePluginContributionPayload("dialog-section", { dialog: "delete-lane", panelId: "issues" })).toBeNull();
    expect(isPluginDialogKind("delete-lane")).toBe(false);
  });

  /**
   * The allowlist is the whole security story of `{dialog: {setField}}`.
   *
   * Every field a dialog owns that is NOT a value the user could have typed or
   * picked — the reclaim phrase, the discard-dirty checkbox, the delete
   * confirmation — must stay unreachable, or a section could arm a destructive
   * dialog and leave the user one keystroke from confirming it.
   */
  it("allowlists writable fields per dialog and reaches no confirmation control", () => {
    expect(isPluginDialogField("create-lane", "name")).toBe(true);
    expect(isPluginDialogField("create-pr", "body")).toBe(true);
    // A create-lane section cannot write a PR body, and no dialog can write a
    // field it does not have.
    expect(isPluginDialogField("create-lane", "body")).toBe(false);
    expect(isPluginDialogField("create-pr", "name")).toBe(false);
    for (const dialog of PLUGIN_DIALOG_KINDS) {
      const fields: readonly string[] = PLUGIN_DIALOG_FIELDS[dialog];
      expect(fields.length).toBeGreaterThan(0);
      for (const forbidden of ["reclaimConfirm", "discardDirtyConfirmed", "deleteRisk", "confirm", "submit"]) {
        expect(fields).not.toContain(forbidden);
        expect(isPluginDialogField(dialog, forbidden)).toBe(false);
      }
    }
  });
});

describe("contexts the new kinds hand a plugin", () => {
  function dialog(overrides: Partial<PluginDialogContext> = {}): PluginDialogContext {
    return {
      kind: "dialog",
      dialog: "manage-lane",
      laneId: "lane-1",
      laneName: "fix-auth",
      branch: "fix-auth",
      projectKey: "local:/repo",
      ...overrides,
    };
  }

  it("keys a dialog's dynamic rows on the lane it is about", () => {
    expect(pluginContributionKeyForContext(dialog()))
      .toEqual({ entityKind: "lane", entityId: "lane-1" });
  });

  // Create-lane has no subject yet. Keying on nothing would collide every
  // unopened lane onto one entity, the same trap the hero composer avoids.
  it("carries no entity key on create-lane, where nothing exists yet", () => {
    expect(pluginContributionKeyForContext(dialog({ dialog: "create-lane", laneId: null }))).toBeNull();
  });

  it("keys nothing for an activity entry, which names the row instead", () => {
    const activity: PluginActivityContext = {
      kind: "activity",
      entryId: "checks",
      projectKey: "local:/repo",
      laneId: null,
    };
    expect(pluginContributionKeyForContext(activity)).toBeNull();
    expect(activity.entryId).toBe("checks");
  });
});

describe("graph-node payloads", () => {
  it("needs only a label, and normalizes the tone like every other kind", () => {
    expect(parsePluginContributionPayload("graph-node", { label: "ADE-142" }))
      .toEqual({ label: "ADE-142", tone: "neutral" });
    expect(parsePluginContributionPayload("graph-node", { label: "ADE-142", tone: "Warning" }))
      .toEqual({ label: "ADE-142", tone: "warning" });
    expect(parsePluginContributionPayload("graph-node", { detail: "In review" })).toBeNull();
  });

  it("keeps the node when its edges are malformed", () => {
    // The same bargain a split button's menu gets: the node is what the plugin
    // asked for and the extra lines are the bonus, so a bad `edges` degrades to
    // an anchored node rather than deleting the annotation.
    const parsed = parsePluginContributionPayload("graph-node", {
      label: "ADE-142",
      edges: "not-an-array",
    });
    expect(parsed).toEqual({ label: "ADE-142", tone: "neutral" });
  });

  it("drops one bad edge and keeps the good ones beside it", () => {
    const parsed = parsePluginContributionPayload("graph-node", {
      label: "ADE-142",
      edges: [
        { to: { kind: "lane", id: "lane-a" }, kind: "tracks" },
        // No target kind the canvas can resolve — a session has no shape there.
        { to: { kind: "session", id: "chat-1" }, kind: "link" },
        // A word this build has never heard of. Refused rather than defaulted:
        // an edge that says something other than what the author wrote is worse
        // than no edge.
        { to: { kind: "lane", id: "lane-b" }, kind: "supersedes" },
        { to: { kind: "pr", id: "42" }, kind: "blocks", label: "waits" },
      ],
    });
    expect(parsed?.edges).toEqual([
      { to: { kind: "lane", id: "lane-a" }, kind: "tracks" },
      { to: { kind: "pr", id: "42" }, kind: "blocks", label: "waits" },
    ]);
  });

  it("truncates a node's edges at the cap rather than dropping the node", () => {
    const parsed = parsePluginContributionPayload("graph-node", {
      label: "ADE-142",
      edges: Array.from({ length: PLUGIN_GRAPH_NODE_EDGE_LIMIT + 3 }, (_unused, index) => ({
        to: { kind: "lane", id: `lane-${index}` },
        kind: "link",
      })),
    });
    expect(parsed?.edges).toHaveLength(PLUGIN_GRAPH_NODE_EDGE_LIMIT);
  });

  it("carries the cross-kind tag like every other kind", () => {
    // `id` names WHICH declaration a published node fills, and it is what
    // `listContributions` joins the row against — a graph node that lost it
    // would be dropped as undeclared.
    const parsed = parsePluginContributionPayload("graph-node", {
      label: "ADE-142",
      id: "issue",
      order: 2,
      filterKey: "mine",
    });
    expect(parsed).toMatchObject({ id: "issue", order: 2, filterKey: "mine" });
  });
});

describe("per-client socket support", () => {
  it("answers for every kind on every client", () => {
    for (const kind of PLUGIN_SOCKET_KINDS) {
      const support = PLUGIN_SOCKET_CLIENT_SUPPORT[kind];
      expect(support).toBeTruthy();
      for (const client of PLUGIN_CLIENT_SURFACES) {
        expect(typeof support[client]).toBe("boolean");
        expect(pluginSocketSupportedOn(kind, client)).toBe(support[client]);
      }
    }
  });

  // The honest current answer, and the one the skill's table has to match. iOS
  // decodes two kinds; the TUI renders panels only. A parity agent flipping one
  // of these updates this expectation in the same commit as the client arm.
  it("states what each client draws today", () => {
    expect(pluginSocketKindsSupportedOn("desktop")).toEqual([...PLUGIN_SOCKET_KINDS]);
    // iOS mounts the original eight plus the three chat/ambient kinds that have
    // a host on a phone. The five it skips have nowhere to go there: no command
    // palette, no Work tools rail, no chat actions drawer, no lane/PR dialogs,
    // and a flat Settings with no page ids to name.
    //
    // `chat-header-action` reaches the phone as rows in the chat's existing
    // overflow menu rather than as desktop's split button — a nav bar holds a
    // title and about two controls. That is the difference this list is allowed
    // to hide: it answers "does this client draw the kind", not "does it draw
    // the same chrome". Same contribution, same `PluginSessionContext`.
    expect(pluginSocketKindsSupportedOn("ios")).toEqual([
      "toolbar-action",
      "row-badge",
      "row-menu-item",
      "detail-section",
      "empty-state",
      "filter-chip",
      "file-viewer",
      "composer-action",
      "chat-header-action",
      "chat-card",
      "activity-entry",
    ]);
    // The TUI draws badges on drawer rows and lists menu items and toolbar
    // actions through `/plugin-actions`. Kept in step with
    // `PLUGIN_TUI_SOCKET_KINDS` in `tuiClient/pluginSockets.ts`.
    expect(pluginSocketKindsSupportedOn("tui")).toEqual([
      "toolbar-action",
      "row-badge",
      "row-menu-item",
    ]);
    // Web tracks desktop: same renderer components, and both reads now cross
    // the wire (declarations on `plugins.list`, rows via `plugins.contributions`).
    // It was uniformly empty until those landed, which is why the row moves
    // together rather than kind by kind.
    expect(pluginSocketKindsSupportedOn("web")).toEqual([...PLUGIN_SOCKET_KINDS]);
  });

  it("does not draw a kind it has never heard of", () => {
    expect(pluginSocketSupportedOn(null, "desktop")).toBe(false);
    expect(pluginSocketSupportedOn(undefined, "ios")).toBe(false);
    expect(pluginSocketSupportedOn("row-badges" as never, "desktop")).toBe(false);
  });
});

/**
 * The manifest path for the new kinds.
 *
 * Same account as the `composer-action` block above, generalized: a kind whose
 * requirements name only the four core `sockets[]` fields must parse today,
 * through the parser that already exists. The two kinds that need a NEW
 * manifest field say so in `manifestExtra` rather than by failing quietly.
 */
describe("declaring the new kinds in a plugin.json", () => {
  const manifestJson = (socket: Record<string, unknown>): string => JSON.stringify({
    name: "ade-tracker",
    version: "1.0.0",
    displayName: "Tracker",
    sockets: [socket],
  });

  it("parses a kind whose fields the manifest already carries", () => {
    const entries: Record<string, unknown>[] = [
      { socket: "chat-card", surface: "work", id: "risk", panelId: "risk" },
      { socket: "command-palette-action", surface: "app", id: "sync", label: "Sync", actionId: "sync" },
      { socket: "settings-section", surface: "settings", id: "prefs", panelId: "prefs" },
      { socket: "work-rail-pane", surface: "work", id: "ports", label: "Ports", panelId: "ports" },
      { socket: "drawer-tab", surface: "work", id: "issues", label: "Issues", panelId: "issues" },
      { socket: "activity-entry", surface: "app", id: "checks", label: "Checks" },
    ];
    for (const entry of entries) {
      const result = parsePluginManifestJson(manifestJson(entry));
      expect(result.errors).toEqual([]);
      expect(result.manifest?.sockets, `${String(entry.socket)} should survive parsing`).toHaveLength(1);
    }
  });

  it("drops a declaration missing the field its kind cannot render without", () => {
    const result = parsePluginManifestJson(manifestJson({
      socket: "work-rail-pane",
      surface: "work",
      id: "ports",
      panelId: "ports",
    }));
    expect(result.manifest?.sockets).toEqual([]);
    expect(result.warnings.join(" ")).toContain("label");
    expect(result.warnings.join(" ")).toContain("work-rail-pane");
  });

  // `command` and `dialog` mean nothing to any other kind, so the manifest
  // parser learns them one kind at a time. This is the list it reads.
  it("names the kinds that need a manifest field beyond the core four", () => {
    const extra = PLUGIN_SOCKET_KINDS.filter((kind) => PLUGIN_SOCKET_REQUIREMENTS[kind].manifestExtra?.length);
    expect(extra).toEqual(["slash-command", "dialog-section"]);
    expect(PLUGIN_SOCKET_REQUIREMENTS["slash-command"].manifestExtra).toEqual(["command"]);
    expect(PLUGIN_SOCKET_REQUIREMENTS["dialog-section"].manifestExtra).toEqual(["dialog"]);
  });
});

describe("the app and settings surfaces", () => {
  // The palette and the activity pane belong to the window, not to a tab, and a
  // settings section belongs to a page named in its payload. They are surfaces
  // because everything downstream of the field is identical.
  it("narrows the two subject-less surfaces like any other", () => {
    expect(isPluginSurfaceId("app")).toBe(true);
    expect(isPluginSurfaceId("settings")).toBe(true);
    expect(isPluginSurfaceId("palette")).toBe(false);
  });
});

describe("surface-scoped dynamic rows", () => {
  // The two questions one function used to be asked. "Which entity is this
  // contribution about" stays null for a toolbar — the filter path relies on
  // that null meaning "not filterable, keep it" — while "where does a plugin
  // address the tab itself" has a real answer.
  //
  // If you are here because you wanted to fold the second question into the
  // first: that is the change this test exists to stop. `entityMatchesPluginFilters`
  // reads the null as "keep it"; give a surface context a key and it starts
  // looking up filter keys for the surface, finds none, and returns false — so
  // selecting any filter chip silently hides every row on the tab. The two
  // clients that ship this taxonomy both keep them separate.
  it("keeps the filter key null while giving the surface a publish address", () => {
    const context: PluginSurfaceOnlyContext = { kind: "surface", surface: "lanes" };
    expect(pluginContributionKeyForContext(context)).toBeNull();
    expect(pluginSurfaceContributionKey("lanes")).toEqual({ entityKind: "surface", entityId: "lanes" });
  });

  // This is the address the phone reaches a surface-scoped kind by, since it
  // has no manifest feed and a declaration it never sees cannot render.
  it("answers for every surface, including the subject-less ones", () => {
    for (const surface of PLUGIN_SURFACE_IDS) {
      const key = pluginSurfaceContributionKey(surface);
      expect(key.entityKind).toBe("surface");
      expect(key.entityId).toBe(surface);
      expect(isPluginEntityKind(key.entityKind)).toBe(true);
    }
  });
});

describe("the extra-manifest-field union", () => {
  /**
   * Membership means REQUIRED. The union is the parser's drop list, so an
   * optional per-kind field added here would make a contribution that renders
   * perfectly well without it disappear instead — which is the same
   * "parses clean, contributes nothing" failure inverted.
   */
  it("holds only fields whose kind cannot render without them", () => {
    for (const kind of PLUGIN_SOCKET_KINDS) {
      for (const field of PLUGIN_SOCKET_REQUIREMENTS[kind].manifestExtra ?? []) {
        expect(PLUGIN_SOCKET_REQUIREMENTS[kind].payload).toContain(field);
      }
    }
    // `section`, `description` and `argumentHint` are optional per-kind fields.
    // They are read off the manifest entry and never gate the contribution.
    expect(PLUGIN_SOCKET_REQUIREMENTS["settings-section"].manifestExtra).toBeUndefined();
    expect(parsePluginContributionPayload("settings-section", { panelId: "prefs" }))
      .toEqual({ panelId: "prefs" });
  });
});

/**
 * Every kind has a parse arm, and every arm enforces its own requirements.
 *
 * The gate this closes: `parsePluginContributionPayload`'s switch ends in
 * `default: return null`, so a kind added to `PLUGIN_SOCKET_KINDS` without an
 * arm does not fail the build — it silently validates to nothing, which is the
 * "parses clean, contributes nothing" failure the requirement table exists to
 * prevent, one layer down. The fixture map is typed over the kind union, so
 * adding a kind fails to COMPILE here until someone writes it a payload, and
 * writing that payload is where a missing arm becomes obvious.
 *
 * iOS gets this property from an exhaustive Swift switch over the same union.
 * This is the TypeScript equivalent, and it is a test rather than a type
 * because the arm lives in a switch a generic parameter stops TS narrowing to
 * `never`.
 */
describe("payload arm coverage", () => {
  const MINIMAL_PAYLOADS: Record<PluginSocketKind, Record<string, unknown>> = {
    "toolbar-action": { label: "Sync", actionId: "sync" },
    "row-badge": { text: "3 findings" },
    "row-menu-item": { label: "Open", actionId: "open" },
    "detail-section": { panelId: "risk" },
    "empty-state": { title: "Nothing yet" },
    "filter-chip": { label: "Mine", filterKey: "mine" },
    "file-viewer": { panelId: "player", extensions: [".mp4"] },
    "composer-action": { label: "Refine", actionId: "refine" },
    "chat-header-action": { label: "Summarize", actionId: "summarize" },
    "chat-card": { panelId: "risk" },
    "slash-command": { command: "review", actionId: "review" },
    "command-palette-action": { label: "Sync", actionId: "sync" },
    "settings-section": { panelId: "prefs" },
    "work-rail-pane": { label: "Ports", panelId: "ports" },
    "drawer-tab": { label: "Issues", panelId: "issues" },
    "activity-entry": { title: "2 checks failed" },
    "graph-node": { label: "ADE-142" },
    "dialog-section": { dialog: "create-lane", panelId: "issues" },
  };

  it("parses a minimal valid payload for every kind in the taxonomy", () => {
    for (const kind of PLUGIN_SOCKET_KINDS) {
      expect(
        parsePluginContributionPayload(kind, MINIMAL_PAYLOADS[kind]),
        `${kind} has no parse arm, or its arm refuses its own minimal payload`,
      ).not.toBeNull();
    }
  });

  // The other half: an arm that accepts anything would pass the test above.
  // Every field the requirement table advertises has to actually be load-bearing.
  it("refuses the same payload with any one required field removed", () => {
    for (const kind of PLUGIN_SOCKET_KINDS) {
      for (const field of PLUGIN_SOCKET_REQUIREMENTS[kind].payload) {
        const partial = { ...MINIMAL_PAYLOADS[kind] };
        delete partial[field];
        expect(
          parsePluginContributionPayload(kind, partial),
          `${kind} still parsed without its required "${field}"`,
        ).toBeNull();
      }
    }
  });
});
