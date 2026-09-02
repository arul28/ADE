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

import { isWebClientMode } from "../../lib/webClientMode";
import {
  hasWebMachineBinding,
  isBuiltinSurfaceShown,
  type BuiltinSurfaceGate,
} from "./settingsAvailability";
import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";

/**
 * Where a setting lands when the renderer is the hosted web client.
 *
 * A browser has no Electron shell and reaches its machine only through the
 * actions the sync host registers, so a setting either travels to that machine,
 * syncs through the ADE account, never leaves the browser tab — or has nowhere
 * to go at all. `hidden` is that last case, and it is why Secrets, providers,
 * GitHub credentials, the CLI installer, auto-updates, storage,
 * session lifecycle, and lane templates stay off the web nav: their reads land
 * but their writes would resolve against a missing descriptor and vanish.
 *
 * `SettingScope` answers "who does this affect"; this answers "does it work at
 * all from a browser, and what do we tell the user about where it went".
 */
export type SettingWebScope = "machine" | "account" | "browser" | "hidden";

/** Where a setting is persisted, and therefore who it affects. */
export type SettingScope =
  /** `.ade/ade.yaml` — committed, travels with the repo, affects the team. */
  | "team"
  /** `.ade/local.yaml` or a main-process service — this machine only. */
  | "machine"
  /** Renderer `appStore` (localStorage) — this app install only. */
  | "app";

export const SETTINGS_TAB_IDS = [
  "general",
  "appearance",
  "agents",
  "lanes-git",
  "integrations",
  "notifications",
  "activity",
  "secrets",
  "storage",
  "stats",
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

export type SettingsTab = {
  id: SettingsTabId;
  label: string;
  /** One line, shown under the tab title in the content header. */
  description: string;
};

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "general", label: "General", description: "ADE runtime status, project health, CLI access, and privacy." },
  { id: "appearance", label: "Appearance", description: "How ADE looks and how the chat transcript reads." },
  { id: "agents", label: "Agents & Models", description: "Provider connections, model routing, and background helpers." },
  { id: "lanes-git", label: "Lanes", description: "How lanes start, stay current, and tell you they fell behind." },
  { id: "integrations", label: "Integrations", description: "GitHub and Linear." },
  { id: "notifications", label: "Notifications", description: "What ADE interrupts you for, and how." },
  { id: "activity", label: "Activity", description: "What's running everywhere, and how ADE shows it." },
  // Named "Secrets & Environment" while planning, on the assumption that
  // `EnvironmentSection` held environment-variable mappings. It doesn't — it
  // was App version + ADE CLI, which now both live in General —
  // and ADE has no env-mapping UI. Secrets *are* the env-style values here
  // (they import straight from `.env`), so the tab is named for what it holds.
  { id: "secrets", label: "Secrets", description: "Encrypted key/value pairs for ADE agents, desktop, and the CLI." },
  { id: "storage", label: "Diagnostics", description: "What ADE keeps on disk, and what you can clear." },
  { id: "stats", label: "Usage", description: "Spend, limits, and pacing across your providers and machines." },
] as const;

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
  /**
   * Force the scope chip on. Scope is only worth the visual weight when it
   * would surprise — team-committed YAML, or anything that writes to a
   * different machine than the one you're looking at. Machine/app-scoped
   * settings inside an obviously local group leave it off.
   */
  showScopeChip?: boolean;
  /** Group heading the card sits under, within its tab. */
  group: string;
  /**
   * The compiled surface this setting's card belongs to, when a plugin owns it.
   *
   * The card is drawn by a gated component, so the setting exists only while
   * that surface is drawn. Naming the surface here is what keeps nav, in-page
   * search and the palette from offering a row whose anchor renders nothing —
   * a link that scrolls to an absent card and leaves the user on a tab they did
   * not ask for. Omitted by every setting ADE draws unconditionally.
   */
  builtinSurface?: PluginBuiltinSurfaceId;
};

/**
 * Every setting ADE exposes. Order within a tab is the render order.
 */
export const SETTINGS_ENTRIES: readonly SettingEntry[] = [
  // ── General ──────────────────────────────────────────────────────────────
  {
    id: "general.project",
    label: "Project",
    keywords: ["icon", "name", "repository", "root"],
    tab: "general",
    anchor: "project",
    scope: "team",
    web: "hidden",
    showScopeChip: true,
    group: "Project",
  },
  {
    id: "general.ade-cli",
    label: "ADE command line",
    keywords: ["cli", "terminal", "ade code", "install", "path", "shell"],
    tab: "general",
    anchor: "ade-cli",
    scope: "machine",
    web: "hidden",
    group: "Command line",
  },
  {
    id: "general.auto-updates",
    label: "Automatic updates",
    keywords: ["update", "upgrade", "release", "channel", "version"],
    tab: "general",
    anchor: "auto-updates",
    scope: "machine",
    web: "hidden",
    group: "Updates",
  },
  {
    id: "general.keep-awake",
    label: "Keep this computer awake",
    keywords: ["sleep", "awake", "lid", "idle", "power", "battery", "caffeinate", "pmset"],
    tab: "general",
    anchor: "keep-awake",
    scope: "machine",
    // A browser holds no power lock and cannot read the machine's sleep
    // settings, so the write would resolve against nothing.
    web: "hidden",
    group: "Sleep",
  },
  {
    id: "general.analytics",
    label: "Product analytics",
    keywords: ["telemetry", "posthog", "tracking", "privacy", "opt out"],
    tab: "general",
    anchor: "product-analytics",
    scope: "machine",
    web: "browser",
    group: "Privacy",
  },
  {
    id: "general.diagnostics-sharing",
    // Not plain "Diagnostics": `storage.diagnostics` already owns that label,
    // and two identically named search hits pointing at different tabs is a
    // coin flip for whoever is looking for the off switch.
    label: "Diagnostics sharing",
    keywords: ["diagnostics", "crash", "report", "report issue", "privacy", "error", "send", "opt out"],
    tab: "general",
    anchor: "diagnostics-sharing",
    scope: "machine",
    // Machine-local consent written into `~/.ade/secrets` by the main process;
    // a browser has no such file, so the toggle is not offered there.
    web: "hidden",
    group: "Privacy",
  },
  {
    id: "general.about",
    label: "About ADE",
    keywords: ["version", "build", "license", "logs", "support"],
    tab: "general",
    anchor: "about",
    scope: "machine",
    web: "hidden",
    group: "About",
  },

  // ── Appearance ───────────────────────────────────────────────────────────
  {
    id: "appearance.theme",
    label: "Theme",
    keywords: ["dark", "light", "color", "accent"],
    tab: "appearance",
    anchor: "theme",
    scope: "app",
    web: "browser",
    group: "Theme",
  },
  {
    id: "appearance.chat-font-size",
    label: "Chat font size",
    keywords: ["text size", "typography", "zoom", "bigger", "smaller"],
    tab: "appearance",
    anchor: "chat-font-size",
    scope: "app",
    web: "browser",
    group: "Chat typography",
  },
  {
    id: "appearance.transcript-density",
    label: "Transcript density",
    keywords: ["compact", "comfortable", "spacious", "spacing"],
    tab: "appearance",
    anchor: "transcript-density",
    scope: "app",
    web: "browser",
    group: "Chat typography",
  },
  {
    id: "appearance.chat-tint",
    label: "Chat tint",
    keywords: ["color", "colored mode", "runtime color"],
    tab: "appearance",
    anchor: "chat-tint",
    scope: "app",
    web: "browser",
    group: "Chat surface",
  },
  {
    id: "appearance.chat-corners",
    label: "Chat shell corners",
    keywords: ["radius", "rounded", "sharp", "soft", "geometry"],
    tab: "appearance",
    anchor: "chat-corners",
    scope: "app",
    web: "browser",
    group: "Chat surface",
  },
  {
    id: "appearance.code-block-copy",
    label: "Code block copy button",
    keywords: ["copy", "snippet", "float", "top", "bottom"],
    tab: "appearance",
    anchor: "code-block-copy-position",
    scope: "app",
    web: "browser",
    group: "Chat details",
  },
  {
    id: "appearance.message-minimap",
    label: "User message minimap",
    keywords: ["minimap", "gutter", "tick", "jump", "navigate"],
    tab: "appearance",
    anchor: "user-message-minimap",
    scope: "app",
    web: "browser",
    group: "Chat details",
  },
  {
    id: "appearance.prompt-stash",
    label: "Prompt stash button",
    keywords: ["bookmark", "stash", "composer", "save prompt"],
    tab: "appearance",
    anchor: "prompt-stash-button",
    scope: "app",
    web: "browser",
    group: "Chat details",
  },
  {
    id: "appearance.launch-prompt",
    label: "Paste clipboard into new chats",
    keywords: ["clipboard", "launch", "prompt", "new chat"],
    tab: "appearance",
    anchor: "chat-launch-clipboard",
    scope: "app",
    web: "browser",
    group: "Chat details",
  },
  {
    id: "appearance.preview",
    label: "Live preview",
    keywords: ["preview", "sample", "example", "what it looks like"],
    tab: "appearance",
    anchor: "appearance-preview",
    scope: "app",
    web: "browser",
    group: "Chat details",
  },
  {
    id: "appearance.terminal",
    label: "Terminal text",
    keywords: ["terminal", "font", "monospace", "size", "line height", "scrollback", "shell"],
    tab: "appearance",
    anchor: "terminal-text",
    scope: "app",
    web: "browser",
    group: "Terminal",
  },

  // ── Agents & Models ──────────────────────────────────────────────────────
  {
    id: "agents.providers",
    label: "AI connections",
    keywords: ["provider", "api key", "anthropic", "openai", "claude", "codex", "auth", "model"],
    tab: "agents",
    anchor: "ai-providers",
    scope: "machine",
    web: "hidden",
    showScopeChip: true,
    group: "Connections",
  },
  // One entry per provider, so ⌘K, settings search, and deeplinks land on the
  // provider's own page rather than the top of the list. The keywords carry the
  // brand names a user actually types — "anthropic", "factory", "xai" — none of
  // which appear in the labels.
  {
    id: "agents.provider.claude",
    label: "Claude Code",
    keywords: ["anthropic", "claude", "provider", "sign in", "api key", "model", "permission"],
    tab: "agents",
    anchor: "ai-provider-claude",
    scope: "machine",
    web: "hidden",
    group: "Connections",
  },
  {
    id: "agents.provider.codex",
    label: "Codex CLI",
    keywords: ["openai", "chatgpt", "codex", "provider", "sign in", "api key", "model", "permission"],
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
    id: "agents.background-jobs",
    label: "Background helpers",
    keywords: ["summarize", "pr description", "commit message", "auto-name", "naming", "automation"],
    tab: "agents",
    anchor: "background-jobs",
    scope: "team",
    web: "hidden",
    showScopeChip: true,
    group: "Background work",
  },
  {
    id: "agents.scheduled-work",
    label: "Pause all scheduled work",
    keywords: ["cron", "wakeup", "loop", "schedule", "pause"],
    tab: "agents",
    anchor: "scheduled-work",
    scope: "machine",
    web: "hidden",
    group: "Background work",
  },
  {
    id: "agents.budget",
    label: "Spend cap",
    keywords: ["budget", "cost", "limit", "dollars", "spend"],
    tab: "agents",
    anchor: "budget-cap",
    scope: "team",
    web: "hidden",
    showScopeChip: true,
    group: "Budget",
  },

  // ── Lanes ────────────────────────────────────────────────────────────────
  {
    id: "lanes-git.new-lane-base",
    label: "New lane base",
    keywords: ["remote", "local", "branch", "upstream", "fetch", "start"],
    tab: "lanes-git",
    anchor: "new-lane-base",
    scope: "machine",
    web: "machine",
    group: "Starting lanes",
  },
  {
    id: "lanes-git.auto-rebase",
    label: "Auto-rebase child lanes",
    keywords: ["rebase", "stack", "parent", "child", "dependent", "current"],
    tab: "lanes-git",
    anchor: "auto-rebase",
    scope: "machine",
    web: "machine",
    group: "Rebase & stacking",
  },
  {
    id: "lanes-git.rebase-suggestions",
    label: "Rebase suggestions",
    keywords: ["banner", "badge", "notification", "behind", "nag", "suggest", "off", "quiet"],
    tab: "lanes-git",
    anchor: "rebase-suggestions",
    scope: "machine",
    web: "machine",
    group: "Rebase & stacking",
  },
  {
    id: "lanes-git.rebase-min-behind",
    label: "Only suggest after",
    keywords: ["threshold", "behind", "commits", "minimum", "rebase"],
    tab: "lanes-git",
    anchor: "rebase-min-behind",
    scope: "machine",
    web: "machine",
    group: "Rebase & stacking",
  },
  {
    id: "lanes-git.lane-templates",
    label: "Lane templates",
    keywords: ["template", "scaffold", "preset", "default lane"],
    tab: "lanes-git",
    anchor: "lane-templates",
    scope: "team",
    web: "hidden",
    showScopeChip: true,
    group: "Templates",
  },
  {
    id: "lanes-git.pr-chat-transcripts",
    label: "PR chat transcripts",
    keywords: ["pull request", "transcript", "attach", "review"],
    tab: "lanes-git",
    anchor: "pr-chat-transcripts",
    scope: "team",
    web: "machine",
    showScopeChip: true,
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
    showScopeChip: true,
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
    showScopeChip: true,
    group: "Linear",
    // `LinearIntegrationSection` returns null once `ade-linear` is installed,
    // so `#linear-connection` has nothing to scroll to. The plugin brings its
    // own settings section, and this row would compete with it.
    builtinSurface: "linear",
  },
  // ── Notifications ───────────────────────────────────────────────────────
  {
    id: "notifications.events",
    label: "Notify me about",
    keywords: [
      "notification", "alert", "turn complete", "question", "ci", "check",
      "review", "conflict", "desktop", "phone", "push", "silent", "matrix",
    ],
    tab: "notifications",
    anchor: "notification-events",
    scope: "machine",
    web: "account",
    group: "What interrupts you",
  },
  {
    id: "notifications.focus-suppression",
    label: "Stay quiet while ADE is focused",
    keywords: ["focus", "quiet", "suppress", "do not disturb", "dnd", "mute"],
    tab: "notifications",
    anchor: "focus-suppression",
    scope: "app",
    web: "account",
    group: "What interrupts you",
  },
  {
    id: "notifications.quiet-hours",
    label: "Quiet hours",
    keywords: ["schedule", "night", "silent", "window", "sleep"],
    tab: "notifications",
    anchor: "quiet-hours",
    scope: "machine",
    web: "account",
    group: "What interrupts you",
  },
  {
    id: "notifications.phone",
    label: "Phone notifications",
    keywords: ["ios", "mobile", "push", "apns", "device"],
    tab: "notifications",
    anchor: "phone-notifications",
    scope: "machine",
    web: "account",
    group: "Delivery",
  },
  {
    id: "notifications.live-activities",
    label: "Live Activities",
    keywords: ["lock screen", "dynamic island", "ios", "widget"],
    tab: "notifications",
    anchor: "live-activities",
    scope: "machine",
    web: "account",
    group: "Delivery",
  },
  {
    id: "notifications.escalation",
    label: "Escalate to phone",
    keywords: ["delay", "desktop first", "handoff", "escalation"],
    tab: "notifications",
    anchor: "phone-escalation",
    scope: "machine",
    web: "account",
    group: "Delivery",
  },
  {
    id: "notifications.completion-sound",
    label: "Agent completion sound",
    keywords: ["sound", "audio", "chime", "bell", "volume", "done"],
    tab: "notifications",
    anchor: "agent-completion-sound",
    scope: "app",
    web: "browser",
    group: "Sound",
  },
  {
    id: "notifications.lane-banners",
    label: "Lane banner budget",
    keywords: ["banner", "lanes", "header", "strip", "clutter", "budget", "max"],
    tab: "notifications",
    anchor: "lane-banner-budget",
    scope: "machine",
    web: "machine",
    group: "On-screen banners",
  },

  // ── Activity ─────────────────────────────────────────────────────────────
  {
    id: "activity.notch-enabled",
    label: "ADE notch",
    keywords: ["notch", "menu bar", "hud", "overlay", "ambient", "attention"],
    tab: "activity",
    anchor: "activity-notch",
    scope: "machine",
    web: "hidden",
    showScopeChip: true,
    group: "Notch & menu bar",
  },
  {
    id: "activity.notch-reveal",
    label: "Notch behavior",
    keywords: ["reveal", "hover", "always", "compact", "strip"],
    tab: "activity",
    anchor: "activity-notch-reveal",
    scope: "machine",
    web: "hidden",
    group: "Notch & menu bar",
  },
  {
    id: "activity.notch-expanded",
    label: "Expanded panel",
    keywords: ["panel", "expand", "list", "sessions", "tall"],
    tab: "activity",
    anchor: "activity-notch-expanded",
    scope: "machine",
    web: "hidden",
    group: "Notch & menu bar",
  },
  // `activity.notch-auto-reveal` and `activity.notch-ticker` are both retired:
  // the notch always flashes for work that needs you, and the strip has no
  // ticker to cycle — it is state-group counts, not scrolling text. Neither has
  // a card left for search to land on.
  {
    id: "activity.celebrations",
    label: "Celebrations",
    keywords: ["confetti", "flourish", "animation", "success"],
    tab: "activity",
    anchor: "activity-celebrations",
    scope: "machine",
    web: "hidden",
    group: "Notch & menu bar",
  },
  {
    id: "activity.sounds",
    label: "Activity sounds",
    keywords: ["sound", "audio", "cue", "chime", "attention"],
    tab: "activity",
    anchor: "activity-sounds",
    scope: "machine",
    web: "account",
    group: "Sound",
  },
  {
    id: "activity.hide-details",
    label: "Hide previews",
    keywords: ["privacy", "redact", "private", "content", "summary", "preview"],
    tab: "activity",
    anchor: "activity-hide-details",
    scope: "machine",
    web: "account",
    group: "Privacy",
  },
  {
    id: "activity.dock-badge",
    label: "Dock badge counts",
    keywords: ["dock", "badge", "count", "this mac", "all machines", "account"],
    tab: "activity",
    anchor: "activity-dock-badge",
    scope: "machine",
    web: "hidden",
    group: "Account",
  },
  {
    id: "activity.machines",
    label: "Notify me about",
    keywords: ["machine", "mute", "silence", "mac", "device", "per-machine"],
    tab: "activity",
    anchor: "activity-machines",
    scope: "machine",
    web: "account",
    showScopeChip: true,
    group: "Machines",
  },

  // ── Secrets ──────────────────────────────────────────────────────────────
  {
    id: "secrets.secrets",
    label: "Secrets",
    keywords: ["credential", "api key", "token", "keychain", "env", "password", "environment", "variable"],
    tab: "secrets",
    anchor: "secrets",
    scope: "machine",
    web: "hidden",
    showScopeChip: true,
    group: "Secrets",
  },

  // ── Diagnostics ──────────────────────────────────────────────────────────
  {
    id: "storage.usage",
    label: "Disk usage",
    keywords: ["space", "size", "clean", "reclaim", "gb", "free"],
    tab: "storage",
    anchor: "storage",
    scope: "machine",
    web: "hidden",
    group: "Disk",
  },
  {
    id: "storage.lane-rules",
    label: "Lane storage rules",
    keywords: ["archive", "inactivity", "cleanup", "worktree", "max lanes", "retention"],
    tab: "storage",
    anchor: "lane-storage-rules",
    scope: "team",
    web: "hidden",
    showScopeChip: true,
    group: "Disk",
  },
  {
    id: "storage.session-lifecycle",
    label: "Session lifecycle",
    keywords: ["session", "idle", "close", "terminal", "cleanup"],
    tab: "storage",
    anchor: "session-lifecycle",
    scope: "machine",
    web: "hidden",
    group: "Sessions",
  },
  {
    id: "storage.diagnostics",
    label: "Diagnostics",
    keywords: ["debug", "logs", "health", "troubleshoot", "report"],
    tab: "storage",
    anchor: "diagnostics",
    scope: "machine",
    web: "hidden",
    group: "Diagnostics",
  },

  // ── Stats ────────────────────────────────────────────────────────────────
  {
    id: "stats.usage",
    label: "Usage & spend",
    keywords: ["cost", "tokens", "pacing", "budget", "stats", "usage"],
    tab: "stats",
    anchor: "ade-usage",
    scope: "machine",
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
  "ade-usage": "stats",
  usage: "stats",
  disk: "storage",
  secret: "secrets",
  // Swept into General before this rewrite; now have real homes again.
  workspace: "general",
  project: "general",
  context: "general",
  integrations: "integrations",
  sync: "general",
  devices: "general",
  "multi-device": "general",
  github: "integrations",
  linear: "integrations",
  "computer-use": "general",
  onboarding: "general",
  help: "general",
  tours: "general",
  // The Attention center became the Activity pane and tab.
  attention: "activity",
};

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
  "chat-launch-clipboard": "appearance.launch-prompt",
  "github-connection": "integrations.github",
  "linear-connection": "integrations.linear",
  "pr-chat-transcripts": "lanes-git.pr-chat-transcripts",
  "session-lifecycle": "storage.session-lifecycle",
  "auto-updates": "general.auto-updates",
  "product-analytics": "general.analytics",
  storage: "storage.usage",
  // Moved out of Notifications when Activity got its own tab.
  "attention-notch": "activity.notch-enabled",
  celebrations: "activity.celebrations",
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
 * setting is reachable on the desktop; the web client drops the ones whose
 * writes have nowhere to land. Nav, search, and the palette all read this, so
 * a hidden setting is hidden everywhere at once rather than only in the nav.
 *
 * `resolveSettingsTab` and `resolveSettingsHash` deliberately do not: a URL
 * that names a hidden setting still resolves, and the settings shell decides
 * where to land it.
 */
export function isSettingAvailable(
  entry: SettingEntry,
  gate: BuiltinSurfaceGate = isBuiltinSurfaceShown,
): boolean {
  // Asked before the web-client rules, and on the desktop too: a plugin that
  // owns a compiled surface takes that surface's settings card away on every
  // renderer, which is not a question about where the write lands.
  //
  // The gate defaults to the installed resolver — the same answer — and is
  // taken as an argument so a React caller can hand in the gate it already
  // holds and name it as a memo dependency instead of reading it invisibly.
  if (entry.builtinSurface && !gate(entry.builtinSurface)) return false;
  if (!isWebClientMode()) return true;
  if (entry.web === "hidden") return false;
  // A machine-scoped setting writes to the machine the active project tab is
  // bound to. With no tab open there is no such machine, so the control would
  // be a write with nowhere to land — the same reason `hidden` exists.
  return entry.web !== "machine" || hasWebMachineBinding();
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
  // one machine-bound banner budget and one browser-local sound. The banner
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
 * The two live-state resolvers `isSettingAvailable` reads through, re-exported
 * so the manifest stays the one import site for the whole registry. The
 * implementations live in `settingsAvailability.ts` — they are the only mutable
 * state in an otherwise pure data module.
 */
export {
  clearBuiltinSurfaceResolver,
  clearWebMachineBindingResolver,
  hasWebMachineBinding,
  isBuiltinSurfaceShown,
  setBuiltinSurfaceResolver,
  setWebMachineBindingResolver,
  type BuiltinSurfaceGate,
} from "./settingsAvailability";

/** Every setting reachable in this renderer, in manifest order. */
export function availableSettingsEntries(): SettingEntry[] {
  // Wrapped rather than passed by reference: `filter` would hand the array
  // index in as the gate.
  return SETTINGS_ENTRIES.filter((entry) => isSettingAvailable(entry));
}

/**
 * Tabs with at least one reachable setting, in manifest order.
 *
 * Takes the gate rather than reading the installed resolver, because both
 * callers compute this inside a `useMemo` during the very render that installs
 * that resolver: the answer changes when the plugin registry changes, and a
 * dependency array cannot name a module global. Passing the gate makes the edge
 * visible to React — and the gate a React surface holds is the same function it
 * installed, so the answer is unchanged.
 */
export function availableSettingsTabs(gate: BuiltinSurfaceGate): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => settingsEntriesForTab(tab.id, gate).length > 0);
}

export function settingsEntriesForTab(tab: SettingsTabId, gate?: BuiltinSurfaceGate): SettingEntry[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.tab === tab && isSettingAvailable(entry, gate));
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

/** The route a palette entry or deeplink should navigate to. */
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
