/**
 * The settings registry — single source of truth for the settings page nav,
 * the Cmd-K palette, and legacy route resolution.
 *
 * Before this existed, each of those three read from its own hand-maintained
 * list: `SECTIONS` in `SettingsPage.tsx`, eight hardcoded palette commands in
 * `CommandPalette.tsx`, and the `TAB_ALIASES` / `HASH_TARGET_SECTIONS` pair.
 * They drifted — settings existed that no palette entry could reach, and
 * aliases pointed at tabs whose content had moved.
 *
 * Adding a setting here makes it navigable, searchable, and deep-linkable at
 * once. `settingsManifest.test.ts` asserts the anchors and aliases stay live.
 */

import { PROVIDER_DISPLAY_NAME } from "../../../shared/providers";
import { SCOPE_COPY, type SettingScope, type SettingWebScope } from "../../../shared/types/settingsScope";
import { isMacPlatform } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";

/**
 * The scope vocabulary lives in `shared/types/settingsScope.ts`, not here.
 *
 * `shared/accountSettingsScope.ts` decides which key a setting files under in
 * the account store and needs `SettingScope` to do it; a shared module that
 * imports a renderer component file is an inversion the main process
 * eventually trips over. The manifest re-exports both types so every existing
 * `from "./settingsManifest"` import keeps working.
 */
export type { SettingScope, SettingWebScope } from "../../../shared/types/settingsScope";

export const SETTINGS_TAB_IDS = [
  "overview",
  "account",
  "chat",
  "notifications",
  "mcp",
  "stats",
  // Project → Lanes keeps the id `lanes-git` so every link ever shipped to it
  // still lands.
  "lanes-git",
  "project-agents",
  // Project → Storage & cleanup: the space, archive and cleanup rules that
  // used to share the Lanes page. `?tab=storage` was Health's id; it lands here.
  "storage",
  "location",
  "secrets",
  "integrations",
  "service",
  "agents",
  "apple",
  "appearance",
  "behaviour",
  "ade-mcp",
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

/**
 * The sidebar: Overview on its own, then three groups, one per place a setting
 * can live:
 *
 *  - **You** applies everywhere you sign in.
 *  - **Project** is the open project. Its pages always act on the machine that
 *    owns the project (the tab's binding), so they have no machine picker, and
 *    they are not shown when no project is open.
 *  - **Computer** is one entry per machine (This computer, then each connected
 *    one). Its pages read and write through that machine's pin.
 *
 * The group IS the scope — that is the whole reorganisation in one sentence.
 * The ids (`account`, `machines`) predate the labels and stay as they are.
 */
export type SettingsGroupId = "overview" | "account" | "project" | "machines";

export type SettingsTab = {
  id: SettingsTabId;
  label: string;
  /**
   * One line under the tab title. Optional, and deliberately absent on pages
   * whose own contents already say what they are — a caption that restates the
   * title is scaffolding, not information.
   */
  description?: string;
  /**
   * Which sidebar group this page sits in, and therefore where it saves.
   *
   * A page's group must agree with its entries' scopes. `settingsManifest.test`
   * asserts that, because a page filed under "This computer" whose settings
   * actually sync to the account is precisely the lie this overhaul exists to
   * remove.
   */
  group: SettingsGroupId;
};

export type SettingsGroup = {
  id: SettingsGroupId;
  /** Null means "use the repository's own name", resolved by the renderer. */
  label: string | null;
  /**
   * The scope this group's pages save at. No longer drawn as a badge — it
   * feeds `groupScopeHint`, the sidebar heading's hover line.
   */
  scope: SettingScope;
};

/**
 * Render order: broadest reach to narrowest.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  // Overview is one row above the groups, with no heading of its own.
  { id: "overview", label: "Overview", scope: "account" },
  { id: "account", label: "You", scope: "account" },
  { id: "project", label: "Project", scope: "account-repo" },
  // The Computer group lists machines, not pages; its pages hang under the
  // selected machine. Machine names come from `shared/machineIdentity`.
  { id: "machines", label: "Computer", scope: "machine" },
] as const;

/** The pages that exist once per machine (the Computer group). */
export const MACHINE_SETTINGS_TAB_IDS: readonly SettingsTabId[] = ["service", "agents", "apple", "appearance", "behaviour", "ade-mcp"];

export function isMachineSettingsTab(tab: SettingsTabId): boolean {
  return MACHINE_SETTINGS_TAB_IDS.includes(tab);
}

/**
 * The open project's pages. They always act on the machine that owns the
 * project (the tab's binding), never on a picked machine.
 */
export const PROJECT_SETTINGS_TAB_IDS: readonly SettingsTabId[] = ["lanes-git", "project-agents", "storage", "location", "secrets", "integrations"];

export function isProjectSettingsTab(tab: SettingsTabId): boolean {
  return PROJECT_SETTINGS_TAB_IDS.includes(tab);
}

/**
 * Machines pages that describe the screen in front of you, not the machine's
 * runtime. Appearance is painted by the window you are looking at and kept in
 * its own storage, so it has one page, under This computer. Apple devices is
 * edited from the computer whose simulators it drives. A remote machine has no
 * copy of either to show or edit from here.
 */
export const THIS_COMPUTER_ONLY_TAB_IDS: readonly SettingsTabId[] = ["appearance", "apple"];

export function isThisComputerOnlyTab(tab: SettingsTabId): boolean {
  return THIS_COMPUTER_ONLY_TAB_IDS.includes(tab);
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  // ── Overview: where Settings opens ─────────────────────────────────────
  // No description: the page is what needs attention, then a glance at each area.
  { id: "overview", label: "Overview", group: "overview" },

  // ── You: applies everywhere ─────────────────────────────────────────────
  // No description: the page opens on your name and email.
  { id: "account", label: "Account", group: "account" },
  { id: "chat", label: "Chat", description: "How the chat transcript reads, and what the composer does.", group: "account" },
  { id: "notifications", label: "Notifications", description: "What ADE tells you about running work, and where.", group: "account" },
  // The list follows the account. The page also shows what this computer and
  // this project do with it, because that is where a server is switched off.
  { id: "mcp", label: "MCP servers", description: "Tools you add once. Every ADE agent gets them, on every computer.", group: "account" },
  { id: "stats", label: "Usage", description: "Spend and pacing across your providers and machines.", group: "account" },

  // ── Project: the open project, on the machine that owns it ──────────────
  { id: "lanes-git", label: "Lanes", description: "Every lane in this project, and how new ones start and stay current.", group: "project" },
  { id: "project-agents", label: "Agents", description: "What agents keep about this project: their notes, and PR chat transcripts.", group: "project" },
  { id: "storage", label: "Storage & cleanup", description: "The space this project takes, the archive, and what ADE cleans up.", group: "project" },
  { id: "location", label: "Location", description: "Where this project lives, and anything that needs fixing there.", group: "project" },
  { id: "secrets", label: "Secrets", description: "This project, on every computer.", group: "project" },
  { id: "integrations", label: "Integrations", description: "GitHub, Linear and Jira for this project.", group: "project" },

  // ── Computer: one set of these pages per machine ───────────────────────
  { id: "service", label: "ADE service", description: "The background service, version and updates, and the ade command.", group: "machines" },
  // No description. The page is a list of named providers with their status —
  // a sentence restating that above it is the caption the owner called out.
  { id: "agents", label: "Providers", group: "machines" },
  // Apple devices is per computer: each Mac has its own simulators and its own
  // network. Values are filed under this device's account scope so the brain
  // on this computer can read the remote streaming cap (see accountSettingsSync).
  { id: "apple", label: "Apple devices", description: "Simulator display, recording overlays, and remote streaming on this computer.", group: "machines" },
  // Appearance is per computer: each screen has its own theme, fonts and
  // terminal, and none of it follows the account.
  { id: "appearance", label: "Appearance", description: "How ADE looks on this computer: theme, fonts and terminal.", group: "machines" },
  { id: "behaviour", label: "Behaviour", description: "Sleep, screen capture, links, and the ADE browser.", group: "machines" },
  // Per computer: each machine is its own MCP server, switched on separately.
  { id: "ade-mcp", label: "ADE MCP", description: "Let AI apps like claude.ai, ChatGPT and Cursor run ade on this computer.", group: "machines" },
] as const;

/**
 * One sentence saying what a group's placement means, shown on hover.
 *
 * The group name alone says where a setting lives but not what that costs or
 * buys, and "This computer" is exactly the label a user reads as a warning when
 * it is meant as a fact.
 *
 * The wording is not written here. It is `SCOPE_COPY`, looked up through the
 * group's own scope — three hand-written copies of this sentence had already
 * drifted into disagreeing about what "repo" means.
 */
export function groupScopeHint(group: SettingsGroupId): string {
  const scope = SETTINGS_GROUPS.find((entry) => entry.id === group)?.scope ?? "account";
  const copy = SCOPE_COPY[scope];
  return `Stored in: ${copy.storedIn}. Affects: ${copy.affects}`;
}

/**
 * Where Settings opens, and where an unrecognised `?tab=` lands.
 *
 * Named rather than positional. It used to be `tabs[0]`, so reordering the
 * sidebar silently moved the default landing page — the kind of change that is
 * invisible in review and obvious to a user who opens Settings every day.
 */
export const DEFAULT_SETTINGS_TAB: SettingsTabId = "overview";

/**
 * Where `/account` lands inside a project. The standalone account page is
 * kept for surfaces with no project (welcome, projectless chats).
 */
export const ACCOUNT_SETTINGS_ROUTE = "/settings?tab=account";

export type SettingEntry = {
  /** Stable dotted id, `<tab>.<slug>`. Used by tests and telemetry, not URLs. */
  id: string;
  /** Human label — what the palette shows and what the card is titled. */
  label: string;
  /** Extra search terms. The label is always matched; don't repeat its words. */
  keywords: string[];
  tab: SettingsTabId;
  /** DOM id of the card, so `?tab=<tab>#<anchor>` lands on it. */
  anchor: string;
  scope: SettingScope;
  /** How the setting behaves in the hosted web client. */
  web: SettingWebScope;
  /** Group heading the card sits under, within its tab. */
  group: string;
  /**
   * Only the hosted web client renders this card. The desktop reaches the same
   * controls another way (provider accounts live on each provider's page), so
   * its nav, search and palette must not offer an anchor it never draws.
   */
  webOnly?: true;
  /** Only macOS has this capability; elsewhere nav, search and the palette never offer it. */
  macOnly?: true;
};

/**
 * Every setting ADE exposes. Order within a tab is the render order.
 */
export const SETTINGS_ENTRIES: readonly SettingEntry[] = [
  // ── Account ──────────────────────────────────────────────────────────────
  {
    id: "account.profile",
    label: "Account",
    keywords: ["profile", "sign in", "sign out", "log out", "email", "avatar", "macs", "computers", "identity"],
    tab: "account",
    anchor: "account-profile",
    scope: "account",
    web: "account",
    group: "Account",
  },
  {
    id: "account.computers",
    label: "Your computers",
    keywords: ["computers", "machines", "macs", "reconnect", "this computer", "account directory"],
    tab: "account",
    anchor: "account-computers",
    scope: "account",
    web: "account",
    group: "Account",
  },

  // ── MCP servers ──────────────────────────────────────────────────────────
  // Hidden on the hosted web client: a browser has no account-settings or
  // vault bridge, and the checks and the import read files on a computer.
  {
    id: "mcp.servers",
    label: "MCP servers",
    keywords: ["mcp", "model context protocol", "tools", "server", "stdio", "http", "sse", "context7", "registry", "header", "env", "secret", "token"],
    tab: "mcp",
    anchor: "mcp-servers",
    scope: "account",
    web: "hidden",
    group: "In your account",
  },
  {
    id: "mcp.found",
    label: "Import MCP servers from this computer",
    keywords: ["mcp", "import", "claude", "codex", "cursor", "opencode", "droid", "found", "config", "mcp.json", "config.toml"],
    tab: "mcp",
    anchor: "mcp-found",
    scope: "account",
    web: "hidden",
    group: "Found on this computer",
  },

  // ── Overview ─────────────────────────────────────────────────────────────
  // Settings opens here. Both cards read this computer over plain IPC and the
  // open project through the tab's binding, which a browser has neither of.
  {
    id: "overview.attention",
    label: "Needs attention",
    keywords: ["problems", "issues", "fix", "health", "doctor", "broken", "warnings", "errors", "check"],
    tab: "overview",
    anchor: "needs-attention",
    scope: "machine",
    web: "hidden",
    group: "Overview",
  },
  {
    id: "overview.glance",
    label: "At a glance",
    keywords: ["summary", "status", "version", "disk", "free space", "lanes", "usage", "sign in", "dashboard"],
    tab: "overview",
    anchor: "at-a-glance",
    scope: "machine",
    web: "hidden",
    group: "Overview",
  },

  // ── Computer → ADE service ───────────────────────────────────────────────
  {
    id: "general.background-service",
    label: "Background service",
    keywords: ["background", "service", "brain", "stop", "quit", "agents", "login item", "daemon", "runtime"],
    tab: "service",
    anchor: "background-service",
    scope: "machine",
    // Stopping the service is a desktop action on this computer.
    web: "hidden",
    group: "Background service",
  },
  {
    id: "general.quit-confirmation",
    label: "Ask before quitting",
    keywords: ["quit", "close", "exit", "confirm", "background", "agents", "don't ask again"],
    tab: "service",
    anchor: "quit-confirmation",
    scope: "machine",
    // The question is asked by the desktop app when it quits.
    web: "hidden",
    group: "Background service",
  },
  {
    id: "storage.diagnostics",
    label: "Service status",
    keywords: ["diagnostics", "debug", "health", "troubleshoot", "slow", "failed", "memory", "repair", "restart", "brain", "service"],
    tab: "service",
    anchor: "diagnostics",
    scope: "machine",
    web: "hidden",
    group: "Background service",
  },
  {
    id: "general.about",
    label: "About ADE",
    keywords: ["version", "build", "license", "logs", "support"],
    tab: "service",
    anchor: "about",
    scope: "machine",
    web: "hidden",
    group: "Version and updates",
  },
  {
    id: "general.auto-updates",
    label: "Automatic updates",
    keywords: ["update", "upgrade", "release", "channel", "version"],
    tab: "service",
    anchor: "auto-updates",
    scope: "machine",
    web: "hidden",
    group: "Version and updates",
  },
  {
    id: "general.update-other-machines",
    label: "Update other machines",
    keywords: ["update", "upgrade", "version", "machines", "computers", "remote", "update all", "restart"],
    tab: "service",
    anchor: "update-other-machines",
    scope: "machine",
    // A browser cannot ask a machine to update itself.
    web: "hidden",
    group: "Version and updates",
  },
  {
    id: "general.ade-cli",
    label: "ADE command line",
    keywords: ["cli", "terminal", "ade code", "install", "path", "shell"],
    tab: "service",
    anchor: "ade-cli",
    scope: "machine",
    web: "hidden",
    group: "Command line",
  },
  {
    id: "general.diagnostics-sharing",
    // Not plain "Diagnostics": `storage.diagnostics` already owns that label,
    // and two identically named search hits pointing at different tabs is a
    // coin flip for whoever is looking for the report button.
    label: "Send a report to ADE",
    keywords: ["diagnostics", "crash", "report", "report issue", "error", "send", "support"],
    tab: "service",
    anchor: "diagnostics-sharing",
    scope: "machine",
    // The report is built on this machine by the desktop app; a browser cannot build one.
    web: "hidden",
    group: "Privacy",
  },
  {
    id: "general.reset",
    label: "Reset ADE",
    keywords: ["reset", "uninstall", "remove", "wipe", "start over", "fresh install", "broken"],
    tab: "service",
    anchor: "reset-ade",
    scope: "machine",
    web: "hidden",
    group: "Reset",
  },

  // ── Computer → Behaviour ─────────────────────────────────────────────────
  {
    id: "general.keep-awake",
    label: "Keep this computer awake",
    keywords: ["sleep", "awake", "lid", "idle", "power", "battery", "caffeinate", "pmset"],
    tab: "behaviour",
    anchor: "keep-awake",
    scope: "machine",
    // A browser holds no power lock and cannot read the machine's sleep
    // settings, so the write would resolve against nothing.
    web: "hidden",
    group: "Sleep",
  },
  {
    id: "ade-mcp.server",
    label: "ADE MCP: let AI apps use this computer",
    keywords: ["mcp", "ade mcp", "remote", "server", "claude.ai", "chatgpt", "cursor", "grok", "connector", "token", "oauth", "relay", "ai apps"],
    tab: "ade-mcp",
    anchor: "ade-mcp",
    scope: "machine",
    // Granting an outside app a machine is done from a desktop that reaches
    // it, never from a browser tab.
    web: "hidden",
    group: "ADE MCP",
  },
  {
    id: "general.capture-gesture",
    label: "Capture with a key gesture",
    keywords: ["screenshot", "capture", "screen", "gesture", "command", "ctrl", "window", "cto", "shortcut"],
    tab: "behaviour",
    anchor: "capture-gesture",
    scope: "machine",
    // A browser tab cannot watch the keyboard outside itself or read another
    // window's pixels, and the setting drives a native helper that only the
    // desktop main process can run.
    web: "hidden",
    group: "Screen capture",
  },
  {
    id: "general.link-open-mode",
    label: "Open links",
    keywords: ["browser", "external", "system browser", "in-app", "click", "url", "hyperlink"],
    tab: "behaviour",
    anchor: "link-open-mode",
    scope: "machine-repo",
    // The built-in browser is an Electron surface with a machine-local profile;
    // a hosted tab has neither, and its own browser already owns link handling.
    web: "hidden",
    group: "Links",
  },
  {
    id: "general.browser-agent-access",
    label: "Agents can use the ADE browser",
    keywords: ["browser", "agent", "approve", "approval", "allow", "block", "lane", "chat", "permission", "consent", "signed in"],
    tab: "behaviour",
    anchor: "browser-agent-access",
    scope: "machine",
    // The ADE browser and its signed-in profile live in the desktop main
    // process; a hosted tab has neither.
    web: "hidden",
    group: "ADE browser",
  },
  {
    id: "general.browser-settings",
    label: "Tabs and downloads",
    // No "browser" here on purpose: the access entry already owns that word in
    // search, and a second match reordered the command palette's thread results.
    keywords: ["tabs", "tab limit", "downloads", "download folder", "save", "directory"],
    tab: "behaviour",
    anchor: "browser-settings",
    scope: "machine",
    web: "hidden",
    group: "ADE browser",
  },
  {
    id: "general.browser-auto-grant",
    label: "Agents and site permissions",
    keywords: ["camera", "microphone", "location", "geolocation", "permission", "auto", "approve"],
    tab: "behaviour",
    anchor: "browser-auto-grant",
    scope: "machine",
    web: "hidden",
    group: "ADE browser",
  },

  // ── Project → Location ───────────────────────────────────────────────────
  {
    id: "general.project-location",
    label: "Project location",
    keywords: ["move", "relocate", "drive", "disk", "external", "folder", "path", "space", "storage"],
    tab: "location",
    anchor: "project-location",
    scope: "machine",
    web: "hidden",
    group: "Location",
    // Moving needs macOS's copy and drive tools.
    macOnly: true,
  },

  {
    id: "storage.project-health",
    label: "Project checks",
    keywords: ["issues", "problems", "fix", "check", "moved", "paths", "doctor", "broken", "health", "dependencies", "venv", "trust", "git links"],
    tab: "location",
    anchor: "project-health",
    scope: "machine-repo",
    web: "hidden",
    group: "Checks",
  },

  // ── Appearance ───────────────────────────────────────────────────────────
  {
    id: "appearance.theme",
    label: "Theme",
    keywords: ["dark", "light", "color", "accent", "import", "export", "vscode", "palette", "corners", "shadow", "backdrop", "scanlines", "serif", "monospace"],
    tab: "appearance",
    anchor: "theme",
    scope: "machine",
    web: "browser",
    group: "Theme",
  },
  {
    id: "appearance.background",
    label: "Background",
    keywords: ["wallpaper", "picture", "image", "photo", "scene", "shuffle", "gradient", "background"],
    tab: "appearance",
    anchor: "background",
    scope: "machine",
    web: "browser",
    group: "Background",
  },
  {
    id: "appearance.chat-font-size",
    label: "Chat font size",
    keywords: ["text size", "typography", "zoom", "bigger", "smaller"],
    tab: "chat",
    anchor: "chat-font-size",
    scope: "account",
    web: "browser",
    group: "Transcript",
  },
  {
    id: "appearance.transcript-density",
    label: "Transcript density",
    keywords: ["compact", "comfortable", "spacious", "spacing"],
    tab: "chat",
    anchor: "transcript-density",
    scope: "account",
    web: "browser",
    group: "Transcript",
  },
  {
    id: "appearance.chat-tint",
    label: "Runtime color",
    keywords: ["chat tint", "tint", "color", "colored mode", "runtime color"],
    tab: "chat",
    anchor: "chat-tint",
    scope: "account",
    web: "browser",
    group: "Transcript",
  },
  {
    id: "appearance.chat-corners",
    label: "Chat corners",
    keywords: ["radius", "rounded", "sharp", "soft", "geometry"],
    tab: "chat",
    anchor: "chat-corners",
    scope: "account",
    web: "browser",
    group: "Transcript",
  },
  {
    id: "appearance.code-block-copy",
    label: "Code block copy button",
    keywords: ["copy", "snippet", "float", "top", "bottom"],
    tab: "chat",
    anchor: "code-block-copy-position",
    scope: "account",
    web: "browser",
    group: "Details",
  },
  {
    id: "appearance.message-minimap",
    label: "Message minimap",
    keywords: ["minimap", "gutter", "tick", "jump", "navigate"],
    tab: "chat",
    anchor: "user-message-minimap",
    scope: "account",
    web: "browser",
    group: "Details",
  },
  {
    id: "appearance.drafts",
    label: "Drafts button",
    keywords: ["bookmark", "stash", "composer", "save prompt"],
    tab: "chat",
    anchor: "drafts-button",
    scope: "account",
    web: "browser",
    group: "Details",
  },
  {
    id: "appearance.launch-prompt",
    label: "Copy prompts to clipboard",
    keywords: ["clipboard", "launch", "prompt", "new chat"],
    tab: "chat",
    anchor: "chat-launch-clipboard",
    scope: "account",
    web: "browser",
    group: "Composer",
  },
  {
    id: "chat.prompt-suggestions",
    label: "Next prompt suggestions",
    keywords: ["suggest", "suggestion", "next prompt", "autocomplete", "tab", "follow up", "placeholder", "composer"],
    tab: "chat",
    anchor: "prompt-suggestions",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    // The setting is the host's project configuration, which the hosted client cannot write.
    web: "hidden",
    group: "Composer",
  },
  {
    id: "chat.smart-decisions",
    label: "Smart decisions (Jev)",
    keywords: ["jev", "opencode", "turn end", "question", "classifier", "bonus"],
    tab: "chat",
    anchor: "smart-decisions",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    web: "hidden",
    group: "Smart decisions",
  },
  {
    id: "chat.smart-chat-status",
    label: "Waiting on you",
    keywords: ["jev", "needs you", "question", "waiting", "cli", "status line", "turn end"],
    tab: "chat",
    anchor: "smart-chat-status",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    web: "hidden",
    group: "Smart decisions",
  },
  {
    id: "chat.smart-plain-terminals",
    label: "Also check plain terminals",
    keywords: ["jev", "terminal", "shell", "waiting", "prompt", "privacy"],
    tab: "chat",
    anchor: "smart-plain-terminals",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    web: "hidden",
    group: "Smart decisions",
  },
  {
    id: "chat.smart-settle-nudge",
    label: "Settle finished chats",
    keywords: ["jev", "settle", "done", "finished", "idle"],
    tab: "chat",
    anchor: "smart-settle-nudge",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    web: "hidden",
    group: "Smart decisions",
  },
  {
    id: "chat.model-hint",
    label: "Model and effort hint",
    keywords: ["jev", "model hint", "effort", "suggest", "model", "opencode", "composer"],
    tab: "chat",
    anchor: "model-hint",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    web: "hidden",
    group: "Smart decisions",
  },
  {
    id: "chat.smart-palette",
    label: "⌘K suggestions",
    keywords: ["jev", "command palette", "cmd k", "suggested", "commands"],
    tab: "chat",
    anchor: "smart-palette",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    web: "hidden",
    group: "Smart decisions",
  },
  {
    id: "chat.smart-lane-emoji",
    label: "Lane emoji",
    keywords: ["jev", "emoji", "lane", "icon"],
    tab: "chat",
    anchor: "smart-lane-emoji",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    web: "hidden",
    group: "Smart decisions",
  },
  {
    id: "chat.jev-zen-credit",
    label: "Use my OpenCode Zen credit",
    keywords: ["jev", "opencode", "zen", "sign in", "credit", "balance"],
    tab: "chat",
    anchor: "jev-zen-credit",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    web: "hidden",
    group: "Smart decisions",
  },
  {
    id: "chat.claude-mods",
    label: "Show what Claude mods draw",
    keywords: ["mods", "plugins", "claude code", "band", "status line", "pane", "toast"],
    tab: "chat",
    anchor: "claude-mods",
    scope: "account",
    // The setting is the host's project configuration, which the hosted client cannot write.
    web: "hidden",
    group: "Claude mods",
  },
  {
    id: "appearance.preview",
    label: "Chat preview",
    keywords: ["preview", "sample", "example", "what it looks like"],
    tab: "chat",
    anchor: "appearance-preview",
    scope: "account",
    web: "browser",
    group: "Preview",
  },
  {
    id: "appearance.interface-font",
    label: "Interface font",
    keywords: ["font", "typeface", "geist", "system", "sans", "typography"],
    tab: "appearance",
    anchor: "interface-font",
    scope: "machine",
    web: "browser",
    group: "Interface",
  },
  {
    id: "appearance.code-font",
    label: "Code font",
    keywords: ["font", "monospace", "mono", "code", "jetbrains", "geist mono"],
    tab: "appearance",
    anchor: "code-font",
    scope: "machine",
    web: "browser",
    group: "Interface",
  },
  {
    id: "appearance.reduce-motion",
    label: "Reduce motion",
    keywords: ["animation", "motion", "transitions", "accessibility"],
    tab: "appearance",
    anchor: "reduce-motion",
    scope: "machine",
    web: "browser",
    group: "Interface",
  },
  {
    id: "appearance.focus-grid-chats",
    label: "Focus grid chats per page",
    keywords: ["focus", "grid", "tiles", "columns", "layout", "work", "screen size"],
    tab: "appearance",
    anchor: "focus-grid-chats",
    scope: "machine",
    web: "browser",
    group: "Interface",
  },
  {
    id: "appearance.terminal",
    label: "Terminal text",
    keywords: ["terminal", "font", "monospace", "size", "line height", "scrollback", "shell"],
    tab: "appearance",
    anchor: "terminal-text",
    scope: "machine",
    web: "browser",
    group: "Terminal",
  },
  {
    id: "appearance.apple-realistic-body",
    label: "Realistic body",
    keywords: ["apple", "simulator", "ios", "3d", "body", "mesh", "apple.realisticBody"],
    tab: "apple",
    anchor: "apple-realistic-body",
    scope: "machine",
    web: "browser",
    group: "Apple Development",
  },
  {
    id: "appearance.apple-tap-rings",
    label: "Tap rings in recordings",
    keywords: ["apple", "simulator", "ios", "recording", "overlay", "tap", "apple.recordingOverlays.tapRings"],
    tab: "apple",
    anchor: "apple-tap-rings",
    scope: "machine",
    web: "browser",
    group: "Apple Development",
  },
  {
    id: "appearance.apple-typed-badges",
    label: "Typed text in recordings",
    keywords: ["apple", "simulator", "ios", "recording", "overlay", "badge", "keyboard", "apple.recordingOverlays.keyBadges"],
    tab: "apple",
    anchor: "apple-typed-badges",
    scope: "machine",
    web: "browser",
    group: "Apple Development",
  },
  {
    id: "appearance.apple-remote-bitrate",
    label: "Remote viewer bitrate cap",
    keywords: ["apple", "simulator", "ios", "stream", "bitrate", "kbit", "remote", "apple.remoteBitrateKbpsCap"],
    tab: "apple",
    anchor: "apple-remote-bitrate",
    scope: "machine",
    web: "browser",
    group: "Apple Development",
  },
  {
    id: "appearance.apple-recordings-warn",
    label: "Recordings storage warning",
    keywords: ["apple", "simulator", "ios", "recording", "storage", "disk", "warn", "apple.recordingsWarnBytes"],
    tab: "apple",
    anchor: "apple-recordings-warn",
    scope: "machine",
    web: "browser",
    group: "Apple Development",
  },

  // ── Agents & Models ──────────────────────────────────────────────────────
  {
    id: "agents.providers",
    label: "AI connections",
    // Provider accounts and stored API keys are PANELS on each provider's page,
    // not pages of their own, so they own no anchor and cannot be entries here
    // (anchors are unique per entry). Their words live on the page that leads
    // to both, because before this "accounts" and "api keys" matched nothing in
    // ⌘K and the only way in was already knowing which provider to open.
    keywords: [
      "provider", "api key", "api keys", "keys", "byok", "stored key", "token", "openrouter",
      "anthropic", "openai", "claude", "codex", "auth", "model",
      "account", "accounts", "provider accounts", "second account", "another account",
      "multiple accounts", "instance", "switch account", "default account", "smart balance",
      "endpoint", "base url", "custom provider",
    ],
    tab: "agents",
    anchor: "ai-providers",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  // The web client hides every provider page (sign-in, keys and permissions
  // run on the machine itself), but the machine's Claude and Codex logins are
  // managed over sync, so the browser gets them as one card of its own.
  {
    id: "agents.accounts",
    label: "AI accounts",
    keywords: [
      "account", "accounts", "claude", "codex", "sign in", "login", "second account",
      "default account", "switch account", "smart balance",
    ],
    tab: "agents",
    anchor: "ai-accounts",
    scope: "machine",
    web: "machine",
    group: "Connections",
    webOnly: true,
  },
  // One entry per provider, so ⌘K, settings search, and deeplinks land on the
  // provider's own page rather than the top of the list. The keywords carry the
  // brand names a user actually types — "anthropic", "factory", "xai" — none of
  // which appear in the labels.
  {
    id: "agents.provider.claude",
    label: "Claude Code",
    keywords: ["anthropic", "claude", "provider", "sign in", "api key", "model", "permission", "account", "accounts", "instance"],
    tab: "agents",
    anchor: "ai-provider-claude",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.codex",
    label: "Codex CLI",
    keywords: ["openai", "chatgpt", "codex", "provider", "sign in", "api key", "model", "permission", "account", "accounts", "instance"],
    tab: "agents",
    anchor: "ai-provider-codex",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.cursor",
    label: "Cursor",
    keywords: ["cursor", "provider", "oauth", "sign in", "api key", "model", "permission"],
    tab: "agents",
    anchor: "ai-provider-cursor",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.droid",
    label: "Droid",
    keywords: ["factory", "droid", "provider", "sign in", "api key", "model", "permission"],
    tab: "agents",
    anchor: "ai-provider-droid",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.muse",
    label: PROVIDER_DISPLAY_NAME.muse,
    keywords: ["muse", "meta", "muse code", "spark", "provider", "sign in", "api key", "model", "permission"],
    tab: "agents",
    anchor: "ai-provider-muse",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.pi",
    label: "Pi",
    keywords: ["pi", "earendil", "provider", "sign in", "model", "permission"],
    tab: "agents",
    anchor: "ai-provider-pi",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.opencode",
    label: "OpenCode",
    keywords: [
      "opencode", "provider", "sign in", "api key", "model", "permission",
      // The vendors OpenCode is still the only route to. Qwen, Moonshot/Kimi,
      // xAI/Grok, and GitHub Copilot moved to their own entries below, where a
      // user typing the brand now lands on the provider's own page.
      "openrouter", "groq", "together", "deepseek", "mistral", "google", "gemini",
      "ollama", "lm studio",
    ],
    tab: "agents",
    anchor: "ai-provider-opencode",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.qwen",
    label: "Qwen Code",
    keywords: ["qwen", "alibaba", "qwen code", "acp", "provider", "sign in", "api key", "openai", "base url", "model", "permission"],
    tab: "agents",
    anchor: "ai-provider-qwen",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.kimi",
    label: "Kimi",
    keywords: ["kimi", "moonshot", "moonshotai", "kimi code", "acp", "provider", "sign in", "model", "permission"],
    tab: "agents",
    anchor: "ai-provider-kimi",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.grok",
    label: "Grok",
    keywords: ["grok", "xai", "x.ai", "acp", "provider", "sign in", "api key", "model", "permission"],
    tab: "agents",
    anchor: "ai-provider-grok",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.copilot",
    label: "GitHub Copilot",
    keywords: ["copilot", "github", "github copilot", "acp", "provider", "sign in", "model", "permission"],
    tab: "agents",
    anchor: "ai-provider-copilot",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    // The id and anchor keep the old word: they are storage and deeplinks, and
    // renaming them would break every saved link. Only the label is copy.
    id: "agents.harnesses",
    label: "Custom",
    // "harness"/"harnesses" stay as keywords: the label is Custom now, but
    // that is the word in the docs, the CLI flags and every older screenshot.
    // "body"/"brain" were internal shorthand that leaked into the wizard copy
    // and have been removed from it; searching for them should not teach a
    // vocabulary the product no longer speaks.
    keywords: ["custom", "harness", "harnesses", "preset", "model", "account", "profile", "combination", "subagent", "launch", "logo"],
    tab: "agents",
    anchor: "ai-harnesses",
    scope: "account",
    // A custom setup names a provider account and a stored key, both of which
    // are machine-local facts the hosted client cannot read or write.
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.scheduled-work",
    label: "Pause all scheduled work",
    keywords: ["background work", "jobs", "cron", "wakeup", "loop", "schedule", "pause"],
    tab: "notifications",
    anchor: "scheduled-work",
    scope: "account",
    web: "hidden",
    group: "Scheduled work",
  },
  {
    id: "agents.budget",
    label: "Spend cap",
    keywords: ["budget", "cost", "limit", "dollars", "spend"],
    tab: "agents",
    anchor: "budget-cap",
    scope: "machine-repo",
    web: "hidden",
    group: "Budget",
  },
  {
    id: "agents.dictation",
    label: "Voice input",
    keywords: ["dictation", "microphone", "speech", "whisper", "transcribe"],
    tab: "chat",
    anchor: "voice-input",
    scope: "account",
    web: "hidden",
    group: "Voice input",
  },
  {
    id: "chat.voice-conversations",
    label: "Voice conversations",
    keywords: ["voice", "talk", "speak", "realtime", "codex voice", "personality", "call", "conversation"],
    tab: "chat",
    anchor: "voice-conversations",
    scope: "account",
    web: "hidden",
    group: "Voice conversations",
  },

  // ── Lanes, Storage & cleanup, Agents ─────────────────────────────────────
  // Project → Lanes holds the lanes and how new ones start; Project → Storage
  // & cleanup the space, archive and cleanups; Project → Agents what agents
  // keep about the project. Entry ids keep their old namespaces (`storage.*`,
  // `archive.*`, `lanes-git.pr-chat-transcripts`): deeplinks and telemetry
  // hold them.
  {
    id: "lanes-git.lanes",
    label: "Your lanes",
    keywords: ["lanes", "stale", "merged", "done", "archive", "bulk", "clean up", "worktree", "dirty", "unpushed", "running"],
    tab: "lanes-git",
    anchor: "lane-list",
    scope: "machine-repo",
    web: "hidden",
    group: "Lanes",
  },
  {
    id: "storage.usage",
    label: "Storage",
    keywords: ["space", "size", "clean", "reclaim", "gb", "free", "disk", "storage", "usage", "clean up safely"],
    tab: "storage",
    anchor: "storage",
    scope: "machine-repo",
    web: "hidden",
    group: "Storage",
  },
  {
    id: "archive.items",
    label: "Archived lanes, chats, and shells",
    keywords: ["archive", "archived", "restore", "unarchive", "delete", "cleanup", "old", "lanes", "chats", "shells"],
    tab: "storage",
    anchor: "archive",
    scope: "machine-repo",
    web: "machine",
    group: "Archive",
  },
  {
    id: "storage.cleanups",
    label: "Cleanup history",
    keywords: ["cleanup", "freed", "maintenance", "journal", "reclaimed"],
    tab: "storage",
    anchor: "storage-cleanups",
    scope: "machine-repo",
    web: "hidden",
    group: "Cleanups",
  },
  {
    id: "storage.lane-rules",
    label: "Archive idle lanes",
    keywords: ["archive", "inactivity", "cleanup", "worktree", "max lanes", "retention", "lane storage rules"],
    tab: "storage",
    anchor: "lane-storage-rules",
    scope: "machine-repo",
    web: "hidden",
    group: "Cleanups",
  },
  {
    id: "storage.session-lifecycle",
    label: "Session lifecycle",
    keywords: ["session", "idle", "close", "terminal", "cleanup", "settle"],
    tab: "storage",
    anchor: "session-lifecycle",
    scope: "machine",
    web: "hidden",
    group: "Sessions",
  },
  {
    id: "storage.project-files",
    label: "Project files",
    keywords: [".ade", "folder", "repair", "session logs", "config", "icon", "name", "repository", "root"],
    tab: "storage",
    anchor: "project",
    scope: "machine-repo",
    web: "hidden",
    group: "Sessions",
  },
  {
    id: "lanes-git.new-lane-base",
    label: "New lane base",
    keywords: ["remote", "local", "branch", "upstream", "fetch", "start"],
    tab: "lanes-git",
    anchor: "new-lane-base",
    scope: "machine-repo",
    web: "machine",
    group: "Starting lanes",
  },
  {
    id: "lanes-git.auto-rebase",
    label: "Auto-rebase child lanes",
    keywords: ["rebase", "stack", "parent", "child", "dependent", "current"],
    tab: "lanes-git",
    anchor: "auto-rebase",
    scope: "machine-repo",
    web: "machine",
    group: "Rebase & stacking",
  },
  {
    id: "lanes-git.rebase-suggestions",
    label: "Rebase suggestions",
    keywords: ["banner", "badge", "notification", "behind", "nag", "suggest", "off", "quiet"],
    tab: "lanes-git",
    anchor: "rebase-suggestions",
    scope: "machine-repo",
    web: "machine",
    group: "Rebase & stacking",
  },
  {
    id: "lanes-git.rebase-min-behind",
    label: "Only suggest after",
    keywords: ["threshold", "behind", "commits", "minimum", "rebase"],
    tab: "lanes-git",
    anchor: "rebase-min-behind",
    scope: "machine-repo",
    web: "machine",
    group: "Rebase & stacking",
  },
  {
    id: "lanes-git.lane-templates",
    label: "Lane templates",
    keywords: ["template", "scaffold", "preset", "default lane"],
    tab: "lanes-git",
    anchor: "lane-templates",
    scope: "machine-repo",
    web: "hidden",
    group: "Templates",
  },
  {
    id: "project-agents.agent-notes",
    label: "Agent notes",
    keywords: ["notes", "agent", "memory", "knowledge", "prompt", "facts", "ade notes"],
    tab: "project-agents",
    anchor: "agent-notes",
    scope: "account-repo",
    web: "hidden",
    group: "Agent notes",
  },
  {
    id: "lanes-git.pr-chat-transcripts",
    label: "PR chat transcripts",
    keywords: ["pull request", "transcript", "attach", "review"],
    tab: "project-agents",
    anchor: "pr-chat-transcripts",
    scope: "machine-repo",
    web: "machine",
    group: "Pull requests",
  },

  // ── Integrations ─────────────────────────────────────────────────────────
  {
    id: "integrations.github",
    label: "GitHub",
    keywords: ["git", "pr", "pull request", "token", "pat", "app", "auth", "webhook"],
    tab: "integrations",
    anchor: "github-connection",
    scope: "machine",
    web: "hidden",
    group: "GitHub",
  },
  {
    id: "integrations.linear",
    label: "Linear",
    keywords: ["issue", "ticket", "oauth", "sync", "workflow"],
    tab: "integrations",
    anchor: "linear-connection",
    scope: "machine",
    web: "hidden",
    group: "Linear",
  },
  {
    id: "integrations.jira",
    label: "Jira",
    keywords: ["issue", "ticket", "atlassian", "api token", "jira cloud"],
    tab: "integrations",
    anchor: "jira-connection",
    scope: "machine",
    web: "hidden",
    group: "Jira",
  },
  {
    id: "integrations.jira-projects",
    label: "Jira projects for this project",
    keywords: ["jira", "project", "issue tracker", "binding", "default"],
    tab: "integrations",
    anchor: "jira-projects",
    scope: "account-repo",
    web: "hidden",
    group: "Jira",
  },
  {
    id: "integrations.jira-top-bar",
    label: "Show Jira in the top bar",
    keywords: ["jira", "issues", "top bar", "header", "hide", "button"],
    tab: "integrations",
    anchor: "jira-top-bar",
    scope: "machine",
    web: "hidden",
    group: "Jira",
  },
  {
    id: "integrations.linear-top-bar",
    label: "Show Linear in the top bar",
    keywords: ["linear", "issues", "top bar", "header", "hide", "button"],
    tab: "integrations",
    anchor: "linear-top-bar",
    scope: "machine",
    web: "hidden",
    group: "Linear",
  },
  {
    id: "integrations.github-issues-top-bar",
    label: "Show GitHub issues in the top bar",
    keywords: ["github", "issues", "top bar", "header", "hide", "button", "count"],
    tab: "integrations",
    anchor: "github-issues-top-bar",
    scope: "machine",
    web: "hidden",
    group: "GitHub",
  },
  // ── Notifications ───────────────────────────────────────────────────────
  {
    id: "notifications.events",
    label: "Events",
    keywords: ["activity", "policy", 
      "notification", "alert", "turn complete", "question", "ci", "check",
      "review", "conflict", "desktop", "phone", "push", "silent", "matrix",
    ],
    tab: "notifications",
    anchor: "notification-events",
    scope: "account",
    web: "account",
    group: "Events",
  },
  {
    id: "notifications.focus-suppression",
    label: "Quiet while ADE is focused",
    keywords: ["focus", "quiet", "suppress", "do not disturb", "dnd", "mute"],
    tab: "notifications",
    anchor: "focus-suppression",
    scope: "account",
    web: "account",
    group: "Delivery",
  },
  {
    id: "notifications.quiet-hours",
    label: "Quiet hours",
    keywords: ["schedule", "night", "silent", "window", "sleep"],
    tab: "notifications",
    anchor: "quiet-hours",
    scope: "account",
    web: "account",
    group: "Delivery",
  },
  {
    id: "notifications.phone",
    label: "Phone notifications",
    keywords: ["ios", "mobile", "push", "apns", "device"],
    tab: "notifications",
    anchor: "phone-notifications",
    scope: "account",
    web: "account",
    group: "Delivery",
  },
  {
    id: "notifications.live-activities",
    label: "Live Activities",
    keywords: ["lock screen", "dynamic island", "ios", "widget"],
    tab: "notifications",
    anchor: "live-activities",
    scope: "account",
    web: "account",
    group: "Delivery",
  },
  {
    id: "notifications.escalation",
    label: "Escalate to phone",
    keywords: ["delay", "desktop first", "handoff", "escalation"],
    tab: "notifications",
    anchor: "phone-escalation",
    scope: "account",
    web: "account",
    group: "Delivery",
  },
  {
    id: "notifications.completion-sound",
    label: "Completion chime",
    keywords: ["sound", "audio", "chime", "bell", "volume", "done"],
    tab: "notifications",
    anchor: "agent-completion-sound",
    scope: "account",
    web: "browser",
    group: "Sound",
  },

  // ── Activity ─────────────────────────────────────────────────────────────
  {
    id: "activity.sounds",
    label: "Activity sounds",
    keywords: ["sound", "audio", "cue", "chime", "attention"],
    tab: "notifications",
    anchor: "activity-sounds",
    scope: "account",
    web: "account",
    group: "Sound",
  },
  {
    id: "activity.hide-details",
    label: "Hide previews",
    keywords: ["privacy", "redact", "private", "content", "summary", "preview"],
    tab: "notifications",
    anchor: "activity-hide-details",
    scope: "account",
    web: "account",
    group: "Privacy and badges",
  },
  {
    id: "activity.dock-badge",
    label: "Dock badge counts",
    keywords: ["dock", "badge", "count", "this mac", "all machines", "account"],
    tab: "notifications",
    anchor: "activity-dock-badge",
    scope: "account",
    web: "hidden",
    group: "Privacy and badges",
  },
  {
    id: "activity.machines",
    label: "Machines",
    keywords: ["activity", "notify", "machine", "mute", "silence", "mac", "device", "per-machine"],
    tab: "notifications",
    anchor: "activity-machines",
    scope: "account",
    web: "account",
    group: "Machines",
  },

  // ── Secrets ──────────────────────────────────────────────────────────────
  {
    id: "secrets.secrets",
    label: "Secrets",
    keywords: ["credential", "api key", "token", "keychain", "env", "password", "environment", "variable"],
    tab: "secrets",
    anchor: "secrets",
    scope: "account-repo",
    web: "hidden",
    group: "Secrets",
  },

  // ── Stats ────────────────────────────────────────────────────────────────
  {
    id: "stats.usage",
    label: "Usage & spend",
    keywords: ["cost", "tokens", "pacing", "budget", "stats", "usage"],
    tab: "stats",
    anchor: "ade-usage",
    scope: "account",
    web: "machine",
    group: "Usage",
  },
] as const;

/**
 * Legacy `?tab=` values → the tab that now owns them. Every id ADE has ever
 * shipped in a URL, a tour step, or a deeplink stays resolvable; dropping one
 * silently lands the user on the wrong page.
 */
export const LEGACY_TAB_ALIASES: Readonly<Record<string, SettingsTabId>> = {
  // Former top-level tabs.
  ai: "agents",
  providers: "agents",
  "background-jobs": "agents",
  automations: "agents",
  "lane-templates": "lanes-git",
  "agent-notes": "project-agents",
  notes: "project-agents",
  "ade-usage": "stats",
  usage: "stats",
  secret: "secrets",
  // General was split up: ADE itself went to Computer → ADE service, the
  // computer's habits to Computer → Behaviour, and the project's folder to
  // Project → Location. A bare `?tab=general` opens ADE service, where most of
  // it went; a `#hash` on the same link still lands on its own card.
  general: "service",
  // Health (once tab id `storage`, now Storage & cleanup's id) was split up
  // too: its space, cleanups and sessions are on Project → Storage & cleanup,
  // its lanes on Project → Lanes, its project checks on Project → Location,
  // its service on Computer → ADE service, and its summary is the Overview.
  disk: "storage",
  space: "storage",
  cleanup: "storage",
  cleanups: "storage",
  health: "overview",
  diagnostics: "service",
  archive: "storage",
  archived: "storage",
  // Swept into General before; now each has a real home.
  workspace: "location",
  project: "location",
  "project-location": "location",
  context: "service",
  integrations: "integrations",
  sync: "account",
  devices: "account",
  "multi-device": "account",
  github: "integrations",
  linear: "integrations",
  "computer-use": "behaviour",
  behavior: "behaviour",
  onboarding: "overview",
  help: "overview",
  tours: "overview",
  home: "overview",
  lanes: "lanes-git",
  "session-lifecycle": "storage",
  // The Attention center became the Activity pane, and Activity's settings
  // joined Notifications on one page.
  attention: "notifications",
  activity: "notifications",
};

/**
 * Legacy `?tab=` values that named one card's page. With no `#hash` of its
 * own, such a link scrolls to that card on its new page instead of landing on
 * the top of it: `?tab=archive` opens Project → Storage & cleanup at the archive.
 */
export const LEGACY_TAB_ANCHORS: Readonly<Record<string, string>> = {
  storage: "storage",
  disk: "storage",
  space: "storage",
  archive: "archive",
  archived: "archive",
  diagnostics: "diagnostics",
  "session-lifecycle": "session-lifecycle",
  "project-location": "project-location",
};

export function legacyTabAnchor(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase() ?? "";
  return raw ? (LEGACY_TAB_ANCHORS[raw] ?? null) : null;
}

/**
 * Legacy `#hash` values → the entry that now owns them, for hashes whose
 * anchor changed. Hashes that still match a live anchor need no entry here.
 */
export const LEGACY_HASH_ALIASES: Readonly<Record<string, string>> = {
  github: "integrations.github",
  linear: "integrations.linear",
  "ai-providers": "agents.providers",
  secrets: "secrets.secrets",
  diagnostics: "storage.diagnostics",
  "agent-completion-sound": "notifications.completion-sound",
  "voice-input": "agents.dictation",
  "chat-launch-clipboard": "appearance.launch-prompt",
  "github-connection": "integrations.github",
  "linear-connection": "integrations.linear",
  "pr-chat-transcripts": "lanes-git.pr-chat-transcripts",
  // `session-lifecycle` is still a live anchor (Project → Storage & cleanup → Rules).
  // Reset ADE lived inside the About card (#1410) before it got its own section.
  "about.reset": "general.reset",
  "auto-updates": "general.auto-updates",
  // Moved out of Notifications when Activity got its own tab.
  "attention-sounds": "activity.sounds",
  "hide-previews": "activity.hide-details",
};

const ENTRIES_BY_ID = new Map(SETTINGS_ENTRIES.map((entry) => [entry.id, entry]));
const ENTRIES_BY_ANCHOR = new Map(SETTINGS_ENTRIES.map((entry) => [entry.anchor, entry]));

export function isSettingsTabId(value: string): value is SettingsTabId {
  return (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

export function settingsEntryById(id: string): SettingEntry | null {
  return ENTRIES_BY_ID.get(id) ?? null;
}

/**
 * Whether a setting is reachable from the renderer we are running in. Every
 * setting but a web-only one is reachable on the desktop; the web client drops
 * the ones whose writes have nowhere to land. Nav, search, and the palette all read this, so
 * a hidden setting is hidden everywhere at once rather than only in the nav.
 *
 * `resolveSettingsTab` and `resolveSettingsHash` deliberately do not: a URL
 * that names a hidden setting still resolves, and the settings shell decides
 * where to land it.
 */
export function isSettingAvailable(entry: SettingEntry): boolean {
  if (entry.macOnly && !isMacPlatform()) return false;
  if (!isWebClientMode()) {
    // Standalone Settings, opened from the new-project screen with no project:
    // a project-scoped setting has nowhere to write, so it is hidden here as
    // it is on the web client with no bound machine.
    if (standaloneSettingsResolver?.() ?? false) {
      return entry.webOnly !== true && entry.scope !== "account-repo" && entry.scope !== "machine-repo";
    }
    return entry.webOnly !== true;
  }
  if (entry.web === "hidden") return false;
  // A machine-scoped setting writes to the machine the active project tab is
  // bound to. With no tab open there is no such machine, so the control would
  // be a write with nowhere to land — the same reason `hidden` exists.
  return entry.web !== "machine" || hasWebMachineBinding();
}

/**
 * Whether Settings is open with no project — the new-project screen's own
 * Settings entry. Installing the resolver hides every project-scoped setting
 * from nav, search and the palette at once.
 */
let standaloneSettingsResolver: (() => boolean) | null = null;

export function setStandaloneSettingsResolver(resolve: () => boolean): void {
  standaloneSettingsResolver = resolve;
}

/** Uninstall a standalone resolver, but only if it is still the installed one. */
export function clearStandaloneSettingsResolver(resolve: () => boolean): void {
  if (standaloneSettingsResolver === resolve) standaloneSettingsResolver = null;
}

/**
 * The scope of a section, read off the settings it contains. A section is
 * `hidden` on web only when every setting in it is — this module is the one
 * place that decides, so nav, search, and the scope banner cannot disagree.
 *
 * Unreachable is broader than `hidden`: a machine-scoped setting is also
 * unreachable while no project tab is bound, because there is no machine for
 * its write to land on. `isSettingAvailable` owns that judgement.
 *
 * `entryIds` are manifest ids; an id that resolves to nothing contributes
 * nothing, and `null` means "nothing here to describe".
 */
export function sectionWebScope(entryIds: readonly string[]): SettingWebScope | null {
  const scopes = entryIds
    .map((id) => settingsEntryById(id))
    .filter((entry): entry is SettingEntry => entry != null)
    .map((entry): SettingWebScope => (isSettingAvailable(entry) ? entry.web : "hidden"));
  if (scopes.length === 0) return null;

  // Notifications is the mixed case: account-synced delivery rules alongside
  // one browser-local sound. The banner
  // describes where most of the section goes, not the loudest exception —
  // ties break toward the narrowest claim, which is why the ranking is ordered.
  const tally = new Map<SettingWebScope, number>();
  for (const scope of scopes) tally.set(scope, (tally.get(scope) ?? 0) + 1);
  if (tally.get("hidden") === scopes.length) return "hidden";

  // `machine` doubles as the initial value, so the ranking needs no non-null
  // assertion to read its own first element.
  let best: Exclude<SettingWebScope, "hidden"> = "machine";
  const NARROWEST_FIRST: Exclude<SettingWebScope, "hidden">[] = ["account", "browser"];
  for (const scope of NARROWEST_FIRST) {
    if ((tally.get(scope) ?? 0) > (tally.get(best) ?? 0)) best = scope;
  }
  return best;
}

/**
 * Whether the hosted client currently has a machine to write machine-scoped
 * settings to — i.e. whether a project tab is bound.
 *
 * A resolver rather than a flag: nav, search and the palette all ask
 * `isSettingAvailable` mid-render, so the answer has to be read at call time
 * from live app state instead of pushed here on a lifecycle event that may not
 * have run yet. The desktop never installs one, and never asks.
 */
let webMachineBindingResolver: (() => boolean) | null = null;

export function setWebMachineBindingResolver(resolve: (() => boolean) | null): void {
  webMachineBindingResolver = resolve;
}

/**
 * Uninstall a resolver, but only if it is still the installed one.
 *
 * Two surfaces install a resolver (the settings page and the palette) and they
 * unmount in no fixed order, so an unconditional clear on unmount would tear
 * down a resolver the OTHER surface had since installed, leaving the manifest
 * answering `false` for a machine that is in fact bound.
 */
export function clearWebMachineBindingResolver(resolve: () => boolean): void {
  if (webMachineBindingResolver === resolve) webMachineBindingResolver = null;
}

export function hasWebMachineBinding(): boolean {
  return webMachineBindingResolver?.() ?? false;
}

/** Whether any of these settings is reachable right now. */
export function sectionHasAvailableEntries(entryIds: readonly string[]): boolean {
  return entryIds.some((id) => {
    const entry = settingsEntryById(id);
    return entry != null && isSettingAvailable(entry);
  });
}

/** Every setting reachable in this renderer, in manifest order. */
export function availableSettingsEntries(): SettingEntry[] {
  return SETTINGS_ENTRIES.filter(isSettingAvailable);
}

/** Tabs with at least one reachable setting, in manifest order. */
export function availableSettingsTabs(): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => settingsEntriesForTab(tab.id).length > 0);
}

export function settingsEntriesForTab(tab: SettingsTabId): SettingEntry[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.tab === tab && isSettingAvailable(entry));
}

/** Group names for a tab, in first-appearance order. */
export function settingsGroupsForTab(tab: SettingsTabId): string[] {
  const seen: string[] = [];
  for (const entry of settingsEntriesForTab(tab)) {
    if (!seen.includes(entry.group)) seen.push(entry.group);
  }
  return seen;
}

/**
 * Resolve any `?tab=` value — current or legacy — to a live tab.
 * Returns null for values we've never shipped, so the caller can fall back.
 */
export function resolveSettingsTab(value: string | null | undefined): SettingsTabId | null {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) return null;
  if (isSettingsTabId(raw)) return raw;
  return LEGACY_TAB_ALIASES[raw] ?? null;
}

/**
 * Resolve a `#hash` to the entry that owns it, following legacy aliases.
 * Used to scroll to the right card even when the anchor has since moved.
 */
export function resolveSettingsHash(hash: string | null | undefined): SettingEntry | null {
  const raw = hash?.trim().replace(/^#/, "").toLowerCase() ?? "";
  if (!raw) return null;
  const direct = ENTRIES_BY_ANCHOR.get(raw);
  if (direct) return direct;
  const aliased = LEGACY_HASH_ALIASES[raw];
  return aliased ? (ENTRIES_BY_ID.get(aliased) ?? null) : null;
}

/**
 * The tab a `/settings` route opens on, resolved the way `SettingsPage`
 * resolves it: a `#hash` names one card and wins over `?tab=`, and a missing or
 * unknown tab opens on `DEFAULT_SETTINGS_TAB`.
 */
export function settingsTabForRoute(route: string): SettingsTabId {
  const url = new URL(route, "http://settings.invalid");
  let hash = url.hash;
  try {
    hash = decodeURIComponent(hash);
  } catch {
    // A malformed escape is literal text, as it is on the settings page.
  }
  const linked = resolveSettingsHash(hash);
  if (linked) return linked.tab;
  return resolveSettingsTab(url.searchParams.get("tab")) ?? DEFAULT_SETTINGS_TAB;
}

/**
 * Whether a route is a machine-scoped settings page: one of the
 * Computer pages (ADE service, Providers and the rest). Those describe one
 * computer, so a project must never remember one as its place to return to.
 */
export function isMachineScopedSettingsRoute(route: string): boolean {
  const pathname = route.split(/[?#]/, 1)[0] ?? "";
  if (pathname !== "/settings" && !pathname.startsWith("/settings/")) return false;
  return isMachineSettingsTab(settingsTabForRoute(route));
}

/** The route a palette entry or deeplink should navigate to. */
/**
 * The scope for one card's anchor, or null when the anchor is not a manifest
 * entry.
 *
 * This is what makes the scope chip honest. It used to be hand-typed at each
 * call site, so the manifest's answer and the screen's answer were two
 * different facts that drifted — two shipping rows told the user "only this
 * computer" for settings that reached every machine they owned. One source
 * makes that class of defect unrepresentable rather than merely fixed.
 */
export function settingsScopeForAnchor(anchor: string): SettingScope | null {
  return ENTRIES_BY_ANCHOR.get(anchor)?.scope ?? null;
}

export function settingsEntryPath(entry: SettingEntry): string {
  return `/settings?tab=${entry.tab}#${entry.anchor}`;
}

/**
 * The route for a setting named by its manifest id — the form every in-app CTA
 * (banners, callouts, empty states) should use.
 *
 * Hand-written `/settings?tab=general#github-connection` strings were the bug
 * this replaces: when GitHub moved from General to Integrations, the tab in
 * those literals kept pointing at General while the anchor moved, so the
 * "Authorize" banner landed on General and scrolled nowhere. Deriving the whole
 * route from the manifest means a setting can never move out from under a CTA
 * again. Unknown ids fall back to the settings root rather than throwing.
 */
export function settingsRouteFor(entryId: string): string {
  const entry = ENTRIES_BY_ID.get(entryId);
  return entry ? settingsEntryPath(entry) : "/settings";
}

export function settingsTabLabel(tab: SettingsTabId): string {
  return SETTINGS_TABS.find((candidate) => candidate.id === tab)?.label ?? tab;
}

/**
 * Score an entry against a search query. Returns null when it doesn't match.
 * Lower is better: label prefix beats label substring beats keyword hit.
 */
export function scoreSettingsEntry(entry: SettingEntry, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = entry.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  if (entry.group.toLowerCase().includes(q)) return 2;
  if (entry.keywords.some((keyword) => keyword.toLowerCase().includes(q))) return 3;
  return null;
}

/** Matching reachable entries across every tab, best match first. */
export function searchSettingsEntries(query: string): SettingEntry[] {
  const q = query.trim();
  if (!q) return [];
  return availableSettingsEntries()
    .map((entry) => ({ entry, score: scoreSettingsEntry(entry, q) }))
    .filter((row): row is { entry: SettingEntry; score: number } => row.score !== null)
    .sort((left, right) => left.score - right.score)
    .map((row) => row.entry);
}
