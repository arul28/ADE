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
  { id: "general", label: "General", description: "Project identity, launch behavior, updates, and privacy." },
  { id: "appearance", label: "Appearance", description: "How ADE looks and how the chat transcript reads." },
  { id: "agents", label: "Agents & Models", description: "Provider connections, model routing, and background helpers." },
  { id: "lanes-git", label: "Lanes & Git", description: "How lanes start, stay current, and tell you they fell behind." },
  { id: "integrations", label: "Integrations", description: "GitHub, Linear, and the ADE command line." },
  { id: "notifications", label: "Notifications & Sound", description: "What ADE interrupts you for, and how." },
  { id: "activity", label: "Activity", description: "What's running everywhere, and how ADE shows it." },
  // Named "Secrets & Environment" while planning, on the assumption that
  // `EnvironmentSection` held environment-variable mappings. It doesn't — it
  // was App version + ADE CLI, which now live in General and Integrations —
  // and ADE has no env-mapping UI. Secrets *are* the env-style values here
  // (they import straight from `.env`), so the tab is named for what it holds.
  { id: "secrets", label: "Secrets", description: "Encrypted key/value pairs for ADE agents, desktop, and the CLI." },
  { id: "storage", label: "Storage & Diagnostics", description: "What ADE keeps on disk, and what you can clear." },
  { id: "stats", label: "Stats", description: "Usage, spend, and pacing across your providers." },
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
  /**
   * Force the scope chip on. Scope is only worth the visual weight when it
   * would surprise — team-committed YAML, or anything that writes to a
   * different machine than the one you're looking at. Machine/app-scoped
   * settings inside an obviously local group leave it off.
   */
  showScopeChip?: boolean;
  /** Group heading the card sits under, within its tab. */
  group: string;
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
    showScopeChip: true,
    group: "Project",
  },
  {
    id: "general.launch-prompt",
    label: "Paste clipboard into new chats",
    keywords: ["clipboard", "launch", "prompt", "new chat"],
    tab: "general",
    anchor: "chat-launch-clipboard",
    scope: "app",
    group: "Starting work",
  },
  {
    id: "general.auto-updates",
    label: "Automatic updates",
    keywords: ["update", "upgrade", "release", "channel", "version"],
    tab: "general",
    anchor: "auto-updates",
    scope: "machine",
    group: "Updates",
  },
  {
    id: "general.analytics",
    label: "Product analytics",
    keywords: ["telemetry", "posthog", "tracking", "privacy", "opt out"],
    tab: "general",
    anchor: "product-analytics",
    scope: "machine",
    group: "Privacy",
  },
  {
    id: "general.about",
    label: "About ADE",
    keywords: ["version", "build", "license", "logs", "support"],
    tab: "general",
    anchor: "about",
    scope: "machine",
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
    group: "Theme",
  },
  {
    id: "appearance.chat-font-size",
    label: "Chat font size",
    keywords: ["text size", "typography", "zoom", "bigger", "smaller"],
    tab: "appearance",
    anchor: "chat-font-size",
    scope: "app",
    group: "Chat typography",
  },
  {
    id: "appearance.transcript-density",
    label: "Transcript density",
    keywords: ["compact", "comfortable", "spacious", "spacing"],
    tab: "appearance",
    anchor: "transcript-density",
    scope: "app",
    group: "Chat typography",
  },
  {
    id: "appearance.chat-tint",
    label: "Chat tint",
    keywords: ["color", "colored mode", "runtime color"],
    tab: "appearance",
    anchor: "chat-tint",
    scope: "app",
    group: "Chat surface",
  },
  {
    id: "appearance.chat-corners",
    label: "Chat shell corners",
    keywords: ["radius", "rounded", "sharp", "soft", "geometry"],
    tab: "appearance",
    anchor: "chat-corners",
    scope: "app",
    group: "Chat surface",
  },
  {
    id: "appearance.code-block-copy",
    label: "Code block copy button",
    keywords: ["copy", "snippet", "float", "top", "bottom"],
    tab: "appearance",
    anchor: "code-block-copy-position",
    scope: "app",
    group: "Chat details",
  },
  {
    id: "appearance.message-minimap",
    label: "User message minimap",
    keywords: ["minimap", "gutter", "tick", "jump", "navigate"],
    tab: "appearance",
    anchor: "user-message-minimap",
    scope: "app",
    group: "Chat details",
  },
  {
    id: "appearance.prompt-stash",
    label: "Prompt stash button",
    keywords: ["bookmark", "stash", "composer", "save prompt"],
    tab: "appearance",
    anchor: "prompt-stash-button",
    scope: "app",
    group: "Chat details",
  },
  {
    id: "appearance.preview",
    label: "Live preview",
    keywords: ["preview", "sample", "example", "what it looks like"],
    tab: "appearance",
    anchor: "appearance-preview",
    scope: "app",
    group: "Chat details",
  },
  {
    id: "appearance.terminal",
    label: "Terminal text",
    keywords: ["terminal", "font", "monospace", "size", "line height", "scrollback", "shell"],
    tab: "appearance",
    anchor: "terminal-text",
    scope: "app",
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
    showScopeChip: true,
    group: "Connections",
  },
  {
    id: "agents.background-jobs",
    label: "Background helpers",
    keywords: ["summarize", "pr description", "commit message", "auto-name", "naming", "automation"],
    tab: "agents",
    anchor: "background-jobs",
    scope: "team",
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
    group: "Background work",
  },
  {
    id: "agents.budget",
    label: "Spend cap",
    keywords: ["budget", "cost", "limit", "dollars", "spend"],
    tab: "agents",
    anchor: "budget-cap",
    scope: "team",
    showScopeChip: true,
    group: "Budget",
  },
  {
    id: "agents.dictation",
    label: "Voice input",
    keywords: ["dictation", "microphone", "speech", "whisper", "transcribe"],
    tab: "agents",
    anchor: "voice-input",
    scope: "machine",
    group: "Input",
  },

  // ── Lanes & Git ──────────────────────────────────────────────────────────
  {
    id: "lanes-git.new-lane-base",
    label: "New lane base",
    keywords: ["remote", "local", "branch", "upstream", "fetch", "start"],
    tab: "lanes-git",
    anchor: "new-lane-base",
    scope: "machine",
    group: "Starting lanes",
  },
  {
    id: "lanes-git.auto-rebase",
    label: "Auto-rebase child lanes",
    keywords: ["rebase", "stack", "parent", "child", "dependent", "current"],
    tab: "lanes-git",
    anchor: "auto-rebase",
    scope: "machine",
    group: "Rebase & stacking",
  },
  {
    id: "lanes-git.rebase-suggestions",
    label: "Rebase suggestions",
    keywords: ["banner", "badge", "notification", "behind", "nag", "suggest", "off", "quiet"],
    tab: "lanes-git",
    anchor: "rebase-suggestions",
    scope: "machine",
    group: "Rebase & stacking",
  },
  {
    id: "lanes-git.rebase-min-behind",
    label: "Only suggest after",
    keywords: ["threshold", "behind", "commits", "minimum", "rebase"],
    tab: "lanes-git",
    anchor: "rebase-min-behind",
    scope: "machine",
    group: "Rebase & stacking",
  },
  {
    id: "lanes-git.lane-templates",
    label: "Lane templates",
    keywords: ["template", "scaffold", "preset", "default lane"],
    tab: "lanes-git",
    anchor: "lane-templates",
    scope: "team",
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
    showScopeChip: true,
    group: "Linear",
  },
  {
    id: "integrations.ade-cli",
    label: "ADE command line",
    keywords: ["cli", "terminal", "ade code", "install", "path", "shell"],
    tab: "integrations",
    anchor: "ade-cli",
    scope: "machine",
    group: "Command line",
  },

  // ── Notifications & Sound ────────────────────────────────────────────────
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
    group: "What interrupts you",
  },
  {
    id: "notifications.focus-suppression",
    label: "Stay quiet while ADE is focused",
    keywords: ["focus", "quiet", "suppress", "do not disturb", "dnd", "mute"],
    tab: "notifications",
    anchor: "focus-suppression",
    scope: "app",
    group: "What interrupts you",
  },
  {
    id: "notifications.quiet-hours",
    label: "Quiet hours",
    keywords: ["schedule", "night", "silent", "window", "sleep"],
    tab: "notifications",
    anchor: "quiet-hours",
    scope: "machine",
    group: "What interrupts you",
  },
  {
    id: "notifications.phone",
    label: "Phone notifications",
    keywords: ["ios", "mobile", "push", "apns", "device"],
    tab: "notifications",
    anchor: "phone-notifications",
    scope: "machine",
    group: "Delivery",
  },
  {
    id: "notifications.live-activities",
    label: "Live Activities",
    keywords: ["lock screen", "dynamic island", "ios", "widget"],
    tab: "notifications",
    anchor: "live-activities",
    scope: "machine",
    group: "Delivery",
  },
  {
    id: "notifications.escalation",
    label: "Escalate to phone",
    keywords: ["delay", "desktop first", "handoff", "escalation"],
    tab: "notifications",
    anchor: "phone-escalation",
    scope: "machine",
    group: "Delivery",
  },
  {
    id: "notifications.completion-sound",
    label: "Agent completion sound",
    keywords: ["sound", "audio", "chime", "bell", "volume", "done"],
    tab: "notifications",
    anchor: "agent-completion-sound",
    scope: "app",
    group: "Sound",
  },
  {
    id: "notifications.lane-banners",
    label: "Lane banner budget",
    keywords: ["banner", "lanes", "header", "strip", "clutter", "budget", "max"],
    tab: "notifications",
    anchor: "lane-banner-budget",
    scope: "machine",
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
    showScopeChip: true,
    group: "Notch & menu bar",
  },
  {
    id: "activity.notch-reveal",
    label: "Notch behavior",
    keywords: ["reveal", "hover", "click", "peek", "compact"],
    tab: "activity",
    anchor: "activity-notch-reveal",
    scope: "machine",
    group: "Notch & menu bar",
  },
  {
    id: "activity.notch-expanded",
    label: "Expanded panel",
    keywords: ["panel", "expand", "list", "sessions", "tall"],
    tab: "activity",
    anchor: "activity-notch-expanded",
    scope: "machine",
    group: "Notch & menu bar",
  },
  {
    id: "activity.notch-auto-reveal",
    label: "Automatic reveal",
    keywords: ["reveal", "pop", "auto", "interrupt", "toast", "alert"],
    tab: "activity",
    anchor: "activity-auto-reveal",
    scope: "machine",
    group: "Notch & menu bar",
  },
  {
    id: "activity.notch-ticker",
    label: "Live ticker",
    keywords: ["ticker", "cycle", "strip", "live", "rotate", "status"],
    tab: "activity",
    anchor: "activity-ticker",
    scope: "machine",
    group: "Notch & menu bar",
  },
  {
    id: "activity.celebrations",
    label: "Celebrations",
    keywords: ["confetti", "flourish", "animation", "success"],
    tab: "activity",
    anchor: "activity-celebrations",
    scope: "machine",
    group: "Notch & menu bar",
  },
  {
    id: "activity.sounds",
    label: "Activity sounds",
    keywords: ["sound", "audio", "cue", "chime", "attention"],
    tab: "activity",
    anchor: "activity-sounds",
    scope: "machine",
    group: "Sound",
  },
  {
    id: "activity.hide-details",
    label: "Hide previews",
    keywords: ["privacy", "redact", "private", "content", "summary", "preview"],
    tab: "activity",
    anchor: "activity-hide-details",
    scope: "machine",
    group: "Privacy",
  },
  {
    id: "activity.machines",
    label: "Notify me about",
    keywords: ["machine", "mute", "silence", "mac", "device", "per-machine"],
    tab: "activity",
    anchor: "activity-machines",
    scope: "machine",
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
    showScopeChip: true,
    group: "Secrets",
  },

  // ── Storage & Diagnostics ────────────────────────────────────────────────
  {
    id: "storage.usage",
    label: "Disk usage",
    keywords: ["space", "size", "clean", "reclaim", "gb", "free"],
    tab: "storage",
    anchor: "storage",
    scope: "machine",
    group: "Disk",
  },
  {
    id: "storage.lane-rules",
    label: "Lane storage rules",
    keywords: ["archive", "inactivity", "cleanup", "worktree", "max lanes", "retention"],
    tab: "storage",
    anchor: "lane-storage-rules",
    scope: "team",
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
    group: "Sessions",
  },
  {
    id: "storage.diagnostics",
    label: "Diagnostics",
    keywords: ["debug", "logs", "health", "troubleshoot", "report"],
    tab: "storage",
    anchor: "diagnostics",
    scope: "machine",
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
  "voice-input": "agents.dictation",
  "chat-launch-clipboard": "general.launch-prompt",
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

export function settingsEntriesForTab(tab: SettingsTabId): SettingEntry[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.tab === tab);
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

/** Matching entries across every tab, best match first. */
export function searchSettingsEntries(query: string): SettingEntry[] {
  const q = query.trim();
  if (!q) return [];
  return SETTINGS_ENTRIES
    .map((entry) => ({ entry, score: scoreSettingsEntry(entry, q) }))
    .filter((row): row is { entry: SettingEntry; score: number } => row.score !== null)
    .sort((left, right) => left.score - right.score)
    .map((row) => row.entry);
}
