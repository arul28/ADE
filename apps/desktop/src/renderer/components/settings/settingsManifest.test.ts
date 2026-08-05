/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  availableSettingsEntries,
  setWebMachineBindingResolver,
  SETTINGS_TABS,
  settingsTabLabel,
  LEGACY_HASH_ALIASES,
  LEGACY_TAB_ALIASES,
  SETTINGS_ENTRIES,
  SETTINGS_TAB_IDS,
  resolveSettingsHash,
  resolveSettingsTab,
  searchSettingsEntries,
  settingsEntryPath,
  settingsGroupsForTab,
  settingsRouteFor,
} from "./settingsManifest";

/**
 * The manifest is the only thing keeping the nav, the Cmd-K palette, and every
 * legacy deeplink in agreement. These tests are the mitigation for the main
 * regression risk of the settings rewrite: a legacy route that silently
 * resolves to the wrong page is invisible in review but very visible to users.
 */
describe("settings manifest", () => {
  it("gives every tab at least one setting", () => {
    for (const tab of SETTINGS_TABS) {
      const entries = SETTINGS_ENTRIES.filter((entry) => entry.tab === tab.id);
      expect(entries, `tab "${tab.id}" has no settings`).not.toHaveLength(0);
    }
  });

  it("keeps entry ids and anchors unique", () => {
    const ids = SETTINGS_ENTRIES.map((entry) => entry.id);
    const anchors = SETTINGS_ENTRIES.map((entry) => entry.anchor);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("namespaces every entry id under its tab", () => {
    for (const entry of SETTINGS_ENTRIES) {
      expect(entry.id.startsWith(`${entry.tab}.`), `${entry.id} is not under ${entry.tab}`).toBe(true);
    }
  });

  it("routes every entry to its own tab and anchor", () => {
    for (const entry of SETTINGS_ENTRIES) {
      expect(settingsEntryPath(entry)).toBe(`/settings?tab=${entry.tab}#${entry.anchor}`);
    }
  });

  it("builds a live route for every id in-app CTAs link to", () => {
    // The banners, callouts and empty states across the app now name settings
    // by manifest id instead of hand-writing `?tab=...#anchor`. If a setting is
    // renamed or dropped, this list is where it fails — loudly — instead of a
    // CTA quietly dumping the user on the settings root.
    const ctaIds = [
      "integrations.github",
      "integrations.linear",
      "agents.providers",
      "agents.background-jobs",
      "agents.dictation",
      "general.launch-prompt",
      "lanes-git.lane-templates",
      "storage.usage",
      "storage.diagnostics",
    ];
    for (const id of ctaIds) {
      expect(settingsRouteFor(id), `${id} has no manifest entry`).not.toBe("/settings");
    }
    expect(settingsRouteFor("integrations.github")).toBe("/settings?tab=integrations#github-connection");
    expect(settingsRouteFor("nope.missing")).toBe("/settings");
  });

  it("resolves current tab ids unchanged", () => {
    for (const id of SETTINGS_TAB_IDS) {
      expect(resolveSettingsTab(id)).toBe(id);
    }
  });

  it("resolves every legacy tab alias to a live tab", () => {
    for (const [legacy, target] of Object.entries(LEGACY_TAB_ALIASES)) {
      expect(SETTINGS_TAB_IDS).toContain(target);
      expect(resolveSettingsTab(legacy), `alias "${legacy}" did not resolve`).toBe(target);
    }
  });

  it("resolves every legacy hash alias to a live entry", () => {
    for (const [legacy, entryId] of Object.entries(LEGACY_HASH_ALIASES)) {
      const resolved = resolveSettingsHash(legacy);
      expect(resolved, `hash "${legacy}" did not resolve`).not.toBeNull();
      expect(resolved?.id).toBe(entryId);
    }
  });

  it("follows the legacy Activity-settings aliases already in the wild", () => {
    // `?tab=notifications#attention-notch` shipped in tour steps and deeplinks
    // before Activity had a tab of its own. Landing those on Notifications —
    // which no longer holds the card — would be an invisible dead end.
    for (const [hash, expectedTab] of [
      ["attention-notch", "activity"],
      ["celebrations", "activity"],
      ["attention-sounds", "activity"],
      ["hide-previews", "activity"],
    ] as const) {
      const entry = resolveSettingsHash(hash);
      expect(entry, `hash "${hash}" did not resolve`).not.toBeNull();
      expect(entry!.tab).toBe(expectedTab);
    }
    expect(resolveSettingsTab("attention")).toBe("activity");
  });

  it("resolves a live anchor directly, without needing an alias", () => {
    for (const entry of SETTINGS_ENTRIES) {
      expect(resolveSettingsHash(entry.anchor)?.id).toBe(entry.id);
      expect(resolveSettingsHash(`#${entry.anchor}`)?.id).toBe(entry.id);
    }
  });

  it("keeps the tab ids ADE shipped before the nine-tab split resolvable", () => {
    // The pre-rewrite SECTIONS list plus every key of the old TAB_ALIASES map.
    const shipped = [
      "general", "appearance", "ai", "secrets", "background-jobs",
      "lane-templates", "storage", "ade-usage",
      "workspace", "project", "context", "providers", "automations",
      "integrations", "sync", "devices", "multi-device", "github", "linear",
      "computer-use", "onboarding", "help", "tours", "usage", "stats", "disk",
      "secret",
    ];
    for (const id of shipped) {
      expect(resolveSettingsTab(id), `shipped tab id "${id}" no longer resolves`).not.toBeNull();
    }
  });

  it("drops the keybindings alias, which pointed at a tab with no keybindings UI", () => {
    expect(resolveSettingsTab("keybindings")).toBeNull();
  });

  it("returns null for unknown and empty tab values so callers can fall back", () => {
    expect(resolveSettingsTab("not-a-tab")).toBeNull();
    expect(resolveSettingsTab("")).toBeNull();
    expect(resolveSettingsTab(null)).toBeNull();
    expect(resolveSettingsHash("not-an-anchor")).toBeNull();
  });

  it("finds the auto-rebase toggle by its plain name — the Cmd-K case that failed before", () => {
    const results = searchSettingsEntries("rebase");
    const ids = results.map((entry) => entry.id);
    expect(ids).toContain("lanes-git.auto-rebase");
    expect(ids).toContain("lanes-git.rebase-suggestions");
    // Label matches outrank keyword-only matches.
    expect(results[0]?.tab).toBe("lanes-git");
  });

  it("finds settings by keyword when the label does not contain the query", () => {
    expect(searchSettingsEntries("telemetry").map((e) => e.id)).toContain("general.analytics");
    expect(searchSettingsEntries("api key").map((e) => e.id)).toContain("secrets.secrets");
    expect(searchSettingsEntries("banner").map((e) => e.id)).toContain("lanes-git.rebase-suggestions");
    expect(searchSettingsEntries("do not disturb").map((e) => e.id)).toContain("notifications.focus-suppression");
    expect(searchSettingsEntries("all machines").map((e) => e.id)).toContain("activity.dock-badge");
  });

  it("returns nothing for a blank query rather than every setting", () => {
    expect(searchSettingsEntries("")).toHaveLength(0);
    expect(searchSettingsEntries("   ")).toHaveLength(0);
  });

  it("lists a tab's groups in first-appearance order with no duplicates", () => {
    const groups = settingsGroupsForTab("lanes-git");
    expect(groups[0]).toBe("Starting lanes");
    expect(groups).toContain("Rebase & stacking");
    expect(new Set(groups).size).toBe(groups.length);
  });

  it("only marks scope chips on settings whose storage would surprise", () => {
    // Team-scoped settings always warrant the chip: they are committed and
    // affect other people.
    for (const entry of SETTINGS_ENTRIES.filter((candidate) => candidate.scope === "team")) {
      expect(entry.showScopeChip, `${entry.id} is team-scoped but hides its chip`).toBe(true);
    }
    // App-scoped settings never do — nothing about localStorage surprises.
    for (const entry of SETTINGS_ENTRIES.filter((candidate) => candidate.scope === "app")) {
      expect(entry.showScopeChip ?? false, `${entry.id} is app-scoped but shows a chip`).toBe(false);
    }
  });
});

type PaletteCommand = { id: string; title: string; hint: string; keywords: string[]; path: string };

function buildPaletteCommands(): PaletteCommand[] {
  return [
    ...SETTINGS_TABS.map((tab) => ({
      id: `go-settings-${tab.id}`,
      title: `Go to ${tab.label}`,
      hint: tab.description,
      keywords: [] as string[],
      path: `/settings?tab=${tab.id}`,
    })),
    ...SETTINGS_ENTRIES.map((entry) => ({
      id: `setting-${entry.id}`,
      title: entry.label,
      hint: `${settingsTabLabel(entry.tab)} · ${entry.group}`,
      keywords: [...entry.keywords],
      path: settingsEntryPath(entry),
    })),
  ];
}

/** Mirrors the palette's own filter. */
function filterPalette(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  return commands.filter((command) =>
    command.title.toLowerCase().includes(needle)
    || command.hint.toLowerCase().includes(needle)
    || command.keywords.some((keyword) => keyword.toLowerCase().includes(needle)));
}

describe("settings command palette entries", () => {
  const commands = buildPaletteCommands();

  it("emits a command per tab and per setting", () => {
    expect(commands).toHaveLength(SETTINGS_TABS.length + SETTINGS_ENTRIES.length);
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
  });

  it("finds the auto-rebase toggle by name and routes to its card", () => {
    const results = filterPalette(commands, "rebase");
    const autoRebase = results.find((command) => command.id === "setting-lanes-git.auto-rebase");
    expect(autoRebase).toBeDefined();
    expect(autoRebase!.title).toBe("Auto-rebase child lanes");
    expect(autoRebase!.hint).toContain("Lanes & Git");
    expect(autoRebase!.path).toBe("/settings?tab=lanes-git#auto-rebase");
  });

  it("surfaces the rebase notification control for the same query", () => {
    const ids = filterPalette(commands, "rebase").map((command) => command.id);
    expect(ids).toContain("setting-lanes-git.rebase-suggestions");
  });

  it("reaches settings whose label does not contain the query", () => {
    const cases: [string, string][] = [
      ["telemetry", "setting-general.analytics"],
      ["font size", "setting-appearance.chat-font-size"],
      ["scrollback", "setting-appearance.terminal"],
      ["do not disturb", "setting-notifications.focus-suppression"],
      ["api key", "setting-secrets.secrets"],
    ];
    for (const [query, expectedId] of cases) {
      const ids = filterPalette(commands, query).map((command) => command.id);
      expect(ids, `"${query}" did not reach ${expectedId}`).toContain(expectedId);
    }
  });

  it("routes every command to a settings URL", () => {
    for (const command of commands) {
      expect(command.path.startsWith("/settings?tab=")).toBe(true);
    }
  });

  it("agrees with the manifest's own search on which entries match", () => {
    for (const query of ["rebase", "theme", "sound", "storage"]) {
      const paletteIds = new Set(
        filterPalette(commands, query)
          .filter((command) => command.id.startsWith("setting-"))
          .map((command) => command.id.slice("setting-".length)),
      );
      // The manifest's search is the narrower of the two (it does not match on
      // the tab/group hint), so everything it finds must be in the palette.
      for (const entry of searchSettingsEntries(query)) {
        expect(paletteIds, `palette missed ${entry.id} for "${query}"`).toContain(entry.id);
      }
    }
  });
});

/**
 * A machine-scoped setting on the hosted client writes to whichever machine the
 * active project tab is bound to. With no tab open there is no such machine, so
 * the control has nowhere to write — the same condition `hidden` describes.
 */
describe("web machine-scoped availability", () => {
  afterEach(() => {
    setWebMachineBindingResolver(null);
    delete (window as { __adeWebClient?: boolean }).__adeWebClient;
  });

  const machineEntryIds = () => new Set(
    SETTINGS_ENTRIES.filter((entry) => entry.web === "machine").map((entry) => entry.id),
  );

  it("keeps every setting on the desktop, bound or not", () => {
    expect(availableSettingsEntries()).toHaveLength(SETTINGS_ENTRIES.length);
  });

  it("drops machine-scoped settings on web while no project tab is bound", () => {
    (window as { __adeWebClient?: boolean }).__adeWebClient = true;
    const available = new Set(availableSettingsEntries().map((entry) => entry.id));
    for (const id of machineEntryIds()) expect(available.has(id)).toBe(false);
  });

  it("restores them once a tab is bound", () => {
    (window as { __adeWebClient?: boolean }).__adeWebClient = true;
    setWebMachineBindingResolver(() => true);
    const available = new Set(availableSettingsEntries().map((entry) => entry.id));
    for (const id of machineEntryIds()) expect(available.has(id)).toBe(true);
  });
});
