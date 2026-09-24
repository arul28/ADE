import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import {
  applyChatTranscriptTurnFolds,
  collapseChatTranscriptEvents,
  collapseChatTranscriptEventsWithContext,
  deriveChatTranscriptTurnFolds,
  groupChatTranscriptRows,
  mergeAdjacentActivityBundleRows,
  readTurnEndSnapshots,
  type ChatTranscriptGroupedEnvelope,
} from "./chatTranscriptRows";
import {
  backgroundJobGroupKeyByMemberKey,
  collectTurnEndLiveRowKeys,
  countBackgroundJobs,
  groupBackgroundJobRuns,
} from "./chatBackgroundJobRuns";

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 23, 12, 0, clock++)).toISOString();
const ev = (event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
  sessionId: "session-1",
  timestamp: at(),
  event,
});

type JobStatus = "running" | "completed" | "failed" | "stopped";
const job = (id: string, title: string, status: JobStatus, turnId = "t1") => ev({
  type: "scheduled_work_update",
  id: `background:${id}`,
  kind: "background_task",
  status,
  title,
  sourceTaskId: id,
  turnId,
});
const tool = (id: string, turnId = "t1") => ev({
  type: "command",
  command: `run ${id}`,
  cwd: "/repo",
  output: "",
  itemId: id,
  turnId,
  status: "completed",
});

/** The message list's pipeline: group, drop undrawn rows, group jobs, fold. */
function present(events: AgentChatEventEnvelope[], open: ReadonlySet<string> = new Set()) {
  const { rows, context } = collapseChatTranscriptEventsWithContext(events);
  const snapshots = readTurnEndSnapshots(context);
  const presented = groupBackgroundJobRuns(
    mergeAdjacentActivityBundleRows(
      groupChatTranscriptRows(rows).filter((row) => row.event.type !== "work_log_group"),
    ),
    collectTurnEndLiveRowKeys(snapshots),
  );
  const folds = deriveChatTranscriptTurnFolds(presented, snapshots);
  const display = applyChatTranscriptTurnFolds(presented, folds, open);
  return { presented, folds, display };
}

const types = (rows: readonly ChatTranscriptGroupedEnvelope[]) => rows.map((row) => row.event.type);

function groupOf(rows: readonly ChatTranscriptGroupedEnvelope[]) {
  const row = rows.find((candidate) => candidate.event.type === "background_job_group");
  if (!row || row.event.type !== "background_job_group") throw new Error("Expected a background job group");
  return { row, event: row.event };
}

describe("groupBackgroundJobRuns", () => {
  it("draws five consecutive jobs of any label and status as one row keyed by the first", () => {
    // The owner's screenshot: five different jobs, one failed, five centered
    // rules with big gaps. Tool calls between them are not drawn rows.
    const { presented } = present([
      ev({ type: "user_message", text: "look for kimi", turnId: "t1" }),
      tool("c1"), job("a", "Search kimi binary for session file patterns", "completed"),
      tool("c2"), job("b", "Find kimi session dir helpers and meta file names", "failed"),
      tool("c3"), job("c", "Find kimi session dir helpers and meta files", "completed"),
      tool("c4"), job("d", "Print kimi session dir helper bodies", "running"),
      tool("c5"), job("e", "Print kimi session meta and index helpers", "completed"),
    ]);
    expect(types(presented)).toEqual(["user_message", "background_job_group"]);
    const { row, event } = groupOf(presented);
    expect(row.key).toBe("background-chip:a");
    expect(event.memberKeys).toEqual(["a", "b", "c", "d", "e"].map((id) => `background-chip:${id}`));
    expect(countBackgroundJobs(event.members.map((member) => member.event))).toEqual({
      total: 5, running: 1, done: 3, failed: 1, stopped: 0,
    });
  });

  it("keeps a lone job as its own row, under the key the group later takes", () => {
    const lone = present([ev({ type: "user_message", text: "go", turnId: "t1" }), job("a", "npm install", "running")]);
    expect(types(lone.presented)).toEqual(["user_message", "background_job_line"]);
    expect(lone.presented[1]!.key).toBe("background-chip:a");

    const joined = present([
      ev({ type: "user_message", text: "go", turnId: "t1" }),
      job("a", "npm install", "running"),
      job("b", "npm test", "running"),
    ]);
    // Same row key, so the virtualizer's measured height and the mount survive.
    expect(groupOf(joined.presented).row.key).toBe("background-chip:a");
  });

  it("splits a run only at a drawn row; an invisible spawn notice moves ahead", () => {
    const lineA = collapseChatTranscriptEvents([job("a", "one", "completed")])[0]!;
    const lineB = collapseChatTranscriptEvents([job("b", "two", "completed")])[0]!;
    const notice: ChatTranscriptGroupedEnvelope = {
      key: "notice",
      timestamp: lineA.timestamp,
      event: { type: "system_notice", noticeKind: "info", message: "spawned", status: "subagent_spawned", detail: { hasInlineCard: true } },
    };
    const text: ChatTranscriptGroupedEnvelope = {
      key: "text",
      timestamp: lineA.timestamp,
      event: { type: "text", text: "Between." },
    };
    expect(types(groupBackgroundJobRuns([lineA, notice, lineB]))).toEqual(["system_notice", "background_job_group"]);
    const split = [lineA, text, lineB];
    // Nothing grouped: the input array itself comes back.
    expect(groupBackgroundJobRuns(split)).toBe(split);
  });

  it("maps every member key to the row that draws it", () => {
    const { presented } = present([
      ev({ type: "user_message", text: "go", turnId: "t1" }),
      job("a", "one", "running"),
      job("b", "two", "running"),
    ]);
    expect([...backgroundJobGroupKeyByMemberKey(presented)]).toEqual([
      ["background-chip:a", "background-chip:a"],
      ["background-chip:b", "background-chip:a"],
    ]);
  });
});

describe("background jobs in the turn fold", () => {
  const turn = (jobs: AgentChatEventEnvelope[]) => [
    ev({ type: "user_message", text: "build it", turnId: "t1" }),
    ev({ type: "reasoning", text: "Starting jobs.", turnId: "t1" }),
    ...jobs,
    ev({ type: "text", text: "Done; the dev server keeps running.", turnId: "t1", itemId: "answer" }),
    ev({ type: "done", turnId: "t1", status: "completed" }),
  ];

  it("folds jobs that finished before the turn ended and keeps the running one visible, stickily", () => {
    const events = turn([
      job("a", "npm run build", "running"),
      job("a", "npm run build", "completed"),
      job("b", "npm test", "running"),
      job("b", "npm test", "failed"),
      job("c", "npm run dev", "running"),
    ]);
    const { display, presented, folds } = present(events);
    // Finished jobs (a, b) share a group; the job live at turn end (c) is split off.
    expect(types(presented)).toEqual([
      "user_message", "reasoning", "background_job_group", "background_job_line", "text", "done",
    ]);
    expect(types(display)).toEqual(["user_message", "turn_fold", "background_job_line", "text", "done"]);
    expect(display[2]!.key).toBe("background-chip:c");
    expect(folds[0]!.hiddenKeys.has("background-chip:a")).toBe(true);
    const foldRow = display[1]!.event;
    expect(foldRow).toMatchObject({ type: "turn_fold", jobCount: 3, failedJobCount: 1 });

    // The live job settling later does not move it into the fold.
    const settled = present([...events, job("c", "npm run dev", "completed")]);
    expect(types(settled.display)).toEqual(["user_message", "turn_fold", "background_job_line", "text", "done"]);
    expect(settled.display[2]!.key).toBe("background-chip:c");
  });

  it("keeps a live turn's jobs in one row and folds all of them when they finished in time", () => {
    const live = present([
      ev({ type: "user_message", text: "build it", turnId: "t1" }),
      job("a", "npm run build", "completed"),
      job("b", "npm run dev", "running"),
    ]);
    expect(types(live.presented)).toEqual(["user_message", "background_job_group"]);

    const finished = present(turn([job("a", "npm run build", "completed"), job("b", "npm test", "completed")]));
    expect(types(finished.display)).toEqual(["user_message", "turn_fold", "text", "done"]);
    expect(finished.display[1]!.event).toMatchObject({ jobCount: 2, failedJobCount: 0 });
    // Open: one compact group row inside the fold.
    const open = present(turn([job("a", "npm run build", "completed"), job("b", "npm test", "completed")]), new Set(["turn-fold:t1"]));
    expect(types(open.display)).toEqual(["user_message", "turn_fold", "reasoning", "background_job_group", "text", "done"]);
  });
});

describe("repeated answer in the open fold", () => {
  // Transcript 85fa4037 (Cursor, Grok 4.7): the model answered, set a chat
  // note, thought, then generated the same answer again token by token.
  const answer = "I'm Grok 4.7, a language model trained by SpaceXAI.";
  const events = () => [
    ev({ type: "user_message", text: "what model are you?", turnId: "t1" }),
    ev({ type: "reasoning", text: "The user is asking what model I am.", turnId: "t1" }),
    ev({ type: "text", text: answer, messageId: "91f596d8", turnId: "t1" }),
    ev({ type: "command", command: "ade chat note", cwd: "/r", output: "", itemId: "c1", turnId: "t1", status: "completed" }),
    ev({ type: "reasoning", text: "The note was set. The question was already answered.", turnId: "t1" }),
    ev({ type: "text", text: `${answer}\n`, messageId: "ec70564a", turnId: "t1" }),
    ev({ type: "done", turnId: "t1", status: "completed" }),
  ];

  it("hides the earlier identical text in the open fold, and nothing else", () => {
    const closed = present(events());
    expect(types(closed.display)).toEqual(["user_message", "turn_fold", "text", "done"]);
    const firstText = closed.presented.find((row) => row.event.type === "text")!;
    expect(closed.folds[0]!.duplicateAnswerKeys).toEqual(new Set([firstText.key]));

    const open = present(events(), new Set(["turn-fold:t1"]));
    expect(types(open.display)).toEqual(["user_message", "turn_fold", "reasoning", "reasoning", "text", "done"]);
    expect(open.display.some((row) => row.key === firstText.key)).toBe(false);
    // Canonical rows keep both copies.
    expect(open.presented.filter((row) => row.event.type === "text")).toHaveLength(2);
  });

  it("keeps an earlier text that only resembles the answer", () => {
    const similar = events().map((envelope) => (
      envelope.event.type === "text" && envelope.event.messageId === "91f596d8"
        ? { ...envelope, event: { ...envelope.event, text: `${answer} Ask me anything.` } }
        : envelope
    ));
    const open = present(similar, new Set(["turn-fold:t1"]));
    expect(open.folds[0]!.duplicateAnswerKeys.size).toBe(0);
    expect(open.display.filter((row) => row.event.type === "text")).toHaveLength(2);
  });
});
