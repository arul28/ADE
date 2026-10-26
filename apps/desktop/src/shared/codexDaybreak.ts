// ---------------------------------------------------------------------------
// Codex Daybreak: OpenAI's broader access for authorized cybersecurity work.
//
// Mirrors Codex 0.164's own client (codex-rs/tui/src/daybreak.rs and
// protocol/src/openai_models/access_programs.rs at rust-v0.164.0):
//
// - `model/list` reports, per model and per signed-in account, the access
//   programs that account may ask for: `availableAccessPrograms.cyber`.
//   Missing or empty metadata never implies access.
// - With Daybreak on, a turn asks for `cyberAccessProgram`: Daybreak Blue
//   when offered, else Daybreak Red. The server still enforces access.
// - With it off, ADE sends nothing, so OpenAI keeps its automatic treatment
//   (what every ADE chat got before this switch existed).
// - The choice is also saved on the Codex thread
//   (`thread/metadata/update { daybreakEnabled }`), the same place Codex's own
//   app keeps it.
// ---------------------------------------------------------------------------

export type CodexDaybreakProgram = "daybreakBlue" | "daybreakRed";
/** The access programs Codex 0.164 knows, in the app-server's camelCase names. */
export type CodexAccessProgram = "standard" | CodexDaybreakProgram;

const PROGRAM_ALIASES: Record<string, CodexAccessProgram> = {
  standard: "standard",
  daybreakblue: "daybreakBlue",
  daybreak_blue: "daybreakBlue",
  daybreakred: "daybreakRed",
  daybreak_red: "daybreakRed",
};

/**
 * The programs a `model/list` row offers, normalized to the app-server's
 * camelCase names. Unknown programs are dropped, as Codex itself does.
 * Undefined when the row carries no program metadata at all.
 */
export function readCodexCyberAccessPrograms(row: unknown): CodexAccessProgram[] | undefined {
  const record = row && typeof row === "object" ? row as Record<string, unknown> : null;
  const programs = record?.availableAccessPrograms;
  const cyber = programs && typeof programs === "object"
    ? (programs as { cyber?: unknown }).cyber
    : undefined;
  if (!Array.isArray(cyber)) return undefined;
  const normalized = cyber.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const name = PROGRAM_ALIASES[entry.trim().toLowerCase()];
    return name ? [name] : [];
  });
  return [...new Set(normalized)];
}

/** The Daybreak program a turn asks for, or null when the model offers none. */
export function codexDaybreakProgram(programs: readonly CodexAccessProgram[] | null | undefined): CodexDaybreakProgram | null {
  if (!programs?.length) return null;
  if (programs.includes("daybreakBlue")) return "daybreakBlue";
  if (programs.includes("daybreakRed")) return "daybreakRed";
  return null;
}
