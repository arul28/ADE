import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CTO_PROJECT_NOTES_MAX_BYTES,
  CTO_RULES_MAX_BYTES,
  CTO_SKILL_DESCRIPTION_MAX_CHARS,
  CTO_SKILL_MAX_BYTES,
  CTO_SKILLS_MAX,
  CTO_USER_NOTES_MAX_BYTES,
  ctoSkillSlug,
  type CtoSkillFile,
  type CtoSkillSummary,
} from "../../../shared/types/cto";
import { CTO_LEARNED_AREA_LABEL, type CtoLearnedArea, type CtoLearnedChange } from "../../../shared/types/chat";
import { AdeExpectedError } from "../../../shared/expectedError";
import { clipText, nowIso, redactSecrets, writeTextAtomic } from "../shared/utils";
import {
  assertBaseHash,
  matchLines,
  noteSimilarity,
  oneNoteLine,
  parseNoteLines,
  readFileOrEmpty,
  stripBullet,
  textHash,
  utf8Bytes,
} from "./ctoNoteText";

/*
 * How the CTO learns, beside its notes (`ctoMemoryService`):
 *
 * - `.ade/cto/RULES.md`: standing rules. The person writes them in Settings,
 *   the CTO adds one when the person gives it a rule or corrects it. All of
 *   it is injected on every turn.
 * - `.ade/cto/skills/<name>/SKILL.md`: one how-to per kind of task. Only the
 *   index (name and description) is injected; the CTO reads a skill when the
 *   task calls for it.
 * - `.ade/cto/learning/`: what each turn changed and how to undo it. A turn's
 *   baseline is the rules, skills and notes as the turn found them; at its end
 *   the difference is one "Learned" row in the chat. Undo restores a change
 *   from that baseline, and the change goes on an undone list the CTO's own
 *   writes are checked against, so it is never made again.
 *
 * Nothing here runs a model.
 */

type Logger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
};

type CtoLearningServiceArgs = {
  /** `.ade/cto`. */
  ctoDir: string;
  /** The project notes file (`.ade/cto/MEMORY.md`). */
  projectNotesPath: string;
  /** The notes about the person (`<ADE home>/cto/USER.md`). */
  userNotesPath: () => string;
  logger?: Logger | null;
  onChanged?: (() => void) | null;
};

/** A rule this close to an existing one is the same rule: sharpen it instead. */
const RULE_NEAR_DUPLICATE_SIMILARITY = 0.6;
/** A note or rule this close to an undone one is that change again. */
const UNDONE_SIMILARITY = 0.8;
const RULE_MAX_CHARS = 300;
const RULE_WHY_MAX_CHARS = 200;
/** "Rule — why": the separator between a rule and its reason. */
const RULE_WHY_SEPARATOR = " — ";
/** Learned turns kept for Undo, newest first. */
const LEARNED_TURNS_KEPT = 60;
const UNDONE_KEPT = 100;
/** Undone changes shown to the CTO on every turn, newest first. */
const UNDONE_INJECTED = 8;
const MATCH_CANDIDATES_SHOWN = 8;

type LineArea = Exclude<CtoLearnedArea, "skill">;

const LINE_AREA_LIMIT: Record<LineArea, { bytes: number; name: string }> = {
  rules: { bytes: CTO_RULES_MAX_BYTES, name: "Rules" },
  project_notes: { bytes: CTO_PROJECT_NOTES_MAX_BYTES, name: "Project notes" },
  user_notes: { bytes: CTO_USER_NOTES_MAX_BYTES, name: "Notes about you" },
};

type LearnState = {
  rules: string;
  project_notes: string;
  user_notes: string;
  /** Skill name → its whole SKILL.md. */
  skills: Map<string, string>;
};

type LearnedRecord = {
  v: 1;
  learnId: string;
  sessionId: string | null;
  turnId: string | null;
  at: string;
  changes: CtoLearnedChange[];
  /** The files the changes came from, as the turn found them. A skill the turn added is null. */
  before: Partial<Record<LineArea, string>> & { skills?: Record<string, string | null> };
  /** Each changed skill as the turn left it (null: removed), so Undo never drops a later edit. */
  after?: { skills?: Record<string, string | null> };
};

type UndoneItem = {
  area: CtoLearnedArea;
  op: CtoLearnedChange["op"];
  /** The line (or skill name) the change wrote; a removal: the line it took away. */
  text: string;
  at: string;
};

const UNDONE_AREAS: ReadonlySet<string> = new Set<CtoLearnedArea>(["rules", "skill", "project_notes", "user_notes"]);
const UNDONE_OPS: ReadonlySet<string> = new Set<CtoLearnedChange["op"]>(["added", "changed", "removed"]);

/** Undone entries from a file or an account copy; anything malformed is dropped. */
function parseUndoneItems(raw: unknown): UndoneItem[] {
  return (Array.isArray(raw) ? raw : []).flatMap((entry): UndoneItem[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.text !== "string" || typeof item.area !== "string" || typeof item.op !== "string") return [];
    if (!UNDONE_AREAS.has(item.area) || !UNDONE_OPS.has(item.op)) return [];
    return [{
      area: item.area as CtoLearnedArea,
      op: item.op as CtoLearnedChange["op"],
      text: item.text,
      at: typeof item.at === "string" ? item.at : nowIso(),
    }];
  });
}

export type CtoLearnedPayload = {
  learnId: string;
  sessionId: string | null;
  turnId: string | null;
  changes: CtoLearnedChange[];
};

export type CtoAddRuleResult =
  | { ok: true; rule: string; replaced?: string; bytes: number; limitBytes: number }
  | { ok: false; error: string; candidates?: string[] };

export type CtoRemoveRuleResult =
  | { ok: true; removed: string }
  | { ok: false; error: string; candidates?: string[] };

export type CtoSaveSkillResult =
  | { ok: true; name: string; created: boolean; bytes: number }
  | { ok: false; error: string };

export type CtoUndoLearnedOutcome =
  | { ok: true; payload: CtoLearnedPayload; note?: string }
  | { ok: false; error: string };

/* ── Text helpers ── */

/** The rule part of a "rule — why" line, for comparing two rules. */
function rulePart(line: string): string {
  const at = line.indexOf(RULE_WHY_SEPARATOR);
  return at > 0 ? line.slice(0, at) : line;
}

function withTrailingNewline(text: string): string {
  return text.length && !text.endsWith("\n") ? `${text}\n` : text;
}

/** The content with the first line whose item text is `text` dropped; null when none is. */
function dropLine(content: string, text: string): string | null {
  const lines = content.split(/\r?\n/);
  const at = lines.findIndex((line) => !line.trim().startsWith("#") && stripBullet(line) === text);
  if (at < 0) return null;
  lines.splice(at, 1);
  return withTrailingNewline(lines.join("\n").replace(/\n+$/, ""));
}

/** The content with the first line whose item text is `from` rewritten as `to`; null when none is. */
function swapLine(content: string, from: string, to: string): string | null {
  const lines = content.split(/\r?\n/);
  const at = lines.findIndex((line) => !line.trim().startsWith("#") && stripBullet(line) === from);
  if (at < 0) return null;
  lines[at] = `- ${to}`;
  return withTrailingNewline(lines.join("\n"));
}

function appendLine(content: string, text: string): string {
  const base = content.replace(/\n+$/, "");
  return `${base.length ? `${base}\n` : ""}- ${text}\n`;
}

type LineRevert =
  | { kind: "write"; next: string }
  /** Nothing to do: the change is already taken back. */
  | { kind: "already" }
  /** The line the turn wrote was edited since: putting the old one back would undo that edit too. */
  | { kind: "changed_since" };

/** One line change taken back from `content`. */
function revertLineChange(content: string, change: CtoLearnedChange): LineRevert {
  const lines = parseNoteLines(content);
  if (change.op === "added") {
    const next = dropLine(content, change.text);
    return next == null ? { kind: "already" } : { kind: "write", next };
  }
  if (change.op === "removed") {
    return lines.includes(change.text) ? { kind: "already" } : { kind: "write", next: appendLine(content, change.text) };
  }
  const previous = change.previous ?? "";
  const next = swapLine(content, change.text, previous);
  if (next != null) return { kind: "write", next };
  return previous && lines.includes(previous) ? { kind: "already" } : { kind: "changed_since" };
}

const ALREADY_REVERTED_NOTE: Record<CtoLearnedChange["op"], string> = {
  added: "It was already gone.",
  removed: "It was already back.",
  changed: "The earlier version is already there.",
};

/**
 * What changed between two versions of a line file. A removed line and an
 * added one that say nearly the same thing are one `changed` line (a rule
 * sharpened, a note rewritten); the rest are added or removed.
 */
export function diffLineItems(
  area: LineArea,
  before: string,
  after: string,
  /** The CTO's own `replaces` this turn, new line → the line it replaced. */
  replacedBy: ReadonlyMap<string, string> = new Map(),
): Array<Omit<CtoLearnedChange, "id">> {
  const left = parseNoteLines(before);
  const right = parseNoteLines(after);
  const unmatched = [...right];
  const removed: string[] = [];
  for (const line of left) {
    const at = unmatched.indexOf(line);
    if (at >= 0) unmatched.splice(at, 1);
    else removed.push(line);
  }
  const added = unmatched;
  const changes: Array<Omit<CtoLearnedChange, "id">> = [];
  const paired = new Set<number>();
  const leftovers: string[] = [];
  // A line the CTO replaced pairs with its replacement even when the two read
  // nothing alike ("Push to main" → "Never push to main"), so one Undo puts it back.
  const linkedFrom = (line: string): string | null => {
    let at = replacedBy.get(line);
    for (let hops = 0; at != null && hops < replacedBy.size; hops += 1) {
      if (removed.includes(at)) return at;
      at = replacedBy.get(at);
    }
    return null;
  };
  const linked = new Map<string, number>();
  added.forEach((line, index) => {
    const old = linkedFrom(line);
    if (old != null && !linked.has(old)) linked.set(old, index);
  });
  for (const old of removed) {
    const link = linked.get(old);
    if (link != null) {
      paired.add(link);
      changes.push({ area, op: "changed", text: added[link]!, previous: old });
      continue;
    }
    let best = -1;
    let bestScore = 0.35;
    added.forEach((line, index) => {
      if (paired.has(index) || [...linked.values()].includes(index)) return;
      const score = noteSimilarity(area === "rules" ? rulePart(old) : old, area === "rules" ? rulePart(line) : line);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    if (best >= 0) {
      paired.add(best);
      changes.push({ area, op: "changed", text: added[best]!, previous: old });
    } else {
      leftovers.push(old);
    }
  }
  added.forEach((line, index) => {
    if (!paired.has(index)) changes.push({ area, op: "added", text: line });
  });
  for (const line of leftovers) changes.push({ area, op: "removed", text: line });
  return changes;
}

/* ── Skills ── */

/** Which skills changed between two states, with each one's text before and after (null: absent). */
function diffSkills(start: ReadonlyMap<string, string>, end: ReadonlyMap<string, string>): {
  changes: Array<Omit<CtoLearnedChange, "id">>;
  before: Record<string, string | null>;
  after: Record<string, string | null>;
} {
  const changes: Array<Omit<CtoLearnedChange, "id">> = [];
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  for (const name of [...new Set([...start.keys(), ...end.keys()])].sort()) {
    const was = start.get(name) ?? null;
    const now = end.get(name) ?? null;
    if (was === now) continue;
    before[name] = was;
    after[name] = now;
    const description = parseSkillText(now ?? was ?? "").description;
    changes.push({
      area: "skill",
      op: was == null ? "added" : now == null ? "removed" : "changed",
      text: name,
      ...(description ? { detail: description } : {}),
    });
  }
  return { changes, before, after };
}

type ParsedSkill = { name: string | null; description: string; body: string; hasFrontmatter: boolean };

function parseSkillText(text: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { name: null, description: "", body: text.trim(), hasFrontmatter: false };
  let name: string | null = null;
  let description = "";
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(name|description)\s*:\s*(.*)$/.exec(line.trim());
    if (!field) continue;
    const value = field[2]!.trim().replace(/^["']|["']$/g, "");
    if (field[1] === "name") name = value || null;
    else description = value;
  }
  return { name, description, body: text.slice(match[0].length).trim(), hasFrontmatter: true };
}

function renderSkill(name: string, description: string, body: string): string {
  const safeDescription = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${safeDescription}\n---\n\n${body.trim()}\n`;
}

export function createCtoLearningService(args: CtoLearningServiceArgs) {
  const logger = args.logger ?? null;
  const rulesPath = path.join(args.ctoDir, "RULES.md");
  const skillsDir = path.join(args.ctoDir, "skills");
  const learningDir = path.join(args.ctoDir, "learning");
  const turnsDir = path.join(learningDir, "turns");
  const undonePath = path.join(learningDir, "undone.json");

  const changed = (): void => args.onChanged?.();

  const lineFilePath = (area: LineArea): string =>
    area === "rules" ? rulesPath : area === "project_notes" ? args.projectNotesPath : args.userNotesPath();

  const readLineFile = (area: LineArea): string => readFileOrEmpty(lineFilePath(area));

  const writeLineFile = (area: LineArea, content: string): void => {
    const target = lineFilePath(area);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeTextAtomic(target, content);
  };

  /* ── Undone list ── */

  const readUndone = (): UndoneItem[] => {
    const raw = readFileOrEmpty(undonePath);
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw) as { items?: unknown };
      return parseUndoneItems(parsed?.items);
    } catch (error) {
      logger?.warn("cto_learning.undone_unreadable", { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  };

  const writeUndone = (items: readonly UndoneItem[]): void => {
    fs.mkdirSync(learningDir, { recursive: true });
    writeTextAtomic(undonePath, `${JSON.stringify({ version: 1, items: items.slice(-UNDONE_KEPT) }, null, 2)}\n`);
  };

  /** An account copy's undone list replaces this machine's: the CTO moved here with it. */
  const replaceUndone = (items: unknown): void => {
    writeUndone(parseUndoneItems(items));
    changed();
  };

  const sameText = (area: CtoLearnedArea, a: string, b: string): boolean => {
    if (area === "skill") return a === b;
    if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
    return area === "rules"
      ? noteSimilarity(rulePart(a), rulePart(b)) >= UNDONE_SIMILARITY
      : noteSimilarity(a, b) >= UNDONE_SIMILARITY;
  };

  /**
   * Why the CTO may not make this change, or null. `write` is adding or
   * rewriting a line (or saving a skill); `remove` is taking one away.
   */
  const undoneRefusal = (area: CtoLearnedArea, kind: "write" | "remove", text: string): string | null => {
    const hit = [...readUndone()].reverse().find((item) => item.area === area
      && (kind === "write" ? item.op !== "removed" : item.op === "removed")
      && sameText(area, item.text, text));
    if (!hit) return null;
    const what = kind === "write" ? "this change" : "removing this";
    return `The person undid ${what} on ${hit.at.slice(0, 10)} ("${clipText(hit.text, 160)}"). `
      + "Do not make it again. Only if they ask for it again in their own words this turn, retry with personAskedAgain: true.";
  };

  /** The person wrote it themselves: an undone entry their text now matches no longer applies. */
  const forgiveUndone = (area: CtoLearnedArea, applies: (item: UndoneItem) => boolean): void => {
    const items = readUndone();
    const kept = items.filter((item) => item.area !== area || !applies(item));
    if (kept.length !== items.length) writeUndone(kept);
  };

  const forgiveLineFile = (area: LineArea, content: string): void => {
    const lines = parseNoteLines(content);
    forgiveUndone(area, (item) => (item.op === "removed"
      ? !lines.some((line) => line === item.text)
      : lines.some((line) => line === item.text)));
  };

  /* ── Rules ── */

  const readRules = (): string => readFileOrEmpty(rulesPath);

  const rulesFullMessage = (bytes: number): string =>
    `Rules are full (${bytes} of ${CTO_RULES_MAX_BYTES} bytes). Merge or remove a rule first.`;

  /**
   * The CTO's write: one rule plus one clause of why, as `- rule — why`. A
   * rule close to an existing one is refused with that rule, so the CTO
   * sharpens it (`replaces`) instead of adding a near-copy.
   */
  const addRule = (input: {
    rule: string;
    why: string;
    replaces?: string | null;
    personAskedAgain?: boolean;
  }): CtoAddRuleResult => {
    let rule = oneNoteLine(input.rule, RULE_MAX_CHARS).replace(/[\s.;,]+$/, "");
    // A model that writes "rule — why" in `rule` too: keep the rule part, so the reason is said once.
    const embeddedAt = rule.indexOf(RULE_WHY_SEPARATOR);
    const embeddedWhy = embeddedAt > 0 ? rule.slice(embeddedAt + RULE_WHY_SEPARATOR.length).trim() : "";
    if (embeddedAt > 0) rule = rule.slice(0, embeddedAt).trim();
    const why = oneNoteLine(input.why?.trim() ? input.why : embeddedWhy, RULE_WHY_MAX_CHARS)
      .replace(/^(?:because|why:)\s*/i, "")
      .replace(/[\s.;,]+$/, "")
      // A clause after the dash: "— the user wants…", but "— CI runs…" keeps its acronym.
      .replace(/^([A-Z])(?=[a-z])/, (letter) => letter.toLowerCase());
    if (!rule.length) return { ok: false, error: "The rule is empty." };
    if (!why.length) return { ok: false, error: "Say why in one clause: a rule without its reason gets misapplied." };
    const line = `${rule}${RULE_WHY_SEPARATOR}${why}.`;
    const content = readRules();
    const items = parseNoteLines(content);
    const replaces = input.replaces?.trim() ? stripBullet(input.replaces) : null;
    let next: string;
    let replaced: string | undefined;
    if (replaces) {
      const matches = matchLines(items, replaces);
      if (matches.length !== 1) {
        return {
          ok: false,
          error: matches.length
            ? `${matches.length} rules contain "${replaces}". Pass more of the rule you mean.`
            : `No rule contains "${replaces}".`,
          candidates: (matches.length ? matches.map((index) => items[index]!) : items).slice(0, MATCH_CANDIDATES_SHOWN),
        };
      }
      replaced = items[matches[0]!]!;
      next = swapLine(content, replaced, line) ?? appendLine(content, line);
    } else {
      const duplicate = items.find((item) => item.toLowerCase() === line.toLowerCase())
        ?? items.find((item) => noteSimilarity(rulePart(item), rule) >= RULE_NEAR_DUPLICATE_SIMILARITY);
      if (duplicate) {
        return {
          ok: false,
          error: `A rule already says this: "${duplicate}". Sharpen that one: pass part of it in \`replaces\`.`,
          candidates: [duplicate],
        };
      }
      next = appendLine(content, line);
    }
    if (!input.personAskedAgain) {
      const refusal = undoneRefusal("rules", "write", line);
      if (refusal) return { ok: false, error: refusal };
    }
    const bytes = utf8Bytes(next);
    if (bytes > CTO_RULES_MAX_BYTES) return { ok: false, error: rulesFullMessage(utf8Bytes(content)) };
    writeLineFile("rules", next);
    changed();
    if (replaced) ctoReplaced("rules", replaced, line);
    return { ok: true, rule: line, ...(replaced ? { replaced } : {}), bytes, limitBytes: CTO_RULES_MAX_BYTES };
  };

  const removeRule = (input: { rule: string; personAskedAgain?: boolean }): CtoRemoveRuleResult => {
    const needle = stripBullet(input.rule);
    if (!needle.length) return { ok: false, error: "Say which rule to remove." };
    const content = readRules();
    const items = parseNoteLines(content);
    const matches = matchLines(items, needle);
    if (matches.length !== 1) {
      return {
        ok: false,
        error: matches.length
          ? `${matches.length} rules contain "${needle}". Pass more of the rule you mean.`
          : `No rule contains "${needle}".`,
        candidates: (matches.length ? matches.map((index) => items[index]!) : items).slice(0, MATCH_CANDIDATES_SHOWN),
      };
    }
    const target = items[matches[0]!]!;
    if (!input.personAskedAgain) {
      const refusal = undoneRefusal("rules", "remove", target);
      if (refusal) return { ok: false, error: refusal };
    }
    writeLineFile("rules", dropLine(content, target) ?? content);
    changed();
    return { ok: true, removed: target };
  };

  /**
   * The person's write from Settings: the whole file, kept as written
   * (headings and all), secret-scrubbed. `baseHash` refuses a write over a
   * file that changed since the editor loaded it.
   */
  const writeRulesText = (text: string, options?: { baseHash?: string | null }): void => {
    assertBaseHash(readRules(), options?.baseHash);
    const content = withTrailingNewline(redactSecrets(text).replace(/\r\n/g, "\n").replace(/\n+$/, ""));
    const bytes = utf8Bytes(content);
    if (bytes > CTO_RULES_MAX_BYTES) throw new AdeExpectedError(rulesFullMessage(bytes), "user");
    writeLineFile("rules", content);
    personWrote("rules");
    changed();
  };

  /* ── Skills ── */

  const skillPath = (name: string): string => path.join(skillsDir, name, "SKILL.md");

  const readSkillNames = (): string[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && ctoSkillSlug(entry.name) === entry.name && fs.existsSync(skillPath(entry.name)))
      .map((entry) => entry.name)
      .sort();
  };

  const summarize = (name: string, text: string): CtoSkillSummary => {
    let updatedAt: string | null = null;
    try {
      updatedAt = new Date(fs.statSync(skillPath(name)).mtimeMs).toISOString();
    } catch {
      updatedAt = null;
    }
    return { name, description: parseSkillText(text).description, bytes: utf8Bytes(text), updatedAt };
  };

  const listSkills = (): CtoSkillSummary[] =>
    readSkillNames().slice(0, CTO_SKILLS_MAX).map((name) => summarize(name, readFileOrEmpty(skillPath(name))));

  const readSkill = (rawName: string): CtoSkillFile | null => {
    const name = ctoSkillSlug(rawName);
    if (!name) return null;
    let text: string;
    try {
      text = fs.readFileSync(skillPath(name), "utf8");
    } catch {
      return null;
    }
    return { ...summarize(name, text), text, hash: textHash(text) };
  };

  const writeSkillFile = (name: string, text: string): void => {
    fs.mkdirSync(path.dirname(skillPath(name)), { recursive: true });
    writeTextAtomic(skillPath(name), text);
  };

  const removeSkillDir = (name: string): void => {
    fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
  };

  /** The CTO's write: a whole how-to for one kind of task. Saving an existing name sharpens it. */
  const saveSkill = (input: {
    name: string;
    description: string;
    body: string;
    personAskedAgain?: boolean;
  }): CtoSaveSkillResult => {
    const name = ctoSkillSlug(input.name);
    if (!name) return { ok: false, error: "Name the skill with letters or digits, e.g. \"release-a-lane\"." };
    const description = oneNoteLine(input.description, CTO_SKILL_DESCRIPTION_MAX_CHARS);
    if (!description) return { ok: false, error: "Say in one line which tasks the skill is for." };
    const body = redactSecrets(input.body).trim();
    if (!body) return { ok: false, error: "The skill is empty: write the steps." };
    const exists = fs.existsSync(skillPath(name));
    if (!exists && readSkillNames().length >= CTO_SKILLS_MAX) {
      return { ok: false, error: `Skills are full (${CTO_SKILLS_MAX}). Merge two or delete one first.` };
    }
    if (!input.personAskedAgain) {
      const refusal = undoneRefusal("skill", "write", name);
      if (refusal) return { ok: false, error: refusal };
    }
    const text = renderSkill(name, description, body);
    const bytes = utf8Bytes(text);
    if (bytes > CTO_SKILL_MAX_BYTES) {
      return { ok: false, error: `The skill is ${bytes} bytes; the cap is ${CTO_SKILL_MAX_BYTES}. Cut it to the steps that matter.` };
    }
    writeSkillFile(name, text);
    changed();
    return { ok: true, name, created: !exists, bytes };
  };

  /** The person's write from Settings: the whole SKILL.md. A file with no frontmatter gets one. */
  const writeSkillText = (input: { name: string; text: string; baseHash?: string | null }): CtoSkillFile => {
    const name = ctoSkillSlug(input.name);
    if (!name) throw new AdeExpectedError("Name the skill with letters or digits.", "user");
    const current = readFileOrEmpty(skillPath(name));
    assertBaseHash(current, input.baseHash);
    if (!current && readSkillNames().length >= CTO_SKILLS_MAX) {
      throw new AdeExpectedError(`Skills are full (${CTO_SKILLS_MAX}). Delete one first.`, "user");
    }
    const parsed = parseSkillText(redactSecrets(input.text).replace(/\r\n/g, "\n"));
    if (!parsed.body) throw new AdeExpectedError("The skill is empty.", "user");
    const description = clipText(
      (parsed.description || parsed.body.split("\n").find((line) => line.trim()) || name).replace(/^#+\s*/, "").trim(),
      CTO_SKILL_DESCRIPTION_MAX_CHARS,
    );
    const text = renderSkill(name, description, parsed.body);
    if (utf8Bytes(text) > CTO_SKILL_MAX_BYTES) {
      throw new AdeExpectedError(`The skill is over ${CTO_SKILL_MAX_BYTES} bytes.`, "user");
    }
    writeSkillFile(name, text);
    personWroteSkill(name);
    changed();
    return readSkill(name)!;
  };

  type DeleteSkillResult = { ok: true; name: string } | { ok: false; error: string };

  /** The CTO deletes a skill: refused when the person undid that delete, unless they asked again. */
  const deleteSkill = (rawName: string, options?: { personAskedAgain?: boolean }): DeleteSkillResult => {
    const name = ctoSkillSlug(rawName);
    if (!name || !fs.existsSync(skillPath(name))) return { ok: false, error: `No skill is named "${rawName}".` };
    if (!options?.personAskedAgain) {
      const refusal = undoneRefusal("skill", "remove", name);
      if (refusal) return { ok: false, error: refusal };
    }
    removeSkillDir(name);
    changed();
    return { ok: true, name };
  };

  /** The person deletes a skill (Settings, another device, an account copy): never something the CTO learned. */
  const deleteSkillAsPerson = (rawName: string): DeleteSkillResult => {
    const name = ctoSkillSlug(rawName);
    if (!name || !fs.existsSync(skillPath(name))) return { ok: false, error: `No skill is named "${rawName}".` };
    removeSkillDir(name);
    personWroteSkill(name);
    changed();
    return { ok: true, name };
  };

  /* ── Per-turn context ── */

  /**
   * Rules in full, the skills index, and what the person undid. Rides every
   * turn, before the notes: rules are standing orders, so they go first.
   */
  const buildContextSections = (): Array<{ title: string; body: string }> => {
    const rules = readRules();
    const skills = listSkills();
    const undone = readUndone().slice(-UNDONE_INJECTED).reverse();
    const sections = [
      {
        title: `## Rules — ${utf8Bytes(rules)} of ${CTO_RULES_MAX_BYTES} bytes (the person's and yours; follow every one)`,
        body: rules.trim() || "(none yet)",
      },
      {
        title: "## Skills — before you do one of these kinds of task, readSkill it",
        body: skills.length
          ? skills.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"}`).join("\n")
          : "(none yet)",
      },
    ];
    if (undone.length) {
      sections.push({
        title: "## Undone by the person — never make these changes again",
        body: undone
          .map((item) => `- ${CTO_LEARNED_AREA_LABEL[item.area]} ${item.op}: ${clipText(item.text, 200)}`)
          .join("\n"),
      });
    }
    return sections;
  };

  /* ── Learning turns ── */

  const captureState = (): LearnState => ({
    rules: readLineFile("rules"),
    project_notes: readLineFile("project_notes"),
    user_notes: readLineFile("user_notes"),
    skills: new Map(readSkillNames().map((name) => [name, readFileOrEmpty(skillPath(name))])),
  });

  const baselinePath = path.join(learningDir, "baseline.json");

  /**
   * The open turn's baseline lives on disk too, so a turn a brain restart cut
   * short still gets its row when the CTO's next turn ends.
   */
  const readBaselineFile = (): LearnState | null => {
    const raw = readFileOrEmpty(baselinePath);
    if (!raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<Record<LineArea, unknown>> & { skills?: unknown };
      const text = (value: unknown): string => (typeof value === "string" ? value : "");
      const skills = parsed.skills && typeof parsed.skills === "object" ? parsed.skills as Record<string, unknown> : {};
      return {
        rules: text(parsed.rules),
        project_notes: text(parsed.project_notes),
        user_notes: text(parsed.user_notes),
        skills: new Map(Object.entries(skills).flatMap(([name, value]) => (typeof value === "string" ? [[name, value] as const] : []))),
      };
    } catch (error) {
      logger?.warn("cto_learning.baseline_unreadable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  const saveBaseline = (state: LearnState | null): void => {
    try {
      if (!state) {
        fs.rmSync(baselinePath, { force: true });
        return;
      }
      fs.mkdirSync(learningDir, { recursive: true });
      writeTextAtomic(baselinePath, JSON.stringify({
        rules: state.rules,
        project_notes: state.project_notes,
        user_notes: state.user_notes,
        skills: Object.fromEntries(state.skills),
      }));
    } catch (error) {
      logger?.warn("cto_learning.baseline_write_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  /** The open turn's baseline: what the rules, skills and notes were when it started. */
  let baseline: LearnState | null = readBaselineFile();

  /**
   * The lines the CTO itself wrote or dropped in the notes about the person
   * this turn. That file is shared by every project on the machine, so a
   * change there is this turn's only when the CTO made it: another project's
   * edit is never offered for Undo here. In memory: after a restart mid-turn
   * the turn's About-you changes go unlisted rather than misattributed.
   */
  const userNoteLinesThisTurn = new Set<string>();
  const ctoWroteUserNotes = (lines: readonly string[]): void => {
    for (const line of lines) userNoteLinesThisTurn.add(line);
  };
  /** The CTO's `replaces` this turn per area (new line → old), so the row pairs them as one change. */
  const replacedThisTurn = new Map<LineArea, Map<string, string>>();
  const ctoReplaced = (area: LineArea, previous: string, next: string): void => {
    const links = replacedThisTurn.get(area) ?? new Map<string, string>();
    links.set(next, previous);
    replacedThisTurn.set(area, links);
  };

  /**
   * The person changed a file in the middle of a turn (Settings, another
   * device, an account copy): their version becomes the baseline, so it is
   * never reported as something the CTO learned.
   */
  function personWrote(area: LineArea): void {
    const content = readLineFile(area);
    if (baseline) {
      baseline[area] = content;
      saveBaseline(baseline);
    }
    forgiveLineFile(area, content);
  }

  function personWroteSkill(name: string): void {
    const text = readFileOrEmpty(skillPath(name));
    if (baseline) {
      if (text) baseline.skills.set(name, text);
      else baseline.skills.delete(name);
      saveBaseline(baseline);
    }
    forgiveUndone("skill", (item) => item.text === name);
  }

  /** A CTO turn starts. Keeps an open baseline: a turn that never finished folds into this one. */
  const beginTurn = (): void => {
    if (baseline) return;
    userNoteLinesThisTurn.clear();
    replacedThisTurn.clear();
    try {
      baseline = captureState();
      saveBaseline(baseline);
    } catch (error) {
      baseline = null;
      logger?.warn("cto_learning.begin_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const recordPath = (learnId: string): string => path.join(turnsDir, `${learnId}.json`);

  const readRecord = (learnId: string): LearnedRecord | null => {
    if (!/^[a-z0-9-]{1,64}$/i.test(learnId)) return null;
    const raw = readFileOrEmpty(recordPath(learnId));
    if (!raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw) as LearnedRecord;
      return parsed?.v === 1 && Array.isArray(parsed.changes) ? parsed : null;
    } catch (error) {
      logger?.warn("cto_learning.record_unreadable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  const writeRecord = (record: LearnedRecord): void => {
    fs.mkdirSync(turnsDir, { recursive: true });
    writeTextAtomic(recordPath(record.learnId), `${JSON.stringify(record, null, 2)}\n`);
  };

  const pruneRecords = (): void => {
    try {
      const files = fs.readdirSync(turnsDir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => ({ file, mtime: fs.statSync(path.join(turnsDir, file)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const { file } of files.slice(LEARNED_TURNS_KEPT)) fs.rmSync(path.join(turnsDir, file), { force: true });
    } catch (error) {
      logger?.warn("cto_learning.prune_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * A CTO turn ended: what it changed against its baseline, saved for Undo.
   * Null when it changed nothing (or no turn was open).
   */
  const finishTurn = (meta: { sessionId?: string | null; turnId?: string | null }): CtoLearnedPayload | null => {
    const start = baseline;
    baseline = null;
    if (!start) return null;
    saveBaseline(null);
    let end: LearnState;
    try {
      end = captureState();
    } catch (error) {
      logger?.warn("cto_learning.finish_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    const changes: Array<Omit<CtoLearnedChange, "id">> = [];
    const before: LearnedRecord["before"] = {};
    const after: NonNullable<LearnedRecord["after"]> = {};
    const diffLines = (area: LineArea): void => {
      if (start[area] === end[area]) return;
      const lineChanges = diffLineItems(area, start[area], end[area], replacedThisTurn.get(area));
      if (!lineChanges.length) return;
      before[area] = start[area];
      changes.push(...lineChanges);
    };
    // The row lists rules first, then skills, then notes.
    diffLines("rules");
    const skills = diffSkills(start.skills, end.skills);
    if (skills.changes.length) {
      changes.push(...skills.changes);
      before.skills = skills.before;
      after.skills = skills.after;
    }
    diffLines("project_notes");
    if (start.user_notes !== end.user_notes) {
      const mine = diffLineItems("user_notes", start.user_notes, end.user_notes, replacedThisTurn.get("user_notes"))
        .filter((change) => userNoteLinesThisTurn.has(change.text) || (change.previous != null && userNoteLinesThisTurn.has(change.previous)));
      if (mine.length) {
        before.user_notes = start.user_notes;
        changes.push(...mine);
      }
    }
    userNoteLinesThisTurn.clear();
    replacedThisTurn.clear();
    if (!changes.length) return null;
    const record: LearnedRecord = {
      v: 1,
      learnId: `learn-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      sessionId: meta.sessionId?.trim() || null,
      turnId: meta.turnId?.trim() || null,
      at: nowIso(),
      changes: changes.map((change, index) => ({ ...change, id: `c${index + 1}` })),
      before,
      ...(after.skills ? { after } : {}),
    };
    try {
      writeRecord(record);
      pruneRecords();
    } catch (error) {
      // The row still shows; its Undo answers that the change can't be found.
      logger?.warn("cto_learning.record_write_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    return { learnId: record.learnId, sessionId: record.sessionId, turnId: record.turnId, changes: record.changes };
  };

  /**
   * The person's Undo on one change of a "Learned" row. Puts back what the
   * turn found and adds the change to the undone list. Idempotent: a second
   * Undo of the same change answers the same row.
   */
  const undo = (input: { learnId: string; changeId: string }): CtoUndoLearnedOutcome => {
    const record = readRecord(input.learnId.trim());
    if (!record) return { ok: false, error: "That change is too old to undo here. Edit it in Settings › Memory." };
    const change = record.changes.find((entry) => entry.id === input.changeId.trim());
    if (!change) return { ok: false, error: "That change is not in this row." };
    const payload = (): CtoLearnedPayload => ({
      learnId: record.learnId,
      sessionId: record.sessionId,
      turnId: record.turnId,
      changes: record.changes,
    });
    if (change.undone) return { ok: true, payload: payload() };
    let note: string | undefined;
    if (change.area === "skill") {
      // The name comes from a file on disk: never let it point outside skills/.
      if (ctoSkillSlug(change.text) !== change.text) return { ok: false, error: "That change can't be undone here. Edit it in Settings › Memory." };
      const left = record.after?.skills;
      if (left && Object.hasOwn(left, change.text) && (readFileOrEmpty(skillPath(change.text)) || null) !== left[change.text]) {
        // Someone edited it after that turn; putting the old file back would drop their edit.
        return { ok: false, error: "This skill changed after that turn. Edit it in Settings › Memory." };
      }
      const was = record.before.skills?.[change.text];
      if (was != null && !fs.existsSync(skillPath(change.text)) && readSkillNames().length >= CTO_SKILLS_MAX) {
        return { ok: false, error: `Skills are full (${CTO_SKILLS_MAX}). Delete one in Settings › Memory, then undo.` };
      }
      if (was == null) removeSkillDir(change.text);
      else writeSkillFile(change.text, was);
      if (baseline) {
        if (was == null) baseline.skills.delete(change.text);
        else baseline.skills.set(change.text, was);
      }
    } else {
      const area = change.area;
      const revert = revertLineChange(readLineFile(area), change);
      if (revert.kind === "changed_since") {
        return { ok: false, error: "That line changed after that turn. Edit it in Settings › Memory." };
      }
      if (revert.kind === "already") {
        note = ALREADY_REVERTED_NOTE[change.op];
      } else {
        const limit = LINE_AREA_LIMIT[area];
        if (utf8Bytes(revert.next) > limit.bytes) {
          return { ok: false, error: `${limit.name} are full (${limit.bytes} bytes). Make room in Settings › Memory, then undo.` };
        }
        writeLineFile(area, revert.next);
      }
      // The same edit on the open turn's baseline, so what that turn wrote
      // meanwhile still shows in its own row.
      if (baseline) {
        const onBaseline = revertLineChange(baseline[area], change);
        if (onBaseline.kind === "write") baseline[area] = onBaseline.next;
      }
    }
    if (baseline) saveBaseline(baseline);
    change.undone = true;
    try {
      writeRecord(record);
    } catch (error) {
      logger?.warn("cto_learning.record_write_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    writeUndone([...readUndone(), { area: change.area, op: change.op, text: change.text, at: nowIso() }]);
    changed();
    logger?.info?.("cto_learning.undone", { area: change.area, op: change.op });
    return { ok: true, payload: payload(), ...(note ? { note } : {}) };
  };

  return {
    readRules,
    readUndone,
    replaceUndone,
    rulesHash: () => textHash(readRules()),
    addRule,
    removeRule,
    writeRulesText,
    listSkills,
    readSkill,
    saveSkill,
    writeSkillText,
    deleteSkill,
    deleteSkillAsPerson,
    buildContextSections,
    undoneRefusal,
    personWrote,
    ctoWroteUserNotes,
    ctoReplaced,
    beginTurn,
    finishTurn,
    undo,
  };
}

export type CtoLearningService = ReturnType<typeof createCtoLearningService>;
