import { describe, expect, it, vi } from "vitest";
import type { DraftEntry } from "../../../shared/types/chat";
import {
  deliverDraft,
  draftAttachmentsReady,
  DraftDeliveryUnsupportedError,
  type DraftDeliveryDeps,
} from "./draftDelivery";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

function draft(overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    id: "draft-1",
    text: "check the migration",
    provider: null,
    modelId: null,
    createdAt: "2026-10-09T11:00:00.000Z",
    kind: "scheduled",
    status: "scheduled",
    scheduledAt: new Date(NOW).toISOString(),
    deliveryPolicy: "wait",
    targetKind: "existing",
    targetSessionId: "chat-1",
    ...overrides,
  };
}

function deps(overrides: Partial<DraftDeliveryDeps> = {}): DraftDeliveryDeps {
  return {
    now: () => NOW,
    targetChatExists: () => true,
    sendToChat: vi.fn(async () => {}),
    createChatAndSend: vi.fn(async () => {}),
    attachmentsReady: () => true,
    logger: { warn: () => {}, info: () => {} },
    ...overrides,
  };
}

describe("deliverDraft", () => {
  it("delivers into the target chat as a user turn", async () => {
    const send = vi.fn(async () => {});
    const outcome = await deliverDraft(draft(), deps({ sendToChat: send }));

    expect(outcome).toEqual({ status: "sent", firedAt: new Date(NOW).toISOString() });
    expect(send).toHaveBeenCalledWith({
      sessionId: "chat-1",
      text: "check the migration",
      attachments: [],
    });
  });

  it("blocks when the target chat is gone instead of throwing", async () => {
    const send = vi.fn(async () => {});
    const outcome = await deliverDraft(
      draft(),
      deps({ targetChatExists: () => false, sendToChat: send }),
    );

    expect(outcome.status).toBe("blocked");
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks a send that names no target at all", async () => {
    const outcome = await deliverDraft(
      draft({ targetSessionId: null }),
      deps(),
    );
    expect(outcome.status).toBe("blocked");
  });

  // The user's choice: hold rather than deliver a prompt with a missing image.
  it("holds while an image has not reached this machine", async () => {
    const send = vi.fn(async () => {});
    const outcome = await deliverDraft(
      draft(),
      deps({ attachmentsReady: () => false, sendToChat: send }),
    );

    expect(outcome.status).toBe("retry");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a send armed when delivery throws", async () => {
    const outcome = await deliverDraft(
      draft(),
      deps({ sendToChat: async () => { throw new Error("chat is busy"); } }),
    );

    expect(outcome).toEqual({ status: "retry", error: "chat is busy" });
  });

  it.each([
    ["wait", 60 * 60 * 1000, undefined, "sent"],
    ["strict", 60 * 1000, undefined, "missed"],
    ["grace", 30 * 1000, 120, "sent"],
    ["grace", 5 * 60 * 1000, 120, "missed"],
    ["wait", 0, undefined, "sent"],
  ] as const)(
    "applies the %s policy %dms late (grace %s) -> %s",
    async (policy, latenessMs, graceSeconds, expected) => {
      const outcome = await deliverDraft(
        draft({
          deliveryPolicy: policy,
          ...(graceSeconds === undefined ? {} : { graceSeconds }),
          scheduledAt: new Date(NOW - latenessMs).toISOString(),
        }),
        deps(),
      );

      expect(outcome.status).toBe(expected);
    },
  );

  it("creates the chat a new-target send asked for, with the captured config", async () => {
    const create = vi.fn(async () => {});
    const outcome = await deliverDraft(
      draft({
        targetKind: "new",
        targetSessionId: null,
        targetLaneId: "lane-9",
        provider: "claude",
        model: "claude-sonnet-5-5",
        modelId: "claude-sonnet-5-5",
        permissionMode: "plan",
        thinking: "high",
      }),
      deps({ createChatAndSend: create }),
    );

    expect(outcome.status).toBe("sent");
    expect(create).toHaveBeenCalledWith({
      laneId: "lane-9",
      text: "check the migration",
      attachments: [],
      provider: "claude",
      model: "claude-sonnet-5-5",
      modelId: "claude-sonnet-5-5",
      permissionMode: "plan",
      thinking: "high",
    });
  });

  it("blocks a new-target send that names no lane", async () => {
    const outcome = await deliverDraft(
      draft({ targetKind: "new", targetSessionId: null, targetLaneId: null }),
      deps(),
    );
    expect(outcome.status).toBe("blocked");
  });

  // A stricter policy must not be held open by an image that never arrives:
  // "on time or missed" has to resolve to missed.
  it("reports a blown strict window even when its images never arrived", async () => {
    const outcome = await deliverDraft(
      draft({
        deliveryPolicy: "strict",
        scheduledAt: new Date(NOW - 60_000).toISOString(),
      }),
      deps({ attachmentsReady: () => false }),
    );

    expect(outcome.status).toBe("missed");
  });

  it("blocks rather than retrying when this host cannot create the chat", async () => {
    const outcome = await deliverDraft(
      draft({ targetKind: "new", targetSessionId: null, targetLaneId: "lane-1" }),
      deps({
        createChatAndSend: async () => {
          throw new DraftDeliveryUnsupportedError("This computer cannot start a new chat.");
        },
      }),
    );

    expect(outcome.status).toBe("blocked");
  });
});

describe("draftAttachmentsReady", () => {
  const image = { path: "/tmp/design.png", type: "image" as const };

  // The row a foreign machine receives has its image references stripped, so a
  // short list is not "nothing to attach" — it is "the images are elsewhere".
  // Reading it as ready is what let a send deliver the text alone.
  const cases: Array<
    [string, Pick<DraftEntry, "attachments" | "attachmentCount">, boolean, boolean]
  > = [
    ["nothing attached", { attachments: [], attachmentCount: 0 }, true, true],
    ["every image present", { attachments: [image], attachmentCount: 1 }, true, true],
    ["an image file is gone", { attachments: [image], attachmentCount: 1 }, false, false],
    ["references stripped by another machine", { attachments: [], attachmentCount: 1 }, true, false],
  ];

  it.each(cases)("%s", (_label, entry, fileExists, expected) => {
    expect(draftAttachmentsReady(entry, () => fileExists)).toBe(expected);
  });
});
