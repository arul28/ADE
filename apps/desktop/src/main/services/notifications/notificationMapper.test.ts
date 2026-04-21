import { describe, expect, it } from "vitest";
import {
  buildApnsPayload,
  isAllowedByPrefs,
  mapChatEvent,
  mapMissionEvent,
  mapPrEvent,
  mapSystemEvent,
  type MappedNotification,
} from "./notificationMapper";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../../../shared/types/sync";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { PrSummary } from "../../../shared/types/prs";

function chatEnvelope(event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope {
  return {
    sessionId: "session-123",
    timestamp: "2026-04-20T10:00:00.000Z",
    event,
  };
}

const samplePr: PrSummary = {
  id: "pr-1",
  laneId: "lane-1",
  projectId: "proj-1",
  repoOwner: "arul28",
  repoName: "ADE",
  githubPrNumber: 412,
  githubUrl: "https://github.com/arul28/ADE/pull/412",
  githubNodeId: "MDExOlB1bGxSZXF1ZXN0",
  title: "Refactor auth",
  state: "open",
  baseBranch: "main",
  headBranch: "feat/auth",
  checksStatus: "failing",
  reviewStatus: "requested",
  additions: 100,
  deletions: 20,
  lastSyncedAt: "2026-04-20T09:55:00.000Z",
  createdAt: "2026-04-20T09:00:00.000Z",
  updatedAt: "2026-04-20T09:55:00.000Z",
};

describe("mapChatEvent", () => {
  it("maps approval_request to time-sensitive awaiting-input push", () => {
    const [mapped] = mapChatEvent(
      chatEnvelope({
        type: "approval_request",
        itemId: "item-1",
        kind: "command",
        description: "Run `rm -rf /tmp/foo`",
      }),
    );
    expect(mapped.category).toBe("CHAT_AWAITING_INPUT");
    expect(mapped.interruptionLevel).toBe("time-sensitive");
    expect(mapped.priority).toBe(10);
    expect(mapped.deepLink).toBe("ade://session/session-123");
    expect(mapped.collapseId).toContain("session-123");
  });

  it("maps done:failed to CHAT_FAILED", () => {
    const [mapped] = mapChatEvent(
      chatEnvelope({ type: "done", turnId: "turn-1", status: "failed" }),
    );
    expect(mapped.category).toBe("CHAT_FAILED");
    expect(mapped.priority).toBe(10);
  });

  it("maps done:completed to low-priority passive", () => {
    const [mapped] = mapChatEvent(
      chatEnvelope({ type: "done", turnId: "turn-1", status: "completed" }),
    );
    expect(mapped.category).toBe("CHAT_COMPLETED");
    expect(mapped.priority).toBe(5);
    expect(mapped.interruptionLevel).toBe("passive");
  });

  it("maps system_notice provider_health → SYSTEM_PROVIDER_OUTAGE", () => {
    const [mapped] = mapChatEvent(
      chatEnvelope({ type: "system_notice", noticeKind: "provider_health", message: "OpenAI is down" }),
    );
    expect(mapped.category).toBe("SYSTEM_PROVIDER_OUTAGE");
  });

  it("maps subagent_started to CTO family", () => {
    const [mapped] = mapChatEvent(
      chatEnvelope({ type: "subagent_started", taskId: "sub-1", description: "Planning" }),
    );
    expect(mapped.family).toBe("cto");
    expect(mapped.category).toBe("CTO_SUBAGENT_STARTED");
  });

  it("emits nothing for unrelated chat events", () => {
    const mapped = mapChatEvent(chatEnvelope({ type: "text", text: "hello" }));
    expect(mapped).toEqual([]);
  });

  it("truncates long notification bodies to ≤178 chars", () => {
    const longMessage = "x".repeat(300);
    const [mapped] = mapChatEvent(
      chatEnvelope({ type: "approval_request", itemId: "i", kind: "command", description: longMessage }),
    );
    expect(mapped.body.length).toBeLessThanOrEqual(178);
  });
});

describe("mapPrEvent", () => {
  it("maps checks_failing to high-priority active alert", () => {
    const [mapped] = mapPrEvent({ kind: "checks_failing", pr: samplePr });
    expect(mapped.category).toBe("PR_CI_FAILING");
    expect(mapped.priority).toBe(10);
    expect(mapped.deepLink).toBe("ade://pr/412");
    expect(mapped.collapseId).toBe("pr:pr-1:checks_failing");
  });

  it("maps merge_ready to active priority-5 alert", () => {
    const [mapped] = mapPrEvent({ kind: "merge_ready", pr: samplePr });
    expect(mapped.category).toBe("PR_MERGE_READY");
    expect(mapped.priority).toBe(5);
  });

  it("exposes PR metadata for deep-link enrichment", () => {
    const [mapped] = mapPrEvent({ kind: "review_requested", pr: samplePr });
    expect(mapped.metadata).toMatchObject({
      prNumber: 412,
      laneId: "lane-1",
      githubUrl: samplePr.githubUrl,
    });
  });
});

describe("mapMissionEvent + mapSystemEvent", () => {
  it("maps mission phase change to CTO category", () => {
    const [mapped] = mapMissionEvent({ missionId: "m-1", phase: "development", message: "Entered development" });
    expect(mapped.category).toBe("CTO_MISSION_PHASE");
    expect(mapped.deepLink).toBe("ade://mission/m-1");
  });

  it("maps system auth_rate_limit to priority-10 alert", () => {
    const [mapped] = mapSystemEvent({
      kind: "auth_rate_limit",
      title: "Rate limit hit",
      message: "Claude rate limit reached; retrying in 2 min.",
    });
    expect(mapped.category).toBe("SYSTEM_AUTH_RATE_LIMIT");
    expect(mapped.priority).toBe(10);
  });
});

describe("buildApnsPayload", () => {
  it("includes alert body + interruption level in aps block", () => {
    const mapped: MappedNotification = {
      category: "CHAT_AWAITING_INPUT",
      family: "chat",
      title: "Hi",
      body: "Approve?",
      pushType: "alert",
      priority: 10,
      interruptionLevel: "time-sensitive",
      collapseId: "cid",
    };
    const payload = buildApnsPayload(mapped);
    expect(payload.aps).toMatchObject({
      alert: { title: "Hi", body: "Approve?" },
      "interruption-level": "time-sensitive",
      sound: "default",
      "thread-id": "cid",
    });
  });

  it("silent payloads set content-available and omit alert", () => {
    const payload = buildApnsPayload({
      category: "CHAT_COMPLETED",
      family: "chat",
      title: "t",
      body: "b",
      pushType: "background",
      priority: 5,
      interruptionLevel: "passive",
      silent: true,
    });
    expect((payload.aps as Record<string, unknown>).alert).toBeUndefined();
    expect((payload.aps as Record<string, unknown>)["content-available"]).toBe(1);
  });
});

describe("isAllowedByPrefs", () => {
  const mapped: MappedNotification = {
    category: "CHAT_COMPLETED",
    family: "chat",
    title: "x",
    body: "y",
    pushType: "alert",
    priority: 5,
    interruptionLevel: "passive",
  };
  const prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES };

  it("blocks when master switch is off", () => {
    expect(isAllowedByPrefs(mapped, { ...prefs, enabled: false })).toBe(false);
  });

  it("honors per-category toggles", () => {
    expect(isAllowedByPrefs(mapped, prefs)).toBe(false); // turn_completed off by default
    expect(
      isAllowedByPrefs(mapped, {
        ...prefs,
        chat: { ...prefs.chat, turnCompleted: true },
      }),
    ).toBe(true);
  });

  it("blocks while mute is active", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(
      isAllowedByPrefs(
        { ...mapped, category: "CHAT_AWAITING_INPUT" },
        { ...prefs, muteUntil: future },
      ),
    ).toBe(false);
  });

  it("allows after mute expires", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(
      isAllowedByPrefs(
        { ...mapped, category: "CHAT_AWAITING_INPUT" },
        { ...prefs, muteUntil: past },
      ),
    ).toBe(true);
  });
});
