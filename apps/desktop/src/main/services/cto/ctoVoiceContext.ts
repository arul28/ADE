import { extractSceneFence, SCENE_FENCE_LANGUAGE } from "../../../shared/chatScene";
import { CTO_VOICE_CONTEXT_MAX_CHARS } from "../../../shared/types/ctoVoicePrompt";

/**
 * What a voice call knows, and how a turn's answer is split for the ear.
 *
 * All pure, and out of the runtime service for exactly that reason: the ORDER
 * of the context block's sections, the BOUND on the whole of it, and the rule
 * for what is spoken versus what is drawn are the parts worth testing, and none
 * of them needs a project on disk, a chat service or a socket.
 */

/**
 * What a call says when it drew something and said nothing.
 *
 * A scene-only answer leaves the prose empty, and `session.commentary.append`
 * with an empty string never produces audio — the HUD sits in `speaking` with
 * nothing to hear and no way out. One sentence keeps the phase moving and tells
 * the user to look.
 */
const CTO_VOICE_SCENE_ONLY_SPOKEN = "Here is what I drew.";

/**
 * Split a turn's answer into what is spoken and what is drawn.
 *
 * The scan itself lives in `chatScene` beside `hasOpenSceneFence`, so the
 * streaming guard and the splitter cannot disagree about what a fence is.
 */
export function splitSpokenSceneAnswer(outputText: string): {
  spoken: string;
  sceneSource?: string;
} {
  const split = extractSceneFence(outputText);
  if (!split.sceneSource) return split;
  return {
    spoken: split.spoken.length ? split.spoken : CTO_VOICE_SCENE_ONLY_SPOKEN,
    sceneSource: split.sceneSource,
  };
}

/**
 * Did the user ask to SEE this, rather than to hear it?
 *
 * Deliberately a word list rather than a judgement: the request text is the
 * realtime model's paraphrase of what was said, and it is the one place "show
 * me the PRs merged yesterday" survives intact. A false positive costs one
 * unread fence; a false negative costs the user the picture they asked for,
 * which is the failure this exists to stop.
 */
const CTO_VOICE_VISUAL_WORDS = [
  "show me",
  "show us",
  "draw",
  "chart",
  "graph",
  "diagram",
  "visual",
  "visualise",
  "visualize",
  "picture",
  "timeline",
  "sketch",
  "plot",
  "illustrate",
] as const;

export function voiceRequestAsksForVisual(request: string): boolean {
  const text = request.toLowerCase();
  return CTO_VOICE_VISUAL_WORDS.some((word) => text.includes(word));
}

/**
 * What a scene IS, said to a CTO that has never read the skill.
 *
 * "End your sentences with a ```scene fence" was the whole instruction, and a
 * CTO obeyed it exactly: it drew a box out of box-drawing characters and put
 * the plain text inside the fence. The frame
 * renders HTML, so the user got a picture of a monospace rectangle rendered as
 * a paragraph. Nothing had told it the fence was markup.
 *
 * This is the `ade-scene` skill distilled to what a one-shot voice turn can act
 * on: the shape of the block, the variables that make it look like ADE, the
 * things the sandbox does not have, and the layout rules that make the result
 * readable at a glance. The skill itself stays the long form — a turn on a call
 * cannot be asked to go and read it.
 *
 * The layout half is here because of the call of 2026-09-17: the CTO drew real
 * HTML, which was the fix that had just landed, and what it drew was four stat
 * cards, a ten-row lane table with wrapping names, and a second table of prose
 * cells. The frame clipped partway down the first table, so the user got half a
 * view of something that was never going to fit. Nothing had told the CTO how
 * big the frame is, that it does not scroll, or that a scene is one idea rather
 * than everything it happens to know.
 */
export function buildVoiceSceneContract(): string {
  return [
    `The \`\`\`${SCENE_FENCE_LANGUAGE} fence is real HTML, CSS and JavaScript — ADE renders it in a sandboxed frame. It is NEVER plain text, a code listing, ASCII art or box-drawing characters; text inside the fence renders as an unstyled paragraph.`,
    `First line of the fence: <!-- @scene title="..." -->. Then your markup.`,
    "Style it with ADE's own CSS variables, already set on :root: --bg, --surface, --border, --fg, --fg-muted, --accent, --success, --warning, --danger, --font-sans, --font-mono.",
    "The frame has no network, no libraries, no remote fonts and no remote images: every value you are showing must be written into the markup, and any image must be a data: URL. Call ade.ready() when it is drawn.",
    "SIZE: the frame is about 560px wide and about 520px tall. It does NOT scroll, and anything past the bottom edge is simply cut off and lost. Everything must fit inside that with room to spare.",
    "ONE IDEA: pick the single most useful view for the question that was asked, not everything you know about it. At most one row of up to 4 stat tiles, and at most ONE table or list of at most 6 rows. If there are more rows than that, show the 5 that matter and make the last row a muted '+N more'.",
    "Short labels, and never a sentence or a paragraph inside a cell. Any cell holding a name carries a max-width plus white-space: nowrap; overflow: hidden; text-overflow: ellipsis, so one long name cannot push the table out of the frame.",
    "Colour only what needs attention — dirty, behind, failing, waiting — with --warning or --danger, and leave everything healthy in --fg-muted. A view where everything is coloured says nothing.",
    "Text in --font-sans; --font-mono only for numbers and ids. The title is a small uppercase label in --fg-muted, not a heading. Finish with one muted footer line carrying the timestamp.",
    "It must be readable when it stops moving — a scene that only makes sense mid-animation means nothing afterwards. Never draw approve, confirm or deny controls; ADE owns permission. Keep the whole fence under about 8 KB.",
    "A scene looks like this:",
    `\`\`\`${SCENE_FENCE_LANGUAGE}`,
    '<!-- @scene title="Lanes" -->',
    "<style>",
    "  body { margin: 0; font: 13px/1.4 var(--font-sans); color: var(--fg); }",
    "  .label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-muted); }",
    "  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 0 14px; }",
    "  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }",
    "  .tile b { display: block; font: 600 22px var(--font-mono); }",
    "  table { width: 100%; border-collapse: collapse; }",
    "  th { text-align: left; font-weight: 500; color: var(--fg-muted); padding: 4px 8px; }",
    "  td { padding: 6px 8px; border-top: 1px solid var(--border); }",
    "  .name { max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    "  .n { font-family: var(--font-mono); text-align: right; }",
    "  .warn { color: var(--warning); }",
    "  .calm, .more, .foot { color: var(--fg-muted); }",
    "  .more, .foot { font-size: 11px; }",
    "  .foot { margin-top: 10px; }",
    "</style>",
    '<div class="label">Lanes</div>',
    '<div class="tiles">',
    '  <div class="tile"><b>10</b><span class="label">open</span></div>',
    '  <div class="tile"><b>2</b><span class="label">dirty</span></div>',
    '  <div class="tile"><b>3</b><span class="label">behind</span></div>',
    "</div>",
    '<table><thead><tr><th>Lane</th><th>State</th><th class="n">Ahead</th></tr></thead><tbody>',
    '  <tr><td class="name">cto-live-voice</td><td class="warn">dirty</td><td class="n">7</td></tr>',
    '  <tr><td class="name">mac-desktop</td><td class="warn">behind 4</td><td class="n">2</td></tr>',
    '  <tr><td class="name">browser-improve</td><td class="calm">clean</td><td class="n">1</td></tr>',
    '  <tr><td class="name">plugin-platform</td><td class="calm">clean</td><td class="n">0</td></tr>',
    '  <tr><td class="name">sdk-versic</td><td class="calm">clean</td><td class="n">0</td></tr>',
    '  <tr><td class="more" colspan="3">+5 more</td></tr>',
    "</tbody></table>",
    '<div class="foot">17 Sep 2026, 07:10</div>',
    "<script>ade.ready();</script>",
    "```",
  ].join("\n");
}

/** How many rows of any one kind the work board contributes. */
const CTO_VOICE_ACTIVE_WORK_MAX_PER_KIND = 4;
/** How many of today's log entries the block carries. */
const CTO_VOICE_TODAY_LOG_MAX_ENTRIES = 12;

/**
 * The CTO's live-state snapshot, as lines a voice can read off.
 *
 * Not `renderCtoLiveStateBlock`: that block is built for a thinking model with
 * a 6,000-character budget of its own and spells out lane ids, session ids and
 * check states. What a call needs is the shape of the day in a dozen lines, and
 * the ids are things the CTO looks up rather than things a voice says out loud.
 */
export function describeVoiceActiveWork(snapshot: {
  approvals: Array<{ title: string }>;
  approvalsTotal: number;
  chats: Array<{ title: string; status: string }>;
  chatsTotal: number;
  pullRequests: Array<{ number: number; title: string; checks: string }>;
  pullRequestsTotal: number;
  scheduledWork: Array<{ title: string; status: string }>;
  scheduledWorkTotal: number;
}): string[] {
  const lines: string[] = [];
  const take = <T>(rows: T[]): T[] => rows.slice(0, CTO_VOICE_ACTIVE_WORK_MAX_PER_KIND);
  const more = (shown: number, total: number, noun: string): void => {
    if (total > shown) lines.push(`  …and ${total - shown} more ${noun}`);
  };
  if (snapshot.approvalsTotal > 0) {
    const rows = take(snapshot.approvals);
    lines.push(`- Waiting for you (${snapshot.approvalsTotal}):`);
    for (const row of rows) lines.push(`  · ${row.title}`);
    more(rows.length, snapshot.approvalsTotal, "waiting");
  }
  if (snapshot.chatsTotal > 0) {
    const rows = take(snapshot.chats);
    lines.push(`- Work in flight (${snapshot.chatsTotal}):`);
    for (const row of rows) lines.push(`  · ${row.title} — ${row.status}`);
    more(rows.length, snapshot.chatsTotal, "running");
  }
  if (snapshot.pullRequestsTotal > 0) {
    const rows = take(snapshot.pullRequests);
    lines.push(`- Open PRs (${snapshot.pullRequestsTotal}):`);
    for (const row of rows) {
      lines.push(`  · #${row.number} ${row.title} — checks ${row.checks}`);
    }
    more(rows.length, snapshot.pullRequestsTotal, "PRs");
  }
  if (snapshot.scheduledWorkTotal > 0) {
    const rows = take(snapshot.scheduledWork);
    lines.push(`- Scheduled (${snapshot.scheduledWorkTotal}):`);
    for (const row of rows) lines.push(`  · ${row.title} — ${row.status}`);
    more(rows.length, snapshot.scheduledWorkTotal, "scheduled");
  }
  // Said rather than left blank: "nothing is running" is an answer, and an
  // absent section reads to the model as an unknown it has to go and ask about.
  if (!lines.length) lines.push("- Nothing is running, waiting or open right now.");
  return lines;
}

/**
 * Today's daily-log entries, newest first.
 *
 * The file's own `# YYYY-MM-DD` header is dropped — the section says "today" —
 * and the order is reversed because a call asks "what have we done today" and
 * the useful end of that list is the recent one.
 */
export function readVoiceTodayLog(
  snapshot: { dailyLog?: string | null } | null,
  maxEntries = CTO_VOICE_TODAY_LOG_MAX_ENTRIES,
): string[] {
  const body = (snapshot?.dailyLog ?? "").trim();
  if (!body.length) return [];
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .reverse()
    .slice(0, Math.max(1, maxEntries))
    .map((line) => `- ${line}`);
}

/**
 * Everything the realtime model may answer from without asking the CTO.
 *
 * Pure, and built from plain data rather than from the services, so the two
 * things that actually matter about it — the ORDER of the sections and the
 * BOUND on the whole block — can be tested without a project on disk.
 *
 * The order is most- to least-identifying: who you are, then what project this
 * is, then what you remember, then what is happening today. That is also the
 * order they would be missed in, which matters because the trim below eats the
 * long sections first.
 *
 * The bound is not decoration. This block is re-sent after every completed
 * `ask_cto`, so an unbounded one is paid for again on every refresh — and a
 * durable memory file grows without limit.
 */
type CtoVoiceContextInput = {
  ctoName: string;
  persona: string;
  projectName: string;
  projectRoot: string;
  /** `provider/model` the CTO thread is running on, or null before the pick. */
  modelName: string | null;
  laneNames: string[];
  lanesTotal: number;
  /**
   * What is in flight right now, one line each, from the CTO's live-state
   * snapshot: chats working, PRs open, approvals waiting, work scheduled.
   *
   * The reason small talk was generic. "How's it going?" is a question about
   * today, and a model whose whole context was an identity and a lane list had
   * nothing to answer it with but a pleasantry.
   */
  activeWork?: string[];
  /**
   * Today's daily-log entries, most recent first.
   *
   * The memory service's own "Recent daily log" section spans two days and is
   * oldest-first so a truncation keeps the tail. Today, newest first, is a
   * different question — "what have we done today" — and is worth the
   * duplication because it is the one the user actually asks out loud.
   */
  todayLog?: string[];
  /** Durable memory, thread state and the daily log, as the memory service labels them. */
  memorySections: Array<{ title: string; body: string }>;
};

/** A section trimmed to the floor still has to say that it was trimmed. */
const CTO_VOICE_CONTEXT_TRIM_MARKER = "\n…(trimmed)";

/**
 * The smallest a section is allowed to be trimmed to.
 *
 * Below this a section is noise rather than context — half a sentence of
 * durable memory tells the model less than no memory at all, because it reads
 * as a complete fact.
 */
const CTO_VOICE_CONTEXT_MIN_SECTION_CHARS = 200;

export function buildCtoVoiceContext(
  input: CtoVoiceContextInput,
  maxChars = CTO_VOICE_CONTEXT_MAX_CHARS,
): string {
  const laneLine = input.lanesTotal === 0
    ? "- Lanes: none yet"
    : `- Lanes (${input.lanesTotal}): ${input.laneNames.join(", ")}`;
  const sections: Array<{ title: string; body: string }> = [
    {
      title: "Who you are",
      body: [
        `- Name: ${input.ctoName}`,
        `- Role: CTO of ${input.projectName}`,
        `- Persona: ${input.persona}`,
        `- You think on: ${input.modelName ?? "a model the user has not picked yet"}`,
      ].join("\n"),
    },
    {
      title: "This project",
      body: [
        `- Name: ${input.projectName}`,
        `- Root: ${input.projectRoot}`,
        laneLine,
      ].join("\n"),
    },
    ...(input.activeWork?.length
      ? [{ title: "What is happening right now", body: input.activeWork.join("\n") }]
      : []),
    ...(input.todayLog?.length
      ? [{ title: "Today so far (most recent first)", body: input.todayLog.join("\n") }]
      : []),
    ...input.memorySections
      .map((section) => ({ title: section.title, body: section.body.trim() }))
      .filter((section) => section.body.length > 0),
  ];

  const render = (): string =>
    sections.map((section) => `${section.title}\n${section.body}`).join("\n\n");

  // Longest first, and only down to the floor. Trimming evenly would take the
  // identity apart to save a journal entry; trimming the longest is what makes
  // a busy project lose the tail of its memory rather than its own name.
  const atFloor = new Set<number>();
  let rendered = render();
  while (rendered.length > maxChars) {
    let target = -1;
    for (let index = 0; index < sections.length; index += 1) {
      if (atFloor.has(index)) continue;
      if (sections[index]!.body.length <= CTO_VOICE_CONTEXT_MIN_SECTION_CHARS) {
        atFloor.add(index);
        continue;
      }
      if (target < 0 || sections[index]!.body.length > sections[target]!.body.length) target = index;
    }
    if (target < 0) break;
    const body = sections[target]!.body;
    const over = rendered.length - maxChars;
    const keep = Math.max(
      CTO_VOICE_CONTEXT_MIN_SECTION_CHARS,
      body.length - over - CTO_VOICE_CONTEXT_TRIM_MARKER.length,
    );
    sections[target] = {
      ...sections[target]!,
      body: `${body.slice(0, keep).trimEnd()}${CTO_VOICE_CONTEXT_TRIM_MARKER}`,
    };
    rendered = render();
  }
  // Everything is at the floor and it still does not fit: a project with dozens
  // of sections. Cut on a line rather than mid-word.
  if (rendered.length > maxChars) {
    const kept: string[] = [];
    let used = 0;
    for (const line of rendered.split("\n")) {
      if (used + line.length + 1 > maxChars) break;
      kept.push(line);
      used += line.length + 1;
    }
    return kept.join("\n");
  }
  return rendered;
}
