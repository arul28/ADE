// Mixed @-menu ranking: files, chats, lanes, and terminals share one score so
// a better-matching chat is not buried under vaguely matching files.

import {
  CHAT_MENTION_MAX_RESULTS,
  compareChatMentionRanks,
  scoreChatMentionCandidate,
} from "./chatMentions";
import type { ChatMentionSuggestion } from "./types/chatMentions";

export type ComposerAtMenuItem =
  | { type: "file"; path: string }
  | { type: "mention"; mention: ChatMentionSuggestion };

export function composerAtFileRankFields(path: string): { title: string; subtitle: string } {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator < 0) return { title: path, subtitle: "" };
  return { title: path.slice(separator + 1), subtitle: path.slice(0, separator + 1) };
}

type RankableAtItem = ComposerAtMenuItem & {
  id: string;
  title: string;
  subtitle?: string;
  lastActivityAt?: number | null;
};

/** Weaker than subsequence (3) and subtitle (4–7) hits so unmatched index rows stay last. */
const UNMATCHED_FILE_SCORE = 50;

function toMenuItem(entry: RankableAtItem): ComposerAtMenuItem {
  switch (entry.type) {
    case "file":
      return { type: "file", path: entry.path };
    case "mention":
      return { type: "mention", mention: entry.mention };
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

export function rankComposerAtMenuItems(
  files: Array<{ path: string }>,
  mentions: ChatMentionSuggestion[],
  query: string,
  limit = CHAT_MENTION_MAX_RESULTS,
): ComposerAtMenuItem[] {
  const scored: Array<{ item: RankableAtItem; score: number; titlePrefixLength: number }> = [];
  const seenFiles = new Set<string>();
  for (const file of files) {
    if (seenFiles.has(file.path)) continue;
    seenFiles.add(file.path);
    const fields = composerAtFileRankFields(file.path);
    const item: RankableAtItem = {
      type: "file",
      path: file.path,
      id: `file:${file.path}`,
      // Full path is the title so `@src/foo.ts about this` still prefix-matches
      // the file after trailing prose. Basename stays a subtitle so a named
      // file can match without the directory.
      title: file.path,
      subtitle: fields.title === file.path ? undefined : fields.title,
      lastActivityAt: 0,
    };
    // File search already decided this path belongs in the list. Keep it even
    // when our scorer cannot see the same fuzzy/token match, so a typed query
    // cannot blank the file rows the index just returned.
    const match = scoreChatMentionCandidate(item, query)
      ?? { score: UNMATCHED_FILE_SCORE, titlePrefixLength: 0 };
    scored.push({ item, score: match.score, titlePrefixLength: match.titlePrefixLength });
  }
  for (const mention of mentions) {
    const item: RankableAtItem = {
      type: "mention",
      mention,
      id: `${mention.kind}:${mention.id}`,
      title: mention.title,
      subtitle: mention.subtitle,
      lastActivityAt: mention.lastActivityAt,
    };
    const match = scoreChatMentionCandidate(item, query);
    if (match === null) continue;
    scored.push({ item, score: match.score, titlePrefixLength: match.titlePrefixLength });
  }
  scored.sort(compareChatMentionRanks);
  return scored.slice(0, Math.max(0, limit)).map((entry) => toMenuItem(entry.item));
}
