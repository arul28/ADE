/* @vitest-environment jsdom */

/**
 * The account note answers one question: which login paid for this chat. It has
 * three sources and must pick them in order — the latest finished turn's
 * account, then the account the chat is bound to, then that provider's default
 * when the bound id no longer names an account.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function installBridge(instances: ProviderInstance[], switchAccount?: ReturnType<typeof vi.fn>): void {
  (globalThis.window as unknown as { ade: unknown }).ade = {
    providerInstances: { list: vi.fn().mockResolvedValue(instances) },
    ...(switchAccount ? { agentChat: { switchAccount }, usage: { getSnapshot: vi.fn().mockResolvedValue(null) } } : {}),
  };
}

/** Opens the account menu the way a keyboard user does; jsdom has no pointer capture for Radix. */
function openSwitcher(): void {
  fireEvent.keyDown(screen.getByTestId("chat-account-note"), { key: "Enter" });
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

  it("names the chat's current account when the latest turn ran on the account it moved from", async () => {
    installBridge([DEFAULT_INSTANCE, WORK_INSTANCE]);
    const events = [
      doneEvent({ provider: "claude", kind: "subscription", instanceId: "claude", email: "default@example.com" }),
    ];

    render(
      <ChatAccountNote sessionId="chat-1" provider="claude" instanceId="work" events={events} runtimePin={pin("moved")} />,
    );

    await waitFor(() => {
      expect(noteText()).toContain("work@example.com");
    });
    expect(noteText()).not.toContain("default@example.com");
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

  it("switches the chat to another signed-in account picked from the row", async () => {
    const copy = instance({ id: "copy", account: { email: "default@example.com" }, sameLoginAs: "claude" });
    const signedOut = instance({ id: "old", account: { email: "old@example.com" }, signedIn: false });
    const switchAccount = vi.fn().mockResolvedValue({ ok: true, instanceId: "work" });
    const onSwitched = vi.fn();
    installBridge([DEFAULT_INSTANCE, WORK_INSTANCE, copy, signedOut], switchAccount);
    render(
      <ChatAccountNote sessionId="chat-1" provider="claude" instanceId="claude" events={[]} runtimePin={pin("switch")} onSwitched={onSwitched} />,
    );
    await waitFor(() => expect(noteText()).toContain("default@example.com"));

    openSwitcher();
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent ?? "");
    // Copies of one login and signed-out accounts are not real choices.
    expect(items.join("|")).not.toContain("old@example.com");
    expect(items.filter((text) => text.includes("default@example.com"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("menuitem", { name: /work@example\.com/ }));

    await waitFor(() => expect(onSwitched).toHaveBeenCalledTimes(1));
    expect(switchAccount).toHaveBeenCalledWith({ sessionId: "chat-1", instanceId: "work" }, pin("switch"));
  });

  it.each([
    { name: "a turn is running", props: { busy: true }, expectSwitcher: true },
    { name: "a saved key pays for the chat", props: { credentialId: "cred-1" }, expectSwitcher: false },
  ])("does not switch accounts while $name", async ({ props, expectSwitcher }) => {
    const switchAccount = vi.fn().mockResolvedValue({ ok: true, instanceId: "work" });
    installBridge([DEFAULT_INSTANCE, WORK_INSTANCE], switchAccount);
    render(
      <ChatAccountNote sessionId="chat-1" provider="claude" instanceId="claude" events={[]} runtimePin={pin(`refuse-${expectSwitcher}`)} {...props} />,
    );
    await waitFor(() => expect(screen.getByTestId("chat-account-note")).toBeTruthy());

    openSwitcher();
    if (expectSwitcher) {
      const work = await screen.findByRole("menuitem", { name: /work@example\.com/ });
      expect(work.getAttribute("data-disabled")).not.toBeNull();
      fireEvent.click(work);
    } else {
      expect(screen.queryByRole("menuitem")).toBeNull();
    }
    expect(switchAccount).not.toHaveBeenCalled();
  });
});
