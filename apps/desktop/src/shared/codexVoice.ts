// ---------------------------------------------------------------------------
// Codex voice — the user's preferences and how they become instructions.
//
// Voice runs on the Codex app server's realtime session with the user's
// ChatGPT sign-in. Codex's own voice instructions stay in place (they carry the
// hand-off rules); these preferences add a style layer on top of them as a
// developer message at session start.
// ---------------------------------------------------------------------------

/** The voices Codex accepts for realtime protocol v3, which ADE uses. */
export const CODEX_VOICE_NAMES = [
  "cove",
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
] as const;
export type CodexVoiceName = (typeof CODEX_VOICE_NAMES)[number];
export const DEFAULT_CODEX_VOICE_NAME: CodexVoiceName = "cove";

export const CODEX_VOICE_PERSONALITIES = ["playful", "calm", "focused", "coach", "custom"] as const;
export type CodexVoicePersonality = (typeof CODEX_VOICE_PERSONALITIES)[number];

export const CODEX_VOICE_UPDATE_LEVELS = ["chatty", "balanced", "quiet"] as const;
export type CodexVoiceUpdateLevel = (typeof CODEX_VOICE_UPDATE_LEVELS)[number];

export type CodexVoicePreferences = {
  /** Shows the voice button in chat composers. */
  enabled: boolean;
  personality: CodexVoicePersonality;
  /** Used when `personality` is `custom`. */
  customPersonality: string;
  voice: CodexVoiceName;
  /** What voice calls the user. Empty lets Codex use the macOS account's first name. */
  preferredName: string;
  updates: CodexVoiceUpdateLevel;
  /** A language to always speak, or empty to answer in the language the user speaks. */
  language: string;
};

export const DEFAULT_CODEX_VOICE_PREFERENCES: CodexVoicePreferences = {
  enabled: true,
  personality: "playful",
  customPersonality: "",
  voice: DEFAULT_CODEX_VOICE_NAME,
  preferredName: "",
  updates: "balanced",
  language: "",
};

const TEXT_LIMIT = 600;
const NAME_LIMIT = 60;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function normalizeCodexVoicePreferences(value: unknown): CodexVoicePreferences {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: record.enabled !== false,
    personality: pick(record.personality, CODEX_VOICE_PERSONALITIES, DEFAULT_CODEX_VOICE_PREFERENCES.personality),
    customPersonality: text(record.customPersonality, TEXT_LIMIT),
    voice: pick(record.voice, CODEX_VOICE_NAMES, DEFAULT_CODEX_VOICE_NAME),
    preferredName: text(record.preferredName, NAME_LIMIT),
    updates: pick(record.updates, CODEX_VOICE_UPDATE_LEVELS, DEFAULT_CODEX_VOICE_PREFERENCES.updates),
    language: text(record.language, NAME_LIMIT),
  };
}

const PERSONALITY_INSTRUCTIONS: Record<Exclude<CodexVoicePersonality, "playful" | "custom">, string> = {
  calm: "Personality: calm and warm. Speak at an easy pace, keep a friendly tone, and skip jokes unless the user jokes first.",
  focused: "Personality: focused and efficient. Use the fewest words that answer. No small talk, no jokes, no filler.",
  coach: "Personality: a patient senior engineer. Explain the why behind what the agent does, briefly, and suggest a sensible next step.",
};

const UPDATE_INSTRUCTIONS: Record<CodexVoiceUpdateLevel, string> = {
  chatty: "While the agent works, give frequent short progress updates as you learn what it is doing.",
  balanced: "While the agent works, give a short acknowledgement when you hand work off and an occasional brief update.",
  quiet: "While the agent works, stay quiet after a one-word acknowledgement. Speak again when there is a result or a question.",
};

/**
 * The style layer ADE adds on top of Codex's voice instructions. `playful` is
 * Codex's own default personality, so it adds nothing for personality.
 */
export function buildCodexVoiceStyleInstructions(preferences: CodexVoicePreferences): string {
  const lines: string[] = [];
  if (preferences.personality === "custom" && preferences.customPersonality) {
    lines.push(`Personality, as the user described it (this replaces your default personality): ${preferences.customPersonality}`);
  } else if (preferences.personality !== "playful" && preferences.personality !== "custom") {
    lines.push(`${PERSONALITY_INSTRUCTIONS[preferences.personality]} This replaces your default personality.`);
  }
  if (preferences.preferredName) {
    lines.push(`Call the user ${preferences.preferredName}.`);
  }
  lines.push(UPDATE_INSTRUCTIONS[preferences.updates]);
  lines.push(preferences.language
    ? `Always speak ${preferences.language}, whatever language the user uses.`
    : "Answer in the language the user speaks.");
  return lines.join("\n");
}
