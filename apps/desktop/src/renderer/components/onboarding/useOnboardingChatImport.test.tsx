/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalSessionSummary, OpenProjectBinding } from "../../../shared/types";
import {
  pendingChatImportFor,
  queueChatImports,
} from "../../onboarding/pendingChatImports";
import { useOnboardingChatImport } from "./useOnboardingChatImport";

const ROOT = "/projects/first-run";
const PIN: OpenProjectBinding = {
  kind: "local",
  key: "local:/projects/first-run",
  rootPath: ROOT,
  displayName: "first-run",
};

function Harness() {
  useOnboardingChatImport({
    projectRoot: ROOT,
    projectBinding: PIN,
    lanes: [{ id: "main-lane", laneType: "primary" } as never],
    enabled: true,
  });
  return null;
}

function summary(id: string): ExternalSessionSummary {
  return {
    provider: "claude",
    id,
    cwd: ROOT,
    title: id,
    preview: null,
    createdAt: Date.now(),
    updatedAt: null,
    messageCount: 1,
    alreadyImported: false,
    possiblyActive: false,
    cwdMatchesRequestedLane: true,
    capabilities: {
      resumeInPlace: true,
      resumeInDifferentCwd: false,
      fork: true,
      forkIntoDifferentCwd: false,
      importToChat: false,
    },
  };
}

describe("useOnboardingChatImport", () => {
  const originalAde = window.ade;
  const list = vi.fn();
  const importChat = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    list.mockReset();
    importChat.mockReset().mockResolvedValue({});
    window.ade = {
      externalSessions: { list, import: importChat },
    } as unknown as typeof window.ade;
    queueChatImports([{ rootPath: ROOT, excludedKeys: ["claude:leave-out"] }], Date.now() - 1);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    window.ade = originalAde;
  });

  it("keeps a failed listing queued, then imports only included chats through the project pin", async () => {
    list.mockRejectedValueOnce(new Error("temporary list failure"));
    render(<Harness />);

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(list.mock.calls[0]?.[1]).toEqual(PIN);
    expect(pendingChatImportFor(ROOT)?.excludedKeys).toEqual(["claude:leave-out"]);

    list.mockResolvedValueOnce([summary("leave-out"), summary("bring-in")]);
    render(<Harness />);

    await waitFor(() => expect(importChat).toHaveBeenCalledTimes(1));
    expect(importChat).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "bring-in", laneId: "main-lane" }), PIN);
    expect(importChat).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: "leave-out" }), expect.anything());
    expect(pendingChatImportFor(ROOT)).toBeNull();
  });
});
