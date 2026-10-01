// Draw the ADE entities an agent names in its replies as styled terminal runs.
//
// The rules are the desktop's (`shared/threadEntities.ts`); this file only maps
// a match onto an `InlineRun`. A terminal cannot draw a pill, so a chip becomes
// its real name (the lane name, not the uuid), in the lane's own colour, as an
// OSC 8 hyperlink to the entity's ADE deeplink.
//
// The lookup is module state, set by the app when its lanes or chats change.
// Every row builder (the visible rows AND the row counts used for scrolling and
// hit-testing) must wrap the same text, so they must all read one lookup; a
// prop threaded into only some of them would make the counts disagree.

import { chipDisplayLabel } from "../../../desktop/src/shared/chips";
import { buildDeeplink, parseDeeplink } from "../../../desktop/src/shared/deeplinks";
import {
  buildThreadEntityLookup,
  EMPTY_THREAD_ENTITY_LOOKUP,
  formatThreadEntityTimestamp,
  type ThreadEntity,
  type ThreadEntityLookup,
} from "../../../desktop/src/shared/threadEntities";

export type TuiThreadEntityFacts = {
  lookup: ThreadEntityLookup;
  laneById: Map<string, { name: string; color: string | null }>;
  chatTitleById: Map<string, string>;
};

const EMPTY_FACTS: TuiThreadEntityFacts = {
  lookup: EMPTY_THREAD_ENTITY_LOOKUP,
  laneById: new Map(),
  chatTitleById: new Map(),
};

let facts: TuiThreadEntityFacts = EMPTY_FACTS;
let factsSignature = "";
let factsVersion = 0;

/**
 * Replace the lookup. A no-op when nothing a match depends on changed, so a
 * lane status refresh does not invalidate every memoized transcript row.
 */
export function setTuiThreadEntityFacts(args: {
  lanes: ReadonlyArray<{ id: string; name: string; color: string | null }>;
  chats: ReadonlyArray<{ id: string; title: string | null }>;
  linearTeamKeys?: readonly string[];
  /** Slash commands and skills the attached chat can run, without the slash. */
  skillNames?: readonly string[];
}): void {
  const signature = JSON.stringify([
    args.lanes.map((lane) => [lane.id, lane.name, lane.color]),
    args.chats.map((chat) => [chat.id, chat.title]),
    args.linearTeamKeys ?? [],
    args.skillNames ?? [],
  ]);
  if (signature === factsSignature) return;
  factsSignature = signature;
  factsVersion += 1;
  facts = {
    lookup: buildThreadEntityLookup({
      lanes: args.lanes,
      sessions: args.chats,
      linearTeamKeys: args.linearTeamKeys,
      skillNames: args.skillNames,
    }),
    laneById: new Map(args.lanes.map((lane) => [lane.id.toLowerCase(), { name: lane.name, color: lane.color }])),
    chatTitleById: new Map(
      args.chats.flatMap((chat) => (chat.title?.trim() ? [[chat.id.toLowerCase(), chat.title.trim()] as const] : [])),
    ),
  };
}

export function tuiThreadEntityLookup(): ThreadEntityLookup {
  return facts.lookup;
}

/** Bumps whenever the lookup changes. Row memos key on it. */
export function tuiThreadEntityFactsVersion(): number {
  return factsVersion;
}

const CHAT_COLOR = "#7dd3fc";
const ENTITY_COLOR = "#c4b5fd";

export type TuiEntityRun = { text: string; color?: string; href?: string; link?: boolean; dim?: boolean };

/** The terminal run for one matched entity. */
export function tuiRunForThreadEntity(entity: ThreadEntity, now: number = Date.now()): TuiEntityRun {
  if (entity.type === "time") {
    return { text: formatThreadEntityTimestamp(entity.epochMs, entity.endEpochMs, now) };
  }
  if (entity.type === "file_line") {
    return {
      text: entity.raw,
      link: true,
      href: buildDeeplink({ kind: "file", path: entity.path, line: entity.line }),
    };
  }
  const chip = entity.chip;
  const source = chip.source;
  if (source.origin === "mention" && source.mentionKind === "lane") {
    const lane = facts.laneById.get(source.id.toLowerCase());
    return {
      text: lane?.name ?? chipDisplayLabel(chip),
      color: lane?.color ?? ENTITY_COLOR,
      link: true,
      href: buildDeeplink({ kind: "lane", laneId: source.id }),
    };
  }
  if (source.origin === "mention" && source.mentionKind === "chat") {
    return {
      text: facts.chatTitleById.get(source.id.toLowerCase()) ?? chipDisplayLabel(chip),
      color: CHAT_COLOR,
      link: true,
      href: buildDeeplink({ kind: "session", sessionId: source.id }),
    };
  }
  if (source.origin === "deeplink") {
    // A repo-less PR (`#1407`) has no deeplink that parses; colour it, but do
    // not hand the terminal a link that opens nothing.
    if (!parseDeeplink(source.url).ok) return { text: chipDisplayLabel(chip), color: ENTITY_COLOR };
    return { text: chipDisplayLabel(chip), color: ENTITY_COLOR, link: true, href: source.url };
  }
  // Model, permission and skill chips name a setting, not a place.
  return { text: chipDisplayLabel(chip), color: ENTITY_COLOR };
}
