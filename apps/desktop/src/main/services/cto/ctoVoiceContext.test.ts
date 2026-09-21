import { describe, expect, it } from "vitest";

import { CTO_VOICE_CONTEXT_MAX_CHARS } from "../../../shared/types/ctoVoicePrompt";
import {
  buildCtoVoiceContext,
  describeVoiceActiveWork,
  readVoiceTodayLog,
  splitSpokenSceneAnswer,
  voiceRequestAsksForVisual,
} from "./ctoVoiceContext";

/**
 * What a voice call knows, and how a turn's answer is split for the ear.
 *
 * All pure. The two things worth proving about the context block are the ORDER
 * of its sections and the BOUND on the whole of it — it is re-sent after every
 * completed `ask_cto`, so an unbounded one is paid for again on every refresh —
 * and the two worth proving about an answer are which half is spoken and which
 * half is drawn.
 */

/**
 * The context block is what makes "who are you" a real-time answer rather than
 * a five-second round trip through the CTO thread. Two things about it are
 * load bearing, and both are here: the ORDER of the sections, and the BOUND on
 * the whole thing — it is re-sent after every completed `ask_cto`, so an
 * unbounded block is paid for again on every refresh.
 */
describe("buildCtoVoiceContext", () => {
  const base = {
    ctoName: "Ada",
    persona: "Persistent project CTO for this ADE workspace.",
    projectName: "ADE",
    projectRoot: "/Users/me/Projects/ADE",
    modelName: "anthropic/claude-opus-5",
    laneNames: ["primary", "ade/sync-fix"],
    lanesTotal: 2,
    memorySections: [
      { title: "Durable memory (MEMORY.md)", body: "- The owner hates filler phrases." },
      { title: "Thread state", body: "Mid-way through the voice lane." },
      { title: "Recent daily log", body: "- 2026-09-16: rewired the call." },
    ],
  };

  it("leads with who the CTO is, then the project, then what it remembers", () => {
    const block = buildCtoVoiceContext(base);
    const order = [
      "Who you are",
      "This project",
      "Durable memory (MEMORY.md)",
      "Thread state",
      "Recent daily log",
    ].map((title) => block.indexOf(title));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(block).toContain("- Name: Ada");
    expect(block).toContain("- Root: /Users/me/Projects/ADE");
    expect(block).toContain("- Lanes (2): primary, ade/sync-fix");
    expect(block).toContain("- You think on: anthropic/claude-opus-5");
  });

  it("says a model has not been picked rather than inventing one", () => {
    expect(buildCtoVoiceContext({ ...base, modelName: null }))
      .toContain("a model the user has not picked yet");
  });

  it("names an empty project honestly", () => {
    const block = buildCtoVoiceContext({ ...base, laneNames: [], lanesTotal: 0, memorySections: [] });
    expect(block).toContain("- Lanes: none yet");
    expect(block).not.toContain("Durable memory");
  });

  it("trims the longest section first, and keeps the identity whole", () => {
    const block = buildCtoVoiceContext({
      ...base,
      memorySections: [
        { title: "Durable memory (MEMORY.md)", body: "m".repeat(9_000) },
        { title: "Thread state", body: "Mid-way through the voice lane." },
      ],
    });
    expect(block.length).toBeLessThanOrEqual(CTO_VOICE_CONTEXT_MAX_CHARS);
    // The identity and the project are short and must survive whole: a model
    // that has forgotten its own name is worse than one with less memory.
    expect(block).toContain("- Name: Ada");
    expect(block).toContain("- Root: /Users/me/Projects/ADE");
    expect(block).toContain("Mid-way through the voice lane.");
    expect(block).toContain("…(trimmed)");
  });

  it("still fits when every section is long", () => {
    const block = buildCtoVoiceContext({
      ...base,
      memorySections: Array.from({ length: 12 }, (_, index) => ({
        title: `Section ${index}`,
        body: "x".repeat(4_000),
      })),
    });
    expect(block.length).toBeLessThanOrEqual(CTO_VOICE_CONTEXT_MAX_CHARS);
  });

  /**
   * Small talk was generic because the block had nothing about today in it.
   * "How's it going?" is a question about the last few hours, and an identity
   * plus a lane list cannot answer it.
   */
  it("carries what is in flight and what has happened today", () => {
    const block = buildCtoVoiceContext({
      ...base,
      activeWork: ["- Open PRs (1):", "  · #1234 sync host recovery — checks passing"],
      todayLog: ["- 14:20 — cancel the crons → done", "- 09:02 — start the voice lane → done"],
    });
    expect(block).toContain("What is happening right now");
    expect(block).toContain("#1234 sync host recovery");
    expect(block).toContain("Today so far (most recent first)");
    expect(block.indexOf("14:20")).toBeLessThan(block.indexOf("09:02"));
  });

  it("leaves the new sections out when there is nothing in them", () => {
    const block = buildCtoVoiceContext({ ...base, activeWork: [], todayLog: [] });
    expect(block).not.toContain("What is happening right now");
    expect(block).not.toContain("Today so far");
  });

  it("still trims to the cap with the work board and the log in it", () => {
    const block = buildCtoVoiceContext({
      ...base,
      activeWork: Array.from({ length: 200 }, (_, index) => `- row ${index} ${"w".repeat(60)}`),
      todayLog: Array.from({ length: 200 }, (_, index) => `- entry ${index} ${"t".repeat(60)}`),
    });
    expect(block.length).toBeLessThanOrEqual(CTO_VOICE_CONTEXT_MAX_CHARS);
    expect(block).toContain("- Name: Ada");
  });
});

describe("describeVoiceActiveWork", () => {
  const empty = {
    approvals: [], approvalsTotal: 0,
    chats: [], chatsTotal: 0,
    pullRequests: [], pullRequestsTotal: 0,
    scheduledWork: [], scheduledWorkTotal: 0,
  };

  it("names each kind of work with its total", () => {
    const lines = describeVoiceActiveWork({
      ...empty,
      approvals: [{ title: "Open a PR for ade/sync-fix" }],
      approvalsTotal: 1,
      chats: [{ title: "voice lane", status: "working" }],
      chatsTotal: 1,
      pullRequests: [{ number: 1234, title: "sync host recovery", checks: "passing" }],
      pullRequestsTotal: 1,
      scheduledWork: [{ title: "nightly audit", status: "scheduled" }],
      scheduledWorkTotal: 1,
    }).join("\n");
    expect(lines).toContain("Waiting for you (1)");
    expect(lines).toContain("Work in flight (1)");
    expect(lines).toContain("#1234 sync host recovery — checks passing");
    expect(lines).toContain("Scheduled (1)");
  });

  it("caps each kind and says how many it left out", () => {
    const lines = describeVoiceActiveWork({
      ...empty,
      chats: Array.from({ length: 9 }, (_, index) => ({ title: `chat ${index}`, status: "working" })),
      chatsTotal: 9,
    }).join("\n");
    expect(lines).toContain("Work in flight (9)");
    expect(lines).toContain("…and 5 more running");
    expect(lines).not.toContain("chat 4");
  });

  /**
   * An absent section reads to the model as an unknown it has to go and ask
   * about. "Nothing is running" is an answer it can give in its own voice.
   */
  it("says so out loud when nothing is running", () => {
    expect(describeVoiceActiveWork(empty)).toEqual([
      "- Nothing is running, waiting or open right now.",
    ]);
  });
});

describe("readVoiceTodayLog", () => {
  it("drops the date header and puts the newest entry first", () => {
    expect(readVoiceTodayLog({
      dailyLog: "# 2026-09-16\n\n09:02 — started the lane → done\n14:20 — cancelled the crons → done\n",
    })).toEqual([
      "- 14:20 — cancelled the crons → done",
      "- 09:02 — started the lane → done",
    ]);
  });

  it("bounds the number of entries it carries", () => {
    const body = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    expect(readVoiceTodayLog({ dailyLog: body })).toHaveLength(12);
  });

  it("is empty for a day with nothing in it", () => {
    expect(readVoiceTodayLog({ dailyLog: "# 2026-09-16\n" })).toEqual([]);
    expect(readVoiceTodayLog(null)).toEqual([]);
  });
});

/**
 * "Show me a visual of the PRs merged yesterday" came back as an offer to
 * DESCRIBE them. The CTO could always draw; nothing told it that "show me"
 * meant draw.
 */
describe("voiceRequestAsksForVisual", () => {
  it("recognises the ways a user asks to see something", () => {
    for (const request of [
      "show me a visual of the PRs merged yesterday",
      "Draw the lane graph",
      "can you chart the test failures",
      "a quick diagram of how sync works",
      "plot the last week",
    ]) {
      expect(voiceRequestAsksForVisual(request)).toBe(true);
    }
  });

  it("leaves an ordinary request alone", () => {
    for (const request of ["how many lanes do we have", "run the tests", "what merged yesterday"]) {
      expect(voiceRequestAsksForVisual(request)).toBe(false);
    }
  });
});

describe("splitSpokenSceneAnswer", () => {
  it("lifts the one scene fence out of what gets spoken", () => {
    // The HUD renders `sceneSource` in the same sandbox the transcript uses. If
    // the fence stayed in the spoken half the voice model would read HTML aloud.
    const result = splitSpokenSceneAnswer([
      "Three lanes are ahead of main.",
      "",
      "```scene",
      "<div>chart</div>",
      "```",
    ].join("\n"));

    expect(result.spoken).toBe("Three lanes are ahead of main.");
    expect(result.sceneSource).toContain("<div>chart</div>");
  });

  it("says something when the answer was only a picture", () => {
    // A `response.create` whose instructions are empty produces no audio at all,
    // and the HUD then sits in `speaking` with nothing to hear and no way out.
    const result = splitSpokenSceneAnswer("\`\`\`scene\n<div>chart</div>\n\`\`\`");
    expect(result.sceneSource).toContain("<div>chart</div>");
    expect(result.spoken).toBe("Here is what I drew.");
  });

  it("strips a second scene fence instead of reading it aloud", () => {
    const result = splitSpokenSceneAnswer([
      "One.",
      "\`\`\`scene",
      "<p>first</p>",
      "\`\`\`",
      "Two.",
      "\`\`\`scene",
      "<p>second</p>",
      "\`\`\`",
    ].join("\n"));
    expect(result.sceneSource).toContain("first");
    expect(result.spoken).not.toContain("scene");
    expect(result.spoken).not.toContain("second");
    expect(result.spoken).toBe("One.\nTwo.");
  });

  it("leaves an answer with no fence exactly as it was", () => {
    expect(splitSpokenSceneAnswer("  Three merged yesterday.  "))
      .toEqual({ spoken: "Three merged yesterday." });
  });

  it("keeps a malformed fence in the prose rather than dropping it silently", () => {
    // An empty fence is not a scene. Speaking something odd beats a picture
    // that never appears and text that never mentions it.
    const text = "Here you go.\n\n```scene\n\n```";
    const result = splitSpokenSceneAnswer(text);
    expect(result.sceneSource).toBeUndefined();
    expect(result.spoken).toContain("```scene");
  });

  it("takes only the first fence, because the prompt allows exactly one", () => {
    const result = splitSpokenSceneAnswer([
      "One.",
      "```scene",
      "<p>first</p>",
      "```",
      "```scene",
      "<p>second</p>",
      "```",
    ].join("\n"));
    expect(result.sceneSource).toContain("first");
    expect(result.sceneSource).not.toContain("second");
  });
});
