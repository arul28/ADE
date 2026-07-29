// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionItem,
} from "../../../shared/types";
import {
  attentionStore,
  resetAttentionStoreForTests,
} from "../../state/attentionStore";
import {
  publishAccountStatus,
  SIGNED_OUT_ACCOUNT,
} from "../../lib/account";
import {
  AttentionCenter,
} from "./AttentionCenter";
import {
  attentionNotchSettingsFromPreferences,
  onAttentionNotchSettingsChanged,
  persistAttentionNotchSettings,
  readAttentionNotchEnabled,
  readAttentionNotchPresentation,
  writeAttentionNotchEnabled,
  writeAttentionNotchPresentation,
} from "./attentionNotchLocalSettings";

const originalAde = window.ade;
const signedInAccount = {
  signedIn: true as const,
  userId: "account-a",
  email: null,
  name: null,
  expiresAt: null,
  provider: null,
  imageUrl: null,
};

beforeEach(() => {
  publishAccountStatus(signedInAccount);
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: {
      ...(originalAde ?? {}),
      account: {
        ...(originalAde?.account ?? {}),
        status: vi.fn(async () => signedInAccount),
      },
    },
  });
});

function item(
  id: string,
  patch: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id,
    revision: 1,
    fingerprint: `fingerprint-${id}`,
    kind: "agent",
    eventKind: "agent_needs_you",
    phase: "needs_you",
    machine: {
      machineKey: "studio",
      name: "Studio Mac",
      online: true,
      lastSeenAt: "2026-07-28T14:00:00.000Z",
    },
    project: { projectId: "ade", name: "ADE", rootPath: "/repo/ade" },
    provider: "codex",
    model: "GPT-5",
    title: `Task ${id}`,
    preview: "Waiting for a safe decision",
    privacyPreview: "Agent needs your attention",
    detail: "The agent reached an approval checkpoint.",
    recentActivity: ["Edited AuthService.ts", "Ran focused tests"],
    planProgress: { completed: 2, total: 4, current: "Verify the approval flow" },
    destination: { kind: "session", sessionId: `session-${id}` },
    actions: [
      { id: `approve-${id}`, kind: "approve", label: "Approve" },
      { id: `deny-${id}`, kind: "deny", label: "Deny" },
    ],
    occurredAt: "2026-07-28T14:00:00.000Z",
    updatedAt: "2026-07-28T14:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...patch,
  };
}

afterEach(() => {
  cleanup();
  resetAttentionStoreForTests();
  publishAccountStatus(SIGNED_OUT_ACCOUNT);
  window.localStorage.removeItem("ade:attention:notch-enabled");
  window.localStorage.removeItem("ade:attention:notch-reveal-mode");
  window.localStorage.removeItem("ade:attention:notch-expanded-panel");
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: originalAde,
  });
});

describe("AttentionCenter", () => {
  it("opens exact context before acknowledging an unhandled action", async () => {
    const online = item("approval");
    attentionStore.setState({
      itemsById: { [online.id]: online },
      generatedAt: "2026-07-28T14:00:00.000Z",
    });
    let finishOpening: () => void = () => {};
    const openItem = vi.fn(() => new Promise<void>((resolve) => {
      finishOpening = resolve;
    }));

    render(<AttentionCenter onOpenItem={openItem} />);

    expect(screen.getByRole("heading", { name: "Task approval" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open to approve" }));
    await waitFor(() => expect(openItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: online.id,
        destination: online.destination,
      }),
    ));
    expect(attentionStore.getState().itemsById.approval?.seenAt).toBeNull();

    await act(async () => {
      finishOpening();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(attentionStore.getState().itemsById.approval?.seenAt).not.toBeNull();
    });
  });

  it("keeps failed navigation unseen and explains how opening failed", async () => {
    const remote = item("unreachable");
    attentionStore.setState({ itemsById: { [remote.id]: remote } });
    const openItem = vi.fn(async () => {
      throw new Error("Studio Mac stopped responding.");
    });

    render(<AttentionCenter onOpenItem={openItem} />);
    fireEvent.click(screen.getByRole("button", { name: "Open to approve" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Studio Mac stopped responding.",
      );
    });
    expect(attentionStore.getState().itemsById.unreachable?.seenAt).toBeNull();
  });

  it("keeps remote actions disabled for last-known offline work", () => {
    const offline = item("offline", {
      machine: {
        machineKey: "cloud",
        name: "Cloud Mac",
        online: false,
        lastSeenAt: "2026-07-28T13:00:00.000Z",
      },
    });
    attentionStore.setState({ itemsById: { [offline.id]: offline } });

    render(<AttentionCenter />);

    expect(screen.getByText("Cloud Mac is offline.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Open to approve" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("applies project lenses and offers a one-click clear affordance", () => {
    const ade = item("ade");
    const versic = item("versic", {
      project: { projectId: "versic", name: "Versic", rootPath: "/repo/versic" },
      title: "Task Versic",
    });
    attentionStore.setState({
      itemsById: { [ade.id]: ade, [versic.id]: versic },
    });

    render(<AttentionCenter />);
    fireEvent.click(screen.getByRole("button", { name: "All machines" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Versic" }));

    return waitFor(() => {
      expect(screen.getByRole("heading", { name: "Task Versic" })).toBeTruthy();
    }).then(() => {
      expect(screen.queryByRole("heading", { name: "Task ade" })).toBeNull();
      fireEvent.click(screen.getByTitle("Clear scope"));
      expect(attentionStore.getState().scope).toEqual({ kind: "all" });
    });
  });

  it("rolls back a failed acknowledgement and explains the failure", async () => {
    const approval = item("rollback");
    let rejectAcknowledgement: (error: Error) => void = () => {};
    const acknowledge = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectAcknowledgement = reject;
    }));
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(window.ade ?? {}),
        attention: {
          acknowledge,
          getSnapshot: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(),
          putPreferences: vi.fn(),
        },
      },
    });
    attentionStore.setState({ itemsById: { [approval.id]: approval } });
    render(<AttentionCenter />);

    fireEvent.click(screen.getByRole("button", { name: /Task rollback/ }));
    expect(attentionStore.getState().itemsById.rollback?.seenAt).not.toBeNull();

    await act(async () => {
      rejectAcknowledgement(new Error("Relay is temporarily unavailable."));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(attentionStore.getState().itemsById.rollback?.seenAt).toBeNull();
      expect(screen.getByRole("alert").textContent).toContain("Relay is temporarily unavailable.");
    });
  });

  it("contains a rejected detail acknowledgement after rolling it back", async () => {
    const approval = item("detail-rollback");
    const acknowledge = vi.fn(async () => {
      throw new Error("Relay rejected the acknowledgement.");
    });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(window.ade ?? {}),
        attention: {
          acknowledge,
          getSnapshot: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(),
          putPreferences: vi.fn(),
        },
      },
    });
    attentionStore.setState({ itemsById: { [approval.id]: approval } });
    render(<AttentionCenter />);

    fireEvent.click(screen.getByTitle("Mark as seen"));

    await waitFor(() => {
      expect(acknowledge).toHaveBeenCalledWith({
        itemIds: [approval.id],
        sourceRevisions: { [approval.id]: approval.revision },
        expectedAccountOwnerId: null,
        seenAt: expect.any(String),
      });
      expect(attentionStore.getState().itemsById[approval.id]?.seenAt).toBeNull();
      expect(screen.getByRole("alert").textContent).toContain(
        "Relay rejected the acknowledgement.",
      );
    });
  });

  it("walks the roster with arrow keys and exposes it as a single tab stop", () => {
    const first = item("first");
    const second = item("second", { updatedAt: "2026-07-28T13:59:00.000Z" });
    attentionStore.setState({ itemsById: { [first.id]: first, [second.id]: second } });

    const { container } = render(<AttentionCenter />);
    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-attention-item]"),
    );

    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);

    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);

    fireEvent.keyDown(rows[0], { key: "End" });
    expect(document.activeElement).toBe(rows[1]);
  });

  it("moves focus into the scope menu and hands it back when dismissed", () => {
    const only = item("scoped");
    attentionStore.setState({ itemsById: { [only.id]: only } });

    render(<AttentionCenter />);
    const trigger = screen.getByRole("button", { name: "All machines" });
    fireEvent.click(trigger);

    const options = screen.getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(options[0]);

    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);

    fireEvent.keyDown(options[1], { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the settings trigger when the popover is dismissed", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(window.ade ?? {}),
        attention: {
          getSnapshot: vi.fn(),
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
          putPreferences: vi.fn(),
        },
      },
    });

    render(<AttentionCenter />);
    const trigger = screen.getByRole("button", { name: "Attention settings" });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Attention settings" });
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Attention settings" })).toBeNull();
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("saves account delivery preferences and keeps ADE Notch device-local", async () => {
    const putPreferences = vi.fn(async () => undefined);
    const updateSettings = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(window.ade ?? {}),
        attention: {
          getSnapshot: vi.fn(),
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
          putPreferences,
        },
        attentionNotch: {
          publishSnapshot: vi.fn(),
          updateSettings,
          onAcknowledgeRequested: vi.fn(() => () => {}),
        },
      },
    });
    render(<AttentionCenter />);

    fireEvent.click(screen.getByRole("button", { name: "Attention settings" }));
    await screen.findByRole("dialog", { name: "Attention settings" });
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Sounds" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("switch", { name: "ADE Notch" }));
    fireEvent.click(screen.getByRole("switch", { name: "Sounds" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Phone escalation" }), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(putPreferences).toHaveBeenCalledWith(
        "account-a",
        expect.objectContaining({
          account: expect.objectContaining({
            soundsEnabled: true,
            desktopFirstEnabled: true,
            desktopFirstDelaySeconds: 120,
          }),
        }),
      );
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        enabled: false,
        soundsEnabled: true,
      }));
      expect(window.localStorage.getItem("ade:attention:notch-enabled")).toBe("false");
    });
  });

  // Off, the three reveal modes, and the expanded-panel switch are the whole
  // presentation contract; they only mean anything if they reach the helper.
  it("sends the chosen notch presentation to the native helper and keeps it on this Mac", async () => {
    const updateSettings = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(window.ade ?? {}),
        attention: {
          getSnapshot: vi.fn(),
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
          putPreferences: vi.fn(async () => undefined),
        },
        attentionNotch: {
          publishSnapshot: vi.fn(),
          updateSettings,
          getHealth: vi.fn(async () => ({
            state: "running" as const,
            title: "ADE Notch is active",
            message: "Showing account activity in the menu bar.",
            recovery: null,
            surface: "menu_bar" as const,
          })),
          onAcknowledgeRequested: vi.fn(() => () => {}),
        },
      },
    });
    render(<AttentionCenter />);

    fireEvent.click(screen.getByRole("button", { name: "Attention settings" }));
    await screen.findByRole("dialog", { name: "Attention settings" });
    const behavior = await screen.findByRole("combobox", { name: "Notch behavior" });

    // Defaults are today's surface, so an untouched Mac changes nothing.
    expect((behavior as HTMLSelectElement).value).toBe("hover");
    expect(screen.getByRole("switch", { name: "Expanded panel" }).getAttribute("aria-checked"))
      .toBe("true");

    fireEvent.change(behavior, { target: { value: "click" } });
    fireEvent.click(screen.getByRole("switch", { name: "Expanded panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        enabled: true,
        revealMode: "click",
        expandedPanelEnabled: false,
      }));
      expect(window.localStorage.getItem("ade:attention:notch-reveal-mode")).toBe("click");
      expect(window.localStorage.getItem("ade:attention:notch-expanded-panel")).toBe("false");
    });
  });

  it("locks the notch presentation controls while ADE Notch is off", async () => {
    render(<AttentionCenter />);

    fireEvent.click(screen.getByRole("button", { name: "Attention settings" }));
    await screen.findByRole("dialog", { name: "Attention settings" });
    await screen.findByRole("combobox", { name: "Notch behavior" });

    fireEvent.click(screen.getByRole("switch", { name: "ADE Notch" }));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Notch behavior" }).hasAttribute("disabled"))
        .toBe(true);
      expect(screen.getByRole("switch", { name: "Expanded panel" }).hasAttribute("disabled"))
        .toBe(true);
    });
  });

  it("clears a closed save without letting its stale result interrupt a replacement", async () => {
    let resolveStaleSave: () => void = () => {};
    const staleSave = new Promise<void>((resolve) => {
      resolveStaleSave = resolve;
    });
    let resolveReplacementSave: () => void = () => {};
    const replacementSave = new Promise<void>((resolve) => {
      resolveReplacementSave = resolve;
    });
    const putPreferences = vi.fn()
      .mockImplementationOnce(() => staleSave)
      .mockImplementationOnce(() => replacementSave);
    const updateSettings = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(window.ade ?? {}),
        attention: {
          getSnapshot: vi.fn(),
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
          putPreferences,
        },
        attentionNotch: {
          publishSnapshot: vi.fn(),
          updateSettings,
          onAcknowledgeRequested: vi.fn(() => () => {}),
        },
      },
    });
    render(<AttentionCenter />);

    const trigger = screen.getByRole("button", { name: "Attention settings" });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Attention settings" })).toBeNull();
    });

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(putPreferences).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    });

    await act(async () => {
      resolveStaleSave();
      await staleSave;
    });

    expect(updateSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();

    await act(async () => {
      resolveReplacementSave();
      await replacementSave;
    });
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Saved")).toBeTruthy();
    });
  });

  it("does not apply an earlier account's delayed preferences after switching accounts", async () => {
    let resolveAccountA: (preferences: typeof DEFAULT_ATTENTION_PREFERENCES) => void =
      () => {};
    const accountAPreferences = new Promise<typeof DEFAULT_ATTENTION_PREFERENCES>((resolve) => {
      resolveAccountA = resolve;
    });
    const accountBPreferences = {
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: {
        ...DEFAULT_ATTENTION_PREFERENCES.account,
        notificationsEnabled: false,
        hideDetails: false,
      },
    };
    const putPreferences = vi.fn(async () => undefined);
    const getPreferences = vi
      .fn()
      .mockImplementationOnce(() => accountAPreferences)
      .mockResolvedValueOnce(accountBPreferences);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(window.ade ?? {}),
        attention: {
          getSnapshot: vi.fn(),
          acknowledge: vi.fn(),
          reportPresence: vi.fn(),
          getPreferences,
          putPreferences,
        },
      },
    });
    render(<AttentionCenter />);

    fireEvent.click(screen.getByRole("button", { name: "Attention settings" }));
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));

    act(() => {
      publishAccountStatus({
        signedIn: true,
        userId: "account-b",
        email: null,
        name: null,
        expiresAt: null,
        provider: null,
        imageUrl: null,
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Attention settings" })).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Attention settings" }));
    await screen.findByRole("dialog", { name: "Attention settings" });
    await waitFor(() => {
      expect(getPreferences).toHaveBeenCalledTimes(2);
      expect(
        screen.getByRole("switch", { name: "Phone notifications" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });

    await act(async () => {
      resolveAccountA({
        ...DEFAULT_ATTENTION_PREFERENCES,
        account: {
          ...DEFAULT_ATTENTION_PREFERENCES.account,
          notificationsEnabled: true,
          hideDetails: true,
        },
      });
      await accountAPreferences;
    });

    expect(
      screen.getByRole("switch", { name: "Phone notifications" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(putPreferences).toHaveBeenCalledWith("account-b", accountBPreferences);
    });
  });
});

describe("attention notch local settings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults safely and falls back from an unreadable reveal mode", () => {
    expect(readAttentionNotchEnabled()).toBe(true);
    expect(readAttentionNotchPresentation()).toEqual({
      revealMode: "hover",
      expandedPanelEnabled: true,
    });

    window.localStorage.setItem("ade:attention:notch-reveal-mode", "telepathy");
    expect(readAttentionNotchPresentation().revealMode).toBe("hover");
  });

  it("round-trips every presentation mode independently from full disable", () => {
    for (const revealMode of ["minimal", "hover", "click"] as const) {
      writeAttentionNotchPresentation({ revealMode, expandedPanelEnabled: false });
      expect(readAttentionNotchPresentation()).toEqual({
        revealMode,
        expandedPanelEnabled: false,
      });
    }
    writeAttentionNotchEnabled(false);

    expect(attentionNotchSettingsFromPreferences(DEFAULT_ATTENTION_PREFERENCES))
      .toMatchObject({
        enabled: false,
        revealMode: "click",
        expandedPanelEnabled: false,
      });
  });

  it("persists native context-menu changes and notifies the renderer", () => {
    let observed: ReturnType<typeof attentionNotchSettingsFromPreferences> | null = null;
    const unsubscribe = onAttentionNotchSettingsChanged((settings) => {
      observed = settings;
    });
    persistAttentionNotchSettings({
      enabled: false,
      revealMode: "minimal",
      expandedPanelEnabled: false,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });

    expect(readAttentionNotchEnabled()).toBe(false);
    expect(readAttentionNotchPresentation()).toEqual({
      revealMode: "minimal",
      expandedPanelEnabled: false,
    });
    expect(observed).toMatchObject({
      enabled: false,
      revealMode: "minimal",
      expandedPanelEnabled: false,
    });
    unsubscribe();
  });
});
