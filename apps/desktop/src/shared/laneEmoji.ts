import type { LaneIcon } from "./types/lanes";

/**
 * Small, meaning-rich vocabulary for Jev. The full user picker loads the
 * Unicode name catalogue on demand; Jev only needs these lane-oriented choices.
 */
export const LANE_EMOJI_OPTIONS: readonly { emoji: string; meaning: string }[] = [
  { emoji: "🐛", meaning: "fix a crash, bug, error, regression, race, or other broken behavior; takes priority over the subsystem being fixed" },
  { emoji: "✨", meaning: "feature, improvement, new capability" },
  { emoji: "💡", meaning: "idea, exploration, prototype" },
  { emoji: "🧪", meaning: "tests, experiments, quality" },
  { emoji: "🎨", meaning: "design, styling, visual polish" },
  { emoji: "✅", meaning: "verification, validation, completed work" },
  { emoji: "📋", meaning: "checklist, planning, task tracking" },
  { emoji: "📝", meaning: "writing, notes, changelog" },
  { emoji: "📚", meaning: "documentation, learning, references" },
  { emoji: "🔬", meaning: "research, investigation, debugging" },
  { emoji: "🕵️", meaning: "tracing, diagnosis, root-cause analysis" },
  { emoji: "⚡", meaning: "performance, speed, responsiveness" },
  { emoji: "🚀", meaning: "release, launch, deployment" },
  { emoji: "🔒", meaning: "security, permissions, access control" },
  { emoji: "🛡️", meaning: "safety, protection, resilience" },
  { emoji: "🚨", meaning: "urgent fix, alert, outage" },
  { emoji: "🔧", meaning: "tooling, maintenance, repair" },
  { emoji: "🛠️", meaning: "infrastructure, engineering tools" },
  { emoji: "⚙️", meaning: "configuration, settings, systems" },
  { emoji: "🧹", meaning: "cleanup, refactor, remove dead code" },
  { emoji: "♻️", meaning: "refactor, restructure, simplify code" },
  { emoji: "🏗️", meaning: "large implementation, rebuild, architecture" },
  { emoji: "🧭", meaning: "navigation, routing, discovery" },
  { emoji: "📱", meaning: "iOS, mobile, phone experience" },
  { emoji: "💻", meaning: "desktop, client application" },
  { emoji: "🖥️", meaning: "desktop UI, renderer, display" },
  { emoji: "🌐", meaning: "web, networking, cross-platform" },
  { emoji: "🔗", meaning: "integration, linking, connections" },
  { emoji: "📈", meaning: "analytics, growth, metrics" },
  { emoji: "📊", meaning: "charts, reporting, visualization" },
  { emoji: "🔍", meaning: "search, filtering, lookup" },
  { emoji: "🧵", meaning: "concurrency, async processing, or thread coordination; a race-condition fix is a bug fix" },
  { emoji: "📦", meaning: "packaging, dependencies, distribution" },
  { emoji: "🧩", meaning: "plugin, extension, modular feature" },
  { emoji: "🎛️", meaning: "controls, preferences, interaction" },
  { emoji: "🪄", meaning: "automation, AI, smart assistance" },
  { emoji: "🧠", meaning: "AI, reasoning, machine learning" },
  { emoji: "🗂️", meaning: "organization, workspace, file management" },
  { emoji: "🏷️", meaning: "labels, metadata, categorization" },
  { emoji: "🔄", meaning: "build or improve a normal sync, refresh, retry, or state-update flow; use only when not fixing a bug, crash, or error" },
  { emoji: "⏱️", meaning: "timing, scheduling, waits" },
  { emoji: "🕸️", meaning: "web interface, browser, frontend" },
  { emoji: "💬", meaning: "chat, messaging, conversation" },
  { emoji: "🔔", meaning: "notifications, alerts, attention" },
  { emoji: "🎯", meaning: "focus, goals, precision" },
  { emoji: "🧬", meaning: "data model, schema, migration" },
  { emoji: "🧊", meaning: "cache, storage, or cold-start work when the task is not fixing a bug or race" },
  { emoji: "🪵", meaning: "logging, traces, diagnostics" },
  { emoji: "🪲", meaning: "bugs, defects, unexpected behavior" },
  { emoji: "🧑‍💻", meaning: "developer workflow, coding experience" },
  { emoji: "🧑‍🔬", meaning: "research, analysis, technical discovery" },
  { emoji: "🗺️", meaning: "maps, location, routing" },
  { emoji: "📡", meaning: "remote machines, connectivity, relay" },
  { emoji: "🔋", meaning: "capacity, resources, system health" },
  { emoji: "🎉", meaning: "milestone, completion, celebration" },
  { emoji: "🧰", meaning: "developer tools, utilities, workbench" },
  { emoji: "🪛", meaning: "maintenance, small fixes, adjustment" },
  { emoji: "🧯", meaning: "incident response, reliability, recovery" },
  { emoji: "🔐", meaning: "authentication, credentials, secrets" },
  { emoji: "🪪", meaning: "identity, accounts, profile" },
  { emoji: "🔀", meaning: "branches, merge flow, routing choices" },
  { emoji: "🌱", meaning: "new work, growth, early feature" },
  { emoji: "🪢", meaning: "dependencies, links, related work" },
  { emoji: "🧾", meaning: "receipts, records, billing" },
  { emoji: "🗃️", meaning: "data storage, archives, records" },
  { emoji: "🧱", meaning: "architecture, foundations, core systems" },
  { emoji: "🧮", meaning: "calculations, algorithms, numeric work" },
  { emoji: "🗜️", meaning: "compression, bundling, optimization" },
];

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

const LEGACY_LANE_ICON_EMOJI: Record<Exclude<LaneIcon, null>, string> = {
  star: "⭐",
  flag: "🚩",
  bolt: "⚡",
  shield: "🛡️",
  tag: "🏷️",
};
const LEGACY_EMOJI_LANE_ICON = Object.fromEntries(
  Object.entries(LEGACY_LANE_ICON_EMOJI).map(([icon, emoji]) => [emoji, icon]),
) as Record<string, Exclude<LaneIcon, null>>;

/** Trim and NFC-normalize one emoji grapheme, or return null for an empty value. */
export function normalizeLaneEmoji(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("Lane emoji must be one emoji or empty.");

  const normalized = value.normalize("NFC").trim();
  if (!normalized) return null;

  const graphemes = segmenter
    ? Array.from(segmenter.segment(normalized), (part) => part.segment)
    : Array.from(normalized);
  const isEmoji = /\p{Extended_Pictographic}/u.test(normalized)
    || /^\p{Regional_Indicator}{2}$/u.test(normalized)
    || normalized.includes("\u20e3");
  if (graphemes.length !== 1 || !isEmoji) {
    throw new Error("Lane emoji must be one emoji or empty.");
  }
  return normalized;
}

/** Preserve the meaning of lane icons written by older ADE peers. */
export function legacyLaneIconEmoji(icon: LaneIcon | string | null | undefined): string | null {
  if (!icon) return null;
  return LEGACY_LANE_ICON_EMOJI[icon as Exclude<LaneIcon, null>] ?? null;
}

/** Preserve a matching old glyph for peers that have not learned lane emoji. */
export function legacyLaneEmojiIcon(emoji: string | null | undefined): LaneIcon | null {
  return emoji ? LEGACY_EMOJI_LANE_ICON[emoji] ?? null : null;
}

export function laneEmojiForDisplay(emoji?: string | null, legacyIcon?: LaneIcon | null): string | null {
  return emoji ?? legacyLaneIconEmoji(legacyIcon);
}
