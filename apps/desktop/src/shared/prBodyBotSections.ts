/**
 * Review bots edit the PR description itself: CodeRabbit appends release
 * notes, Cursor a summary, Devin a review badge. Shown in place, the author's
 * description ends in three blocks of bot output. This splits them out so the
 * description stays the author's and each block is shown as that bot's own
 * comment in the thread — nothing is dropped.
 */

export type PrBodyBotSection = {
  /** Stable id for the synthetic comment. */
  id: string;
  /** The bot's GitHub login, so it folds with the bot's other activity. */
  login: string;
  body: string;
};

/** Id prefix of the timeline events made from these sections. */
export const PR_DESCRIPTION_BOT_EVENT_PREFIX = "desc-bot:";

type Marker = { id: string; login: string; start: RegExp; end: RegExp };

const MARKERS: readonly Marker[] = [
  {
    id: "coderabbit-summary",
    login: "coderabbitai",
    start: /<!--\s*This is an auto-generated comment: release notes by coderabbit\.ai\s*-->/i,
    end: /<!--\s*end of auto-generated comment: release notes by coderabbit\.ai\s*-->/i,
  },
  {
    id: "cursor-summary",
    login: "cursor",
    start: /<!--\s*CURSOR_SUMMARY\s*-->/,
    end: /<!--\s*\/CURSOR_SUMMARY\s*-->/,
  },
  {
    id: "devin-review-badge",
    login: "devin-ai-integration",
    start: /<!--\s*devin-review-badge-begin\s*-->/i,
    end: /<!--\s*devin-review-badge-end\s*-->/i,
  },
];

/** A rule line or blank line left dangling after a section is cut. */
function trimSeparators(text: string): string {
  return text
    .replace(/(?:\n[ \t]*(?:-{3,}|\*{3,}|_{3,})?[ \t]*)+$/g, "")
    .replace(/^(?:[ \t]*(?:-{3,}|\*{3,}|_{3,})?[ \t]*\n)+/g, "")
    .trim();
}

export function splitPrBodyBotSections(body: string | null | undefined): { body: string; sections: PrBodyBotSection[] } {
  let rest = body ?? "";
  const sections: PrBodyBotSection[] = [];
  for (const marker of MARKERS) {
    const start = marker.start.exec(rest);
    if (!start) continue;
    const afterStart = rest.slice(start.index + start[0].length);
    const end = marker.end.exec(afterStart);
    // An unterminated block runs to the end of the body, like GitHub renders it.
    const inner = end ? afterStart.slice(0, end.index) : afterStart;
    const tail = end ? afterStart.slice(end.index + end[0].length) : "";
    const content = inner.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (content) sections.push({ id: marker.id, login: marker.login, body: content });
    rest = `${rest.slice(0, start.index)}\n${tail}`;
  }
  return { body: trimSeparators(rest), sections };
}
