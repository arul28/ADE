// The dictation glossary, and the deterministic cleanup it drives.
//
// `voice-glossary.json` moved into this package when dictation left the app.
// Its schema is unchanged, and deliberately so: ADE's iOS app carries the same
// file (`apps/ios/ADE/Resources/VoiceGlossary.json`) and runs the same passes on
// its own transcripts, so the two have to keep agreeing about what a filler is
// and how "work tree" is spelled. The algorithm below is the desktop half of
// that pair, carried over step for step from the service this plugin replaced.
//
//   contextualTerms — vocabulary the speaker is likely to use. The old desktop
//     path had no use for these (it noted that Whisper has no contextual-strings
//     API) and only iOS consumed them. This plugin does use them: whisper.cpp
//     takes an `--prompt`, so they become decoder bias here.
//   corrections    — misheard phrase -> canonical spelling, applied
//                    case-insensitively on whole-phrase boundaries.
//   fillers        — removed only as standalone tokens ("um", "you know").

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GLOSSARY_BASENAME = "voice-glossary.json";

const EMPTY_GLOSSARY = { version: 0, contextualTerms: [], corrections: [], fillers: [] };

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive whole-phrase matcher.
 *
 * Lookarounds rather than `\b`, so a phrase that begins or ends with a
 * non-word character ("cr-sqlite", "cherry-pick") still matches on a natural
 * boundary instead of failing at the hyphen.
 */
function wholePhraseRegExp(phrase) {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])(${escapeRegExp(phrase.trim())})(?=[^\\p{L}\\p{N}]|$)`,
    "giu",
  );
}

/**
 * Sort the corrections longest-first, once, at load.
 *
 * The order is load-bearing rather than an optimisation: applied shortest-first,
 * a single-word correction would fire inside a multi-word phrase and the longer
 * entry would never match its own text again.
 */
function prepareGlossary(raw) {
  if (!raw || typeof raw !== "object") return EMPTY_GLOSSARY;
  const corrections = Object.entries(raw.corrections ?? {})
    .filter(([from, to]) => typeof from === "string" && typeof to === "string" && from.trim())
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from));
  return {
    version: typeof raw.version === "number" ? raw.version : 0,
    contextualTerms: Array.isArray(raw.contextualTerms)
      ? raw.contextualTerms.filter((term) => typeof term === "string" && term.trim())
      : [],
    corrections,
    fillers: Array.isArray(raw.fillers)
      ? raw.fillers.filter((filler) => typeof filler === "string" && filler.trim())
      : [],
  };
}

let cached = null;

/**
 * The packaged glossary, read once.
 *
 * A missing or unreadable file is an empty glossary, never a throw: dictation
 * without the cleanup pass is worse output, while dictation that refuses to run
 * because a word list would not parse is no dictation at all.
 */
function loadBundledGlossary(pluginRoot, { reload = false } = {}) {
  if (cached && !reload) return cached;
  try {
    cached = prepareGlossary(JSON.parse(fs.readFileSync(path.join(pluginRoot, GLOSSARY_BASENAME), "utf8")));
  } catch {
    cached = EMPTY_GLOSSARY;
  }
  return cached;
}

/** Capitalize the first letter of each sentence, leaving the rest of every word
 * alone so "OpenAI" and "SwiftUI" survive the pass. */
function capitalizeSentences(text) {
  let out = "";
  let capitalizeNext = true;
  for (const char of text) {
    if (capitalizeNext && /\p{L}/u.test(char)) {
      out += char.toUpperCase();
      capitalizeNext = false;
      continue;
    }
    out += char;
    if (/[.!?]/.test(char)) capitalizeNext = true;
  }
  return out;
}

/**
 * The deterministic cleanup, in the order the iOS implementation uses:
 * fillers out, corrections in longest-first, sentences capitalized, spacing
 * tidied. No model, no network, no AI polish — the same input always produces
 * the same output, which is what makes it safe to run on every transcript.
 */
function cleanTranscript(raw, glossary) {
  let text = String(raw ?? "").trim();
  if (!text) return "";

  for (const filler of glossary.fillers) {
    // Keep the leading boundary character so neighbouring words do not fuse.
    text = text.replace(wholePhraseRegExp(filler), (_full, lead) => lead);
  }
  text = text.replace(/[ \t]{2,}/g, " ").trim();

  for (const { from, to } of glossary.corrections) {
    text = text.replace(wholePhraseRegExp(from), (_full, lead) => `${lead}${to}`);
  }

  text = capitalizeSentences(text);

  return text
    // One narrow addition to the ported algorithm, because removing a filler
    // is what creates the case: whisper punctuates "it is, you know, ready" as
    // a parenthetical, and taking the filler out leaves ",," in the user's
    // draft. Only separators that became adjacent are collapsed — runs of `.`
    // are left alone, since an ellipsis is something a person meant to say.
    .replace(/([,;:])(?:[ \t]*[,;:])+/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

module.exports = {
  EMPTY_GLOSSARY,
  GLOSSARY_BASENAME,
  capitalizeSentences,
  cleanTranscript,
  loadBundledGlossary,
  prepareGlossary,
  wholePhraseRegExp,
};
