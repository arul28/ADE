/* @vitest-environment jsdom */

/**
 * The account note answers one question: which login paid for this chat. It has
 * three sources and must pick them in order — the latest finished turn's
 * account, then the account the chat is bound to, then that provider's default
 * when the bound id no longer names an account.
 */
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope, AgentChatUsageAccount } from "../../../shared/types/chat";
import type { OpenProjectBinding } from "../../../shared/types";
import type { ProviderInstance } from "../../../shared/types/providerInstances";
import { ChatAccountNote } from "./ChatAccountNote";

function instance(overrides: Partial<ProviderInstance> & { id: string }): ProviderInstance {
  return {
    provider: "claude",
    label: overrides.id,
    configHome: `/home/${overrides.id}`,
    isDefault: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    signedIn: true,
    ...overrides,
  };
}

const DEFAULT_INSTANCE = instance({ id: "claude", label: "Personal", isDefault: true, account: { email: "default@example.com" } });
const WORK_INSTANCE = instance({ id: "work", label: "Work", account: { email: "work@example.com" } });

function doneEvent(account: AgentChatUsageAccount): AgentChatEventEnvelope {
  return {
    sessionId: "chat-1",
    timestamp: "2026-09-18T10:00:00.000Z",
    event: { type: "done", turnId: "turn-1", status: "completed", account },
  };
}

/** A distinct pin per test, so the note's module-level read cache cannot leak between cases. */
function pin(key: string): OpenProjectBinding {
  return { key } as unknown as OpenProjectBinding;
}

function installBridge(instances: ProviderInstance[]): void {
  (globalThis.window as unknown as { ade: unknown }).ade = {
    providerInstances: { list: vi.fn().mockResolvedValue(instances) },
  };
}

function noteText(): string {
  return screen.getByTestId("chat-account-note").textContent ?? "";
}

describe("ChatAccountNote account resolution", () => {
  const originalAde = (globalThis.window as unknown as { ade: unknown }).ade;

  afterEach(() => {
    cleanup();
    (globalThis.window as unknown as { ade: unknown }).ade = originalAde;
    vi.restoreAllMocks();
  });

  it("names the account the latest finished turn reported", async () => {
    installBridge([DEFAULT_INSTANCE, WORK_INSTANCE]);
    const events = [
      doneEvent({ provider: "claude", kind: "subscription", instanceId: "work", email: "turn@example.com" }),
    ];

    render(
      <ChatAccountNote sessionId="chat-1" provider="claude" instanceId="work" events={events} runtimePin={pin("turn")} />,
    );

    await waitFor(() => {
      expect(noteText()).toContain("turn@example.com");
    });
    expect(noteText()).not.toContain("work@example.com");
  });

  it("falls back to the account the chat is bound to when no turn reported one", async () => {
    installBridge([DEFAULT_INSTANCE, WORK_INSTANCE]);

    render(
      <ChatAccountNote sessionId="chat-1" provider="claude" instanceId="work" events={[]} runtimePin={pin("bound")} />,
    );

    await waitFor(() => {
      expect(noteText()).toContain("work@example.com");
    });
  });

  it("falls back to the provider's default when the bound account no longer exists", async () => {
    installBridge([DEFAULT_INSTANCE, WORK_INSTANCE]);

    render(
      <ChatAccountNote sessionId="chat-1" provider="claude" instanceId="removed" events={[]} runtimePin={pin("removed")} />,
    );

    await waitFor(() => {
      expect(noteText()).toContain("default@example.com");
    });
  });
});
