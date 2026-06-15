import fs from "node:fs";
import path from "node:path";

import { resolveBundledResource } from "./bundledResources";

/**
 * Shared voice-dictation glossary, loaded from
 * `apps/desktop/resources/voice/voice-glossary.json`.
 *
 * Schema mirrors the iOS bundle copy at `apps/ios/ADE/Resources/VoiceGlossary.json`:
 *   - `contextualTerms`: recognizer biasing hints (unused by the desktop
 *     deterministic pass; Whisper has no contextual-strings API, so they only
 *     matter on iOS — kept here so both platforms read one schema).
 *   - `corrections`: misheard (lowercased) -> canonical replacement, applied
 *     case-insensitively on whole-phrase/word boundaries.
 *   - `fillers`: removed only as standalone tokens/phrases.
 */
export type VoiceGlossary = {
  version: number;
  contextualTerms: string[];
  corrections: Record<string, string>;
  fillers: string[];
};

/**
 * Glossary with its corrections pre-sorted longest-first. Sorting once at load
 * keeps `cleanTranscript` cheap and guarantees multi-word phrases ("work tree")
 * are matched before their single-word prefixes.
 */
export type PreparedGlossary = {
  version: number;
  contextualTerms: string[];
  /** Correction entries, sorted by source phrase length descending. */
  corrections: Array<{ from: string; to: string }>;
  fillers: string[];
};

const EMPTY_GLOSSARY: PreparedGlossary = {
  version: 0,
  contextualTerms: [],
  corrections: [],
  fillers: [],
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a case-insensitive, whole-phrase matcher. We use lookarounds rather
 * than `\b` so phrases that begin or end with non-word characters (e.g.
 * "cr-sqlite", "cherry-pick") still match on natural word boundaries.
 */
function wholePhraseRegExp(phrase: string): RegExp {
  const escaped = escapeRegExp(phrase.trim());
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=[^\\p{L}\\p{N}]|$)`, "giu");
}

/**
 * Prepare a raw glossary for repeated use: corrections sorted longest-first so
 * the longest matching phrase always wins.
 */
export function prepareGlossary(glossary: VoiceGlossary): PreparedGlossary {
  const corrections = Object.entries(glossary.corrections ?? {})
    .map(([from, to]) => ({ from, to }))
    .filter((entry) => entry.from.trim().length > 0)
    .sort((a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from));
  return {
    version: glossary.version ?? 0,
    contextualTerms: Array.isArray(glossary.contextualTerms) ? glossary.contextualTerms : [],
    corrections,
    fillers: Array.isArray(glossary.fillers) ? glossary.fillers.filter((f) => f.trim().length > 0) : [],
  };
}

/**
 * Deterministic dictation cleanup. The algorithm MUST stay in lockstep with the
 * iOS implementation (`apps/ios/ADE/Services/Dictation/DictationCleanup.swift`):
 *
 *   a. Trim.
 *   b. Remove fillers (standalone token/phrase, word-boundary, case-insensitive);
 *      collapse the resulting double spaces.
 *   c. Apply corrections, longest-first, case-insensitive whole-phrase match,
 *      replacing with the canonical value.
 *   d. Capitalize the first letter of each sentence (start + after . ! ?). The
 *      rest of each word is left untouched (so "OpenAI" / "SwiftUI" survive).
 *   e. Collapse multiple spaces; remove the space before , . ! ? ; :.
 */
export function cleanTranscript(raw: string, glossary: PreparedGlossary): string {
  // (a) Trim.
  let text = (raw ?? "").trim();
  if (!text) return "";

  // (b) Remove fillers as standalone tokens/phrases.
  for (const filler of glossary.fillers) {
    const matcher = wholePhraseRegExp(filler);
    // Replace the matched phrase but keep the leading boundary char so adjacent
    // words don't fuse (e.g. "um so" -> " so", later collapsed).
    text = text.replace(matcher, (_full, lead: string) => lead);
  }
  // Collapse double spaces introduced by filler removal.
  text = text.replace(/[ \t]{2,}/g, " ").trim();

  // (c) Apply corrections, longest-first.
  for (const { from, to } of glossary.corrections) {
    const matcher = wholePhraseRegExp(from);
    text = text.replace(matcher, (_full, lead: string) => `${lead}${to}`);
  }

  // (d) Capitalize the first letter of each sentence.
  text = capitalizeSentences(text);

  // (e) Collapse multiple spaces and tidy spacing before punctuation.
  text = text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();

  return text;
}

/**
 * Uppercase the first letter at the start of the string and after each
 * sentence terminator (`.`, `!`, `?`). Only the first character is changed;
 * the remainder of every word keeps its original casing.
 */
function capitalizeSentences(text: string): string {
  let result = "";
  let capitalizeNext = true;
  for (const char of text) {
    if (capitalizeNext && /\p{L}/u.test(char)) {
      result += char.toUpperCase();
      capitalizeNext = false;
      continue;
    }
    result += char;
    if (char === "." || char === "!" || char === "?") {
      capitalizeNext = true;
    } else if (capitalizeNext && !/\s/.test(char)) {
      // A non-letter, non-space leading char (e.g. a quote) doesn't consume the
      // pending capitalization; keep waiting for the first letter.
    }
  }
  return result;
}

let cachedGlossary: PreparedGlossary | null = null;
let cachedGlossaryPath: string | null = null;

/**
 * Resolve the glossary JSON path. Packaged builds read from
 * `process.resourcesPath/voice`; dev reads the repo copy under
 * `apps/desktop/resources/voice`.
 */
export function resolveGlossaryPath(options?: {
  resourcesPath?: string | null;
  isPackaged?: boolean;
}): string {
  const isPackaged = options?.isPackaged ?? Boolean((process as { resourcesPath?: string }).resourcesPath && process.env.NODE_ENV === "production");
  const resourcesPath = options?.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath;
  return resolveBundledResource(path.join("voice", "voice-glossary.json"), { isPackaged, resourcesPath });
}

/**
 * Load + prepare the glossary, caching by resolved path. Returns an empty
 * glossary (cleanup becomes trim/space-normalize only) if the file is missing
 * or malformed, so transcription never hard-fails on a glossary read.
 */
export function loadGlossary(options?: {
  resourcesPath?: string | null;
  isPackaged?: boolean;
  explicitPath?: string;
}): PreparedGlossary {
  const target = options?.explicitPath ?? resolveGlossaryPath(options);
  if (cachedGlossary && cachedGlossaryPath === target) {
    return cachedGlossary;
  }
  try {
    const raw = fs.readFileSync(target, "utf8");
    const parsed = JSON.parse(raw) as VoiceGlossary;
    cachedGlossary = prepareGlossary(parsed);
    cachedGlossaryPath = target;
    return cachedGlossary;
  } catch {
    return EMPTY_GLOSSARY;
  }
}

/** Test-only: drop the cached glossary so a new path/content is re-read. */
export function __resetGlossaryCacheForTests(): void {
  cachedGlossary = null;
  cachedGlossaryPath = null;
}
