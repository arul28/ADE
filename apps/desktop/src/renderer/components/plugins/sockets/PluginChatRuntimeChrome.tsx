import React from "react";

import { isRecord, bounded } from "../../../../shared/plugins/parse";
import type { PluginManifestChatRuntimeCapabilities } from "../../../../shared/plugins/manifest";
import { normalizeVocabTone, type VocabTone } from "../../../../shared/plugins/vocabulary";
import { sourcesStore } from "./contributionStores";

/**
 * Chat chrome for a conversation a PLUGIN owns.
 *
 * Two unrelated-looking things live here because they answer the same question
 * from two directions: what does the chat around a plugin-owned session look
 * like. One half reads the runtime's declared capabilities and takes controls
 * OFF the composer; the other reads what the plugin said about the header and
 * puts chips ON it.
 *
 * ADE's composer has always been provider-agnostic — every session got a Stop
 * button and a follow-up control because every ADE runtime has both. A plugin
 * runtime need not: a hosted agent that accepts one prompt and answers once has
 * no interrupt to offer and no second turn to take, and drawing the controls
 * anyway means a reader presses Stop and nothing happens.
 */

/**
 * The capabilities a chat's composer reads, resolved from the manifest.
 *
 * Null for a session ADE's own runtimes own — the composer keeps exactly the
 * behaviour it had before this existed. Null ALSO for a plugin runtime this
 * machine cannot resolve (registry not loaded, plugin uninstalled, runtime
 * renamed), and that fallback is deliberate: a session whose manifest is out of
 * reach must not silently lose its Stop button.
 */
export type PluginChatRuntimeCapabilities = PluginManifestChatRuntimeCapabilities;

/** What a session's `runtimeRef` has to carry to be resolvable. */
export type PluginChatRuntimePointer = {
  pluginId: string;
  runtimeId: string;
};

/**
 * Read one runtime's `capabilities` off a RAW manifest.
 *
 * Structural rather than typed because the sources cache holds unparsed
 * manifests — parsing one per render of the composer would be a full manifest
 * walk on every keystroke, and this needs four booleans.
 *
 * A field that is not literally `false` reads as ON. The manifest parser
 * requires all four and drops a runtime missing them, so the only way to reach
 * this with a hole is a manifest older than the field — and the honest reading
 * of an older manifest is "this runtime does everything a runtime did before
 * the field existed". Erring the other way would remove a Stop button from a
 * conversation that can be stopped.
 */
export function readPluginChatRuntimeCapabilities(
  manifest: unknown,
  runtimeId: string,
): PluginChatRuntimeCapabilities | null {
  if (!isRecord(manifest)) return null;
  const runtimes = manifest.chatRuntimes;
  if (!Array.isArray(runtimes)) return null;
  const runtime = runtimes.find((entry) => isRecord(entry) && entry.id === runtimeId);
  if (!isRecord(runtime)) return null;
  const caps = isRecord(runtime.capabilities) ? runtime.capabilities : {};
  return {
    followUp: caps.followUp !== false,
    interrupt: caps.interrupt !== false,
    hydrate: caps.hydrate !== false,
    artifacts: caps.artifacts !== false,
  };
}

/**
 * The capabilities of the runtime that owns this session, or null.
 *
 * Subscribes to the same sources cache every socket surface reads, so a plugin
 * that is enabled mid-session changes the chrome without a reload and one that
 * is disabled hands the chat back to the provider-agnostic default.
 */
export function usePluginChatRuntimeCapabilities(
  runtimeRef: PluginChatRuntimePointer | null | undefined,
): PluginChatRuntimeCapabilities | null {
  const sources = React.useSyncExternalStore(sourcesStore.subscribe, sourcesStore.getSnapshot);
  const pluginId = runtimeRef?.pluginId ?? null;
  const runtimeId = runtimeRef?.runtimeId ?? null;

  React.useEffect(() => {
    // Only a plugin-owned chat pays for the load. A Claude session never asks
    // the plugin host anything on behalf of its composer.
    if (!pluginId) return;
    sourcesStore.ensureLoaded();
  }, [pluginId, sources.status]);

  return React.useMemo(() => {
    if (!pluginId || !runtimeId) return null;
    const source = sources.sources.find((entry) => entry.pluginId === pluginId);
    if (!source || !source.enabled) return null;
    return readPluginChatRuntimeCapabilities(source.manifest, runtimeId);
  }, [pluginId, runtimeId, sources.sources]);
}

/* ── Header chips ───────────────────────────────────────────────────────── */

/**
 * The most chips a plugin may put beside the chat title.
 *
 * The title rail is 32px tall and already carries a lane chip, a cache badge
 * and a snooze pill. Four is what fits before the title itself starts
 * truncating, and a plugin that wants to say more has a panel to say it in.
 */
export const PLUGIN_CHAT_HEADER_CHIP_MAX = 4;

/** A chip is a WORD, not a sentence. The rail has no room for prose. */
export const PLUGIN_CHAT_HEADER_CHIP_LABEL_MAX = 24;

export type PluginChatHeaderChip = {
  label: string;
  tone: VocabTone;
};

export type PluginChatHeader = {
  chips: PluginChatHeaderChip[];
  /** An optional word for the runtime itself, shown before the chips. */
  label: string | null;
};

/**
 * A session's plugin header, validated.
 *
 * `unknown` in, validated out. The value is written by a plugin through
 * `chat.setHeader` and stored on the session, so by the time it reaches a
 * renderer it has been through the host, the database and the sync wire — and
 * every one of those is a place a shape can change under a client that shipped
 * months ago. Reading it defensively here means a malformed header draws
 * NOTHING rather than taking the chat header down with it.
 *
 * Over-cap is trimmed; an over-long label is refused rather than truncated,
 * because a chip cut mid-word says something the plugin did not write. A header
 * with no surviving chip and no label resolves to null.
 */
export function parsePluginChatHeader(value: unknown): PluginChatHeader | null {
  if (!isRecord(value)) return null;
  const label = bounded(value.label, PLUGIN_CHAT_HEADER_CHIP_LABEL_MAX);
  const raw = Array.isArray(value.chips) ? value.chips : [];
  const chips: PluginChatHeaderChip[] = [];
  for (const entry of raw) {
    if (chips.length >= PLUGIN_CHAT_HEADER_CHIP_MAX) break;
    if (!isRecord(entry)) continue;
    const chipLabel = bounded(entry.label, PLUGIN_CHAT_HEADER_CHIP_LABEL_MAX);
    if (!chipLabel) continue;
    chips.push({
      label: chipLabel,
      // Absent, unknown and misspelled tones all land on `neutral` — the same
      // fold every other plugin-authored tone in the product takes.
      tone: entry.tone === undefined ? "neutral" : normalizeVocabTone(entry.tone),
    });
  }
  if (chips.length === 0 && !label) return null;
  return { chips, label: label ?? null };
}

/**
 * Tone colours, matched to the header's own restraint.
 *
 * A chip beside the chat title is ambient information, so it is one step
 * quieter than the product's own header controls: tinted fill, no border, no
 * bold. `accent` is the chat's accent rather than a fixed violet so a chip
 * belongs to the conversation it is on.
 */
const CHIP_TONE_STYLE: Record<VocabTone, React.CSSProperties> = {
  neutral: { background: "rgba(255,255,255,0.06)", color: "rgb(228 228 231 / 0.62)" },
  accent: {
    background: "color-mix(in srgb, var(--chat-accent) 14%, transparent)",
    color: "var(--chat-accent)",
  },
  success: { background: "rgba(52,211,153,0.12)", color: "rgb(110 231 183 / 0.85)" },
  warning: { background: "rgba(251,191,36,0.12)", color: "rgb(252 211 77 / 0.85)" },
  destructive: { background: "rgba(248,113,113,0.12)", color: "rgb(252 165 165 / 0.85)" },
};

/** The chips, drawn beside the chat title. Nothing when there are none. */
export function PluginChatHeaderChips({ header }: { header: PluginChatHeader | null }) {
  if (!header || (header.chips.length === 0 && !header.label)) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-testid="plugin-chat-header-chips">
      {header.label ? (
        <span className="font-sans text-[10px] font-medium text-muted-fg/45">{header.label}</span>
      ) : null}
      {header.chips.map((chip, index) => (
        <span
          key={`${chip.label} ${index}`}
          className="inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 font-sans text-[10px] font-medium"
          style={CHIP_TONE_STYLE[chip.tone]}
        >
          {chip.label}
        </span>
      ))}
    </span>
  );
}
