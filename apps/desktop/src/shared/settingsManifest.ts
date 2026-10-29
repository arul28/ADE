/**
 * The settings registry — single source of truth for the settings page nav,
 * the Cmd-K palette, legacy route resolution, settings chips in a chat, and
 * `ade settings find`.
 *
 * Before this existed, each of those read from its own hand-maintained list
 * and they drifted. It lives in `shared/` so the CLI and the brain read the
 * same entries as the settings page. What the RENDERER can reach (web client,
 * platform, standalone settings) is decided in
 * `renderer/components/settings/settingsManifest.ts`, which re-exports this.
 *
 * Adding a setting here makes it navigable, searchable, and deep-linkable at
 * once. `settingsManifest.test.ts` asserts the anchors and aliases stay live.
 */

import { PROVIDER_DISPLAY_NAME } from "./providers";

/**
 * The scope vocabulary lives in `shared/types/settingsScope.ts`.
 * `shared/accountSettingsScope.ts` decides which key a setting files under in
 * the account store and needs `SettingScope` to do it.
 */
import { SCOPE_COPY, type SettingScope, type SettingWebScope } from "./types/settingsScope";
export type { SettingScope, SettingWebScope } from "./types/settingsScope";

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
export const MACHINE_SETTINGS_TAB_IDS: readonly SettingsTabId[] = ["service", "agents", "apple", "appearance", "behaviour"];

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

/**
 * You pages that follow no machine at all: the account's own data, read
 * through this desktop's brain. They show no "settings for <remote>" banner.
 */
export const ACCOUNT_ONLY_TAB_IDS: readonly SettingsTabId[] = ["ade-mcp"];

export function isAccountOnlyTab(tab: SettingsTabId): boolean {
  return ACCOUNT_ONLY_TAB_IDS.includes(tab);
}

/** A Computer page that follows the picked machine (every one but This computer's own). */
export function isMachineSelectableSettingsTab(tab: SettingsTabId): boolean {
  return isMachineSettingsTab(tab) && !isThisComputerOnlyTab(tab);
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
  // One MCP server for the account: one URL reaches every computer you
  // include. The id stays `ade-mcp`, so links from when it was a Computer page
  // still land here.
  { id: "ade-mcp", label: "ADE MCP", description: "Let AI apps like claude.ai, ChatGPT and Cursor use ADE on your computers.", group: "account" },

  // ── Project: the open project, on the machine that owns it ──────────────
  { id: "lanes-git", label: "Lanes", description: "How new lanes start, and every lane in this project.", group: "project" },
  { id: "project-agents", label: "Agents", description: "What agents keep about this project: PR chat transcripts.", group: "project" },
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
  // Desktop only: a browser can't read a computer's Tailscale or change its relay.
  {
    id: "account.privateNetwork",
    label: "Connections",
    keywords: ["tailscale", "tailnet", "magicdns", "https", "certificates", "relay", "ade relay", "turn off relay", "private", "network", "routes", "connection"],
    tab: "account",
    anchor: "account-private-network",
    scope: "account",
    web: "hidden",
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
    id: "behaviour.terminal-shell",
    label: "Default terminal shell",
    keywords: ["shell", "terminal", "zsh", "bash", "fish", "powershell", "pwsh", "cmd", "git bash", "default shell"],
    tab: "behaviour",
    anchor: "terminal-shell",
    scope: "machine",
    // Read and saved through the machine's runtime, which a hosted tab drives too.
    web: "machine",
    group: "Terminal",
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
    label: "Tabs, downloads and search",
    // No "browser" here on purpose: the access entry already owns that word in
    // search, and a second match reordered the command palette's thread results.
    keywords: [
      "tabs", "tab limit", "downloads", "download folder", "save", "directory",
      "search engine", "address bar", "google", "duckduckgo", "bing", "kagi",
      "certificate", "https", "self-signed", "trusted",
    ],
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
    keywords: ["dark", "light", "dark mode", "light mode", "color", "accent", "import", "export", "vscode", "palette", "corners", "shadow", "backdrop", "scanlines", "serif", "monospace"],
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
    group: "Transcript",
  },
  {
    id: "appearance.message-minimap",
    label: "Message minimap",
    keywords: ["minimap", "gutter", "tick", "jump", "navigate"],
    tab: "chat",
    anchor: "user-message-minimap",
    scope: "account",
    web: "browser",
    group: "Transcript",
  },
  {
    id: "appearance.drafts",
    label: "Drafts button",
    keywords: ["bookmark", "stash", "composer", "save prompt"],
    tab: "chat",
    anchor: "drafts-button",
    scope: "account",
    web: "browser",
    group: "Composer",
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
    id: "chat.fast-mode",
    label: "Fast mode",
    keywords: ["fast", "speed", "ultra", "ultrafast", "priority", "service tier", "spend", "cost", "account"],
    tab: "chat",
    anchor: "fast-mode",
    // One row in the account store, so every computer signed into this account
    // gets the same answer. Off by default.
    scope: "account",
    // The hosted web client has no account-settings store, but its chat adapter
    // carries this one row over the sync host (`chat.*FastModeEnabled`), so the
    // switch works there too.
    web: "account",
    group: "Speed & spend",
  },
  {
    id: "chat.prompt-suggestions",
    label: "Next prompt suggestions",
    keywords: ["suggest", "suggestion", "next prompt", "autocomplete", "tab", "follow up", "placeholder", "composer", "codex"],
    tab: "chat",
    anchor: "prompt-suggestions-codex",
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
    group: "Agent behavior",
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
    group: "Agent behavior",
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
    group: "Agent behavior",
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
    group: "Agent behavior",
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
    group: "Agent behavior",
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
    group: "Agent behavior",
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
    group: "Agent behavior",
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
    group: "Agent behavior",
  },
  {
    id: "chat.claude-mods",
    label: "Show what Claude mods draw",
    keywords: ["mods", "plugins", "claude code", "band", "status line", "pane", "toast"],
    tab: "chat",
    anchor: "claude-mods",
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
    // The setting is the host's project configuration, which the hosted client cannot write.
    web: "hidden",
    group: "Agent behavior",
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
    id: "apple.auto-record",
    label: "Record agent input",
    keywords: ["apple", "simulator", "ios", "recording", "auto", "proof", "agent", "apple.autoRecordAgentInput"],
    tab: "apple",
    anchor: "apple-auto-record",
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
    // `.ade/local.yaml` of the project on the machine that runs its chats.
    scope: "machine-repo",
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
    group: "Voice",
  },
  {
    id: "chat.voice-conversations",
    label: "Voice conversations",
    keywords: ["voice", "talk", "speak", "realtime", "codex voice", "personality", "call", "conversation"],
    tab: "chat",
    anchor: "voice-conversations",
    scope: "account",
    web: "hidden",
    group: "Voice",
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
    id: "storage.chat-history",
    label: "Chat & terminal history",
    keywords: ["compress", "gzip", "transcripts", "old chats", "archived chats", "settled chats", "cold storage", "shrink", "db compression", "history size"],
    tab: "storage",
    anchor: "storage-chat-history",
    scope: "machine-repo",
    web: "hidden",
    group: "Storage",
  },
  {
    id: "storage.deleted-lane-chats",
    label: "Chats from deleted lanes",
    keywords: ["deleted chats", "leftover chats", "orphaned transcripts", "remove old chats", "where are my chats", "jsonl", "transcripts folder", "lost chats", "reminder"],
    tab: "storage",
    anchor: "storage-deleted-chats",
    scope: "machine-repo",
    web: "hidden",
    group: "Storage",
  },
  {
    id: "storage.provider-history",
    label: "Provider history on this machine",
    keywords: ["claude sessions", "codex sessions", ".claude", ".codex", "opencode", "droid", "cursor", "copilot", "grok", "session files", "cleanupPeriodDays", "provider storage", "agent history size"],
    tab: "storage",
    anchor: "storage-provider-history",
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
    keywords: ["cleanup", "freed", "maintenance", "journal", "reclaimed", "storage doctor", "search index", "vacuum", "duplicate transcripts", "database size"],
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
    id: "storage.lane-build-output",
    label: "Clean build output from idle lanes",
    keywords: ["node_modules", "dist", "build", "target", ".next", "build output", "idle", "disk space", "free space", "cleanup", "reinstall"],
    tab: "storage",
    anchor: "lane-build-output",
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
    id: "lanes-git.new-lane-start",
    label: "New lanes start from",
    keywords: [
      "auto-create", "auto create", "new lane", "start", "base", "branch", "default branch", "main",
      "primary", "switch branch", "on", "remote", "local", "fetch", "uncommitted", "changes", "copy",
    ],
    tab: "lanes-git",
    anchor: "new-lane-start",
    scope: "account-repo",
    web: "machine",
    group: "New lanes",
  },
  {
    id: "lanes-git.lane-templates",
    label: "Lane templates",
    keywords: ["template", "new lane template", "scaffold", "preset", "default lane", "setup", "install", "script", "auto-create"],
    tab: "lanes-git",
    anchor: "lane-templates",
    scope: "account-repo",
    web: "hidden",
    group: "New lanes",
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
  // ── ADE MCP: the account's one MCP server ────────────────────────────
  {
    id: "ade-mcp.server",
    label: "ADE MCP: let AI apps use ADE",
    keywords: ["mcp", "ade mcp", "remote", "server", "url", "address", "connector", "oauth", "relay", "ai apps", "turn on"],
    tab: "ade-mcp",
    anchor: "ade-mcp",
    scope: "account",
    // Granting an outside app your computers is done from a desktop, never
    // from a browser tab.
    web: "hidden",
    group: "ADE MCP",
  },
  {
    id: "ade-mcp.connect",
    label: "Connect an AI app to ADE",
    keywords: ["mcp", "connect", "setup", "custom connector", "claude.ai", "chatgpt", "claude code", "codex", "grok", "grok bot", "cursor", "vs code", "copilot", "gemini", "perplexity", "le chat", "windsurf", "zed", "goose", "opencode", "amp", "factory", "raycast", "xai api", "openai api"],
    tab: "ade-mcp",
    anchor: "ade-mcp-connect",
    scope: "account",
    web: "hidden",
    group: "ADE MCP",
  },
  {
    id: "ade-mcp.computers",
    label: "Computers AI apps can reach",
    keywords: ["mcp", "machines", "computers", "include", "leave out", "exclude", "online", "answering", "not answering", "offline"],
    tab: "ade-mcp",
    anchor: "ade-mcp-computers",
    scope: "account",
    web: "hidden",
    group: "ADE MCP",
  },
  {
    id: "ade-mcp.connections",
    label: "Connected AI apps and tokens",
    keywords: ["mcp", "token", "api key", "header", "bearer", "revoke", "disconnect", "read only", "read & write", "access", "apps"],
    tab: "ade-mcp",
    anchor: "ade-mcp-connections",
    scope: "account",
    web: "hidden",
    group: "ADE MCP",
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


/** The group heading a path starts with. Project pages say "Project", not the repo name. */
function groupLabel(group: SettingsGroupId): string {
  return SETTINGS_GROUPS.find((candidate) => candidate.id === group)?.label ?? group;
}

function tabGroup(tab: SettingsTabId): SettingsGroupId {
  return SETTINGS_TABS.find((candidate) => candidate.id === tab)?.group ?? "account";
}

/**
 * Where a setting sits, as the sidebar names it: `Computer › Studio › Providers ›
 * AI connections`, `You › Notifications › Quiet hours`. A card titled like its
 * page (`MCP servers` on MCP servers) is named once. `machineName` goes after
 * "Computer" and only on a Computer page; the other groups have no machine.
 *
 * This is what a settings chip shows. It is read from the manifest, never from
 * an agent's text, so a chip cannot claim to be somewhere it is not.
 */
export function settingsEntryLabelPath(entry: SettingEntry, machineName?: string | null): string[] {
  const group = tabGroup(entry.tab);
  const parts = [groupLabel(group)];
  const machine = machineName?.trim();
  if (group === "machines" && machine) parts.push(machine);
  const tabLabel = settingsTabLabel(entry.tab);
  if (group !== "overview" || tabLabel !== parts[0]) parts.push(tabLabel);
  if (entry.label.trim().toLowerCase() !== tabLabel.toLowerCase()) parts.push(entry.label);
  return parts;
}

/** `settingsEntryLabelPath` as one line, the way chips, cards and `ade settings find` print it. */
export function settingsEntryLabel(entry: SettingEntry, machineName?: string | null): string {
  return settingsEntryLabelPath(entry, machineName).join(" › ");
}

/**
 * A Computer page that follows the picked machine, so a chip names and opens
 * the chat's machine. Appearance and Apple devices are only ever This
 * computer's (`THIS_COMPUTER_ONLY_TAB_IDS`).
 */
export function isComputerSettingsEntry(entry: SettingEntry): boolean {
  return isMachineSelectableSettingsTab(entry.tab);
}

// Words a question carries that say nothing about which setting: "how do I
// change my provider settings" is a search for "provider".
const FIND_STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "change", "do", "does", "edit", "for", "find", "how", "i", "in", "is", "it",
  "manage", "me", "my", "of", "on", "or", "set", "setting", "settings", "the", "to", "turn", "up", "where",
  "which", "with", "you", "your", "off", "configure", "ade", "page", "option", "options",
]);

// The words people use for what the manifest calls something else.
const FIND_SYNONYMS: Record<string, string> = {
  login: "sign in",
  logins: "sign in",
  signin: "sign in",
  logout: "sign out",
  key: "api key",
  keys: "api key",
  sleep: "awake",
  publish: "transcript",
  share: "transcript",
  sharing: "transcript",
};

function findWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/)
    .map((word) => word.replace(/^[.+-]+|[.+-]+$/g, ""))
    .filter((word) => word.length > 1 && !FIND_STOP_WORDS.has(word))
    .map((word) => FIND_SYNONYMS[word] ?? word);
}

/** `providers` finds `provider`, `notifications` finds `notification`. */
function wordHits(haystack: string, word: string): boolean {
  // "pr" and "ui" are words, not fragments: inside "provider" they mean nothing.
  if (word.length <= 3) return ` ${haystack.replace(/[^a-z0-9]+/g, " ")} `.includes(` ${word} `);
  if (haystack.includes(word)) return true;
  return word.length > 3 && word.endsWith("s") && haystack.includes(word.slice(0, -1));
}

type FindRow = { entry: SettingEntry; label: string; tab: string; group: string; keywords: string };

let findRows: FindRow[] | null = null;

function findIndex(): FindRow[] {
  findRows ??= SETTINGS_ENTRIES.map((entry) => ({
    entry,
    label: entry.label.toLowerCase(),
    tab: settingsTabLabel(entry.tab).toLowerCase(),
    group: entry.group.toLowerCase(),
    keywords: entry.keywords.join(" ").toLowerCase(),
  }));
  return findRows;
}

/**
 * Settings for a question in plain words, best first — what `ade settings
 * find` prints. Unlike `scoreSettingsEntry` (one phrase, for the palette), each
 * word is matched on its own and filler words are dropped, so "how do I manage
 * my providers" finds Providers. A word few settings mention ("dark") counts
 * for more than one many do ("mode"). Every entry is searched: whether a
 * client can show it is that client's call, and its chip says so.
 */
export function findSettingsEntries(query: string, limit = 3): SettingEntry[] {
  const words = findWords(query);
  if (words.length === 0) return [];
  const rows = findIndex();
  const rarity = new Map<string, number>();
  for (const word of words) {
    const count = rows.filter((row) => wordHits(`${row.label} ${row.tab} ${row.group} ${row.keywords}`, word)).length;
    rarity.set(word, count === 0 ? 0 : 1 + Math.log(rows.length / count));
  }
  const scored: Array<{ entry: SettingEntry; matched: number; score: number; index: number }> = [];
  rows.forEach((row, index) => {
    let score = 0;
    let matched = 0;
    for (const word of words) {
      // A word that IS the page's name ("providers") names the page; then a
      // word in the card's own title, its page, its section, its search terms.
      const hit = row.tab === word || row.tab === `${word}s` ? 10
        : wordHits(row.label, word) ? 8
          : wordHits(row.tab, word) ? 5
            : wordHits(row.group, word) ? 3
              : wordHits(row.keywords, word) ? 2
                : 0;
      if (hit > 0) matched += 1;
      score += hit * (rarity.get(word) ?? 0);
    }
    // Most of the question has to land on the card, not one stray word.
    if (matched === 0 || matched * 2 < words.length) return;
    scored.push({ entry: row.entry, matched, score, index });
  });
  // More of the question beats a louder part of it; within a page, the
  // manifest's order is the page's order, so its first card leads.
  scored.sort((left, right) => right.matched - left.matched || right.score - left.score || left.index - right.index);
  // A card that answers fewer of the words than the best one is noise: "pr
  // chat transcripts" is one card, not three.
  const best = scored[0]?.matched ?? 0;
  return scored.filter((row) => row.matched === best).slice(0, Math.max(1, limit)).map((row) => row.entry);
}
