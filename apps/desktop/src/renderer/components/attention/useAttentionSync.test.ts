import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionItem,
} from "../../../shared/types";
import {
  attentionNotchSnapshotSignature,
  attentionNotchSettingsFromPreferences,
  materializeAttentionNotchSnapshot,
} from "./useAttentionSync";
import {
  attentionStore,
  resetAttentionStoreForTests,
} from "../../state/attentionStore";

const runningItem: AttentionItem = {
  contractVersion: 1,
  id: "agent-running",
  revision: 2,
  fingerprint: "running:2",
  kind: "agent",
  eventKind: "agent_running",
  phase: "running",
  machine: {
    machineKey: "machine-1",
    name: "MacBook Pro",
    online: true,
    lastSeenAt: null,
  },
  project: {
    projectId: "project-1",
    name: "ADE",
    rootPath: "/projects/ADE",
  },
  title: "Running",
  preview: "Implementing Attention",
  privacyPreview: "Agent is working",
  destination: {
    kind: "session",
    sessionId: "session-1",
  },
  actions: [],
  occurredAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:01.000Z",
  seenAt: null,
  dismissedAt: null,
  expiresAt: null,
};

describe("Attention Notch renderer bridge", () => {
  beforeEach(() => resetAttentionStoreForTests());

  it("materializes the merged renderer state rather than forwarding a delta", () => {
    attentionStore.setState({
      revision: 8,
      generatedAt: "2026-07-28T12:00:02.000Z",
      itemsById: { [runningItem.id]: runningItem },
    });
    expect(materializeAttentionNotchSnapshot()).toEqual({
      contractVersion: 1,
      streamId: null,
      revision: 8,
      generatedAt: "2026-07-28T12:00:02.000Z",
      items: [runningItem],
      tombstones: [],
    });
  });

  it("maps account privacy, celebration, and sound preferences", () => {
    expect(attentionNotchSettingsFromPreferences({
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: {
        ...DEFAULT_ATTENTION_PREFERENCES.account,
        hideDetails: true,
        celebrationsEnabled: false,
        soundsEnabled: false,
      },
    }, true)).toEqual({
      enabled: true,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: false,
      soundsEnabled: false,
    });
  });

  it("invalidates the native snapshot signature for presence and canonical routing changes", () => {
    const originalSignature = attentionNotchSnapshotSignature({
      contractVersion: 1,
      streamId: "account-stream",
      revision: 8,
      generatedAt: "2026-07-28T12:00:02.000Z",
      items: [runningItem],
      tombstones: [],
    });
    const patchedSignature = attentionNotchSnapshotSignature({
      contractVersion: 1,
      streamId: "account-stream",
      revision: 8,
      generatedAt: "2026-07-28T12:00:02.000Z",
      items: [{
        ...runningItem,
        machine: {
          ...runningItem.machine,
          accountMachineKey: "canonical-machine-1",
          deviceId: "device-machine-1",
          name: "MacBook Pro · Remote",
          online: false,
          lastSeenAt: "2026-07-28T12:05:00.000Z",
        },
      }],
      tombstones: [],
    });

    expect(patchedSignature).not.toBe(originalSignature);
  });
});
