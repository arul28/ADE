/* @vitest-environment jsdom */

/**
 * The Accounts panel's contracts, not its pixels.
 *
 * Four things can silently break here and none of them are visual: a row that
 * stops joining its usage numbers to the right instance, a switch offered for a
 * fact that is not true (one account, or no five-hour window), a menu item
 * wired to the wrong store method, and an add-account sheet that declares
 * success without re-reading the registry. Those are what these cover.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, ProviderLoginStatus } from "../../../../../shared/types/providerInstances";
import type { UsageSnapshot } from "../../../../../shared/types";
import { ProviderAccountsPanel } from "./ProviderAccountsPanel";

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

const DEFAULT_INSTANCE = instance({
  id: "claude",
  label: "Personal",
  isDefault: true,
  account: { email: "arul@gmail.com", plan: "Max" },
});

const WORK_INSTANCE = instance({
  id: "claude-work",
  label: "Work",
  account: { email: "arul@acme.com", plan: "Team" },
  accentColor: "#5b93f5",
});

function snapshot(options?: { fiveHour?: boolean; nextPickInstanceId?: string }): UsageSnapshot {
  const fiveHour = options?.fiveHour ?? true;
  return {
    windows: [
      ...(fiveHour
        ? [
            {
              provider: "claude" as const,
              windowType: "five_hour" as const,
              accountId: "claude:claude",
              percentUsed: 85,
              resetsAt: "2026-09-18T12:00:00.000Z",
              resetsInMs: 1_000,
            },
            {
              provider: "claude" as const,
              windowType: "five_hour" as const,
              accountId: "claude:claude-work",
              percentUsed: 100,
              resetsAt: "2026-09-18T12:00:00.000Z",
              resetsInMs: 1_000,
            },
          ]
        : []),
      {
        provider: "claude" as const,
        windowType: "weekly" as const,
        accountId: "claude:claude",
        percentUsed: 72,
        resetsAt: "2026-09-22T12:00:00.000Z",
        resetsInMs: 2_000,
      },
      {
        provider: "claude" as const,
        windowType: "weekly" as const,
        accountId: "claude:claude-work",
        percentUsed: 92,
        resetsAt: "2026-09-22T12:00:00.000Z",
        resetsInMs: 2_000,
      },
    ],
    accounts: [
      { id: "claude:claude", provider: "claude", instanceId: "claude", machines: [] },
      { id: "claude:claude-work", provider: "claude", instanceId: "claude-work", machines: [] },
    ],
    pacing: {} as UsageSnapshot["pacing"],
    costs: [],
    extraUsage: [],
    lastPolledAt: "2026-09-18T10:00:00.000Z",
    errors: [],
    ...(options?.nextPickInstanceId
      ? { balanceNext: [{ provider: "claude" as const, instanceId: options.nextPickInstanceId }] }
      : {}),
  };
}

/** A sign-in the host reports, in the shape `providerInstances.loginStart` returns. */
function loginStatus(overrides: Partial<ProviderLoginStatus> = {}): ProviderLoginStatus {
  return {
    loginId: "login-1",
    instanceId: "claude-new",
    provider: "claude",
    state: "running",
    url: null,
    awaitingCode: false,
    output: "",
    startedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

type Harness = {
  providerInstances: Record<string, ReturnType<typeof vi.fn>>;
};

function installBridge(options?: {
  instances?: ProviderInstance[];
  usage?: UsageSnapshot;
  smartBalance?: boolean;
}): Harness {
  const list = options?.instances ?? [DEFAULT_INSTANCE, WORK_INSTANCE];

  const providerInstances = {
    list: vi.fn().mockResolvedValue(list),
    create: vi.fn().mockResolvedValue({
      instance: instance({ id: "claude-new", label: "Work", signedIn: false }),
      loginCommand: { command: "claude", args: ["/login"], env: { CLAUDE_CONFIG_DIR: "/home/claude-new" } },
    }),
    remove: vi.fn().mockResolvedValue({ removed: true, configHome: "/home/claude-work" }),
    rename: vi.fn().mockResolvedValue(WORK_INSTANCE),
    setDefault: vi.fn().mockResolvedValue(WORK_INSTANCE),
    setAccent: vi.fn().mockResolvedValue(WORK_INSTANCE),
    dismissReplaced: vi.fn().mockResolvedValue(WORK_INSTANCE),
    getSettings: vi.fn().mockResolvedValue({
      smartBalance: options?.smartBalance ?? false,
      autoStartWindows: false,
    }),
    setSettings: vi.fn().mockResolvedValue({ smartBalance: true, autoStartWindows: false }),
    loginStart: vi.fn().mockResolvedValue(loginStatus()),
    loginStatus: vi.fn().mockResolvedValue(loginStatus()),
    loginSubmitCode: vi.fn().mockResolvedValue(loginStatus()),
    loginCancel: vi.fn().mockResolvedValue(loginStatus({ state: "cancelled" })),
    refresh: vi.fn().mockResolvedValue([
      instance({ id: "claude-new", label: "Work", signedIn: true, account: { email: "arul@acme.com" } }),
    ]),
  };

  (globalThis.window as unknown as { ade: unknown }).ade = {
    providerInstances,
    usage: {
      getSnapshot: vi.fn().mockResolvedValue(options?.usage ?? snapshot()),
      onUpdate: vi.fn(() => () => {}),
    },
    app: {
      onProjectBindingChanged: vi.fn(() => () => {}),
    },
  };

  return { providerInstances };
}

function renderPanel() {
  return render(<ProviderAccountsPanel provider="claude" providerLabel="Claude Code" />);
}

describe("ProviderAccountsPanel", () => {
  const originalAde = (globalThis.window as unknown as { ade: unknown }).ade;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    (globalThis.window as unknown as { ade: unknown }).ade = originalAde;
    vi.restoreAllMocks();
  });

  it("renders one card per instance with its identity and which account new chats use", async () => {
    installBridge();
    renderPanel();

    expect(await screen.findByText("Accounts · 2")).toBeTruthy();

    const personal = await screen.findByRole("group", { name: "Personal account" });
    expect(within(personal).getByText("arul@gmail.com")).toBeTruthy();
    // Smart balance is off, so the default account is the one new chats use.
    expect(within(personal).getByText("New chats")).toBeTruthy();

    const work = screen.getByRole("group", { name: "Work account" });
    expect(within(work).getByText("arul@acme.com")).toBeTruthy();
    expect(within(work).queryByText("New chats")).toBeNull();
  });

  it("marks the account smart balance would use next while it is on", async () => {
    installBridge({ smartBalance: true, usage: snapshot({ nextPickInstanceId: "claude-work" }) });
    renderPanel();

    const work = await screen.findByRole("group", { name: "Work account" });
    const personal = screen.getByRole("group", { name: "Personal account" });

    expect(within(work).getByText("Next chat")).toBeTruthy();
    expect(within(personal).queryByText("Next chat")).toBeNull();
  });

  it("says a signed-in account has no usage yet when it has no windows", async () => {
    const extra = instance({
      id: "claude-extra",
      label: "Extra",
      account: { email: "extra@example.com", plan: "Max" },
    });
    installBridge({ instances: [DEFAULT_INSTANCE, WORK_INSTANCE, extra] });
    renderPanel();

    expect(await screen.findByText("Accounts · 3")).toBeTruthy();
    const row = screen.getByRole("group", { name: "Extra account" });
    expect(within(row).getByText("No usage yet")).toBeTruthy();
  });

  it("names the host's throttle instead of saying No usage yet", async () => {
    const throttled = snapshot();
    // The throttled account has no windows — that is why it has no numbers —
    // and the host recorded why. The healthy sibling keeps its meters.
    throttled.windows = throttled.windows.filter((window) => window.accountId !== "claude:claude");
    throttled.accounts = [
      {
        id: "claude:claude",
        provider: "claude",
        instanceId: "claude",
        machines: [],
        notice: { message: "Rate-limited", nextRetryAt: "2026-09-18T10:05:00.000Z" },
      },
      { id: "claude:claude-work", provider: "claude", instanceId: "claude-work", machines: [] },
    ];
    installBridge({ usage: throttled });
    renderPanel();

    const personal = await screen.findByRole("group", { name: "Personal account" });
    expect(within(personal).getByText("Rate-limited — retrying")).toBeTruthy();
    expect(within(personal).queryByText("No usage yet")).toBeNull();

    // The healthy sibling is not named as throttled.
    const work = screen.getByRole("group", { name: "Work account" });
    expect(within(work).queryByText("Rate-limited — retrying")).toBeNull();
  });

  it("offers a sign-in for an account whose config home has no login", async () => {
    installBridge({
      instances: [instance({ id: "claude", label: "Personal", isDefault: true, signedIn: false })],
    });
    renderPanel();

    const row = await screen.findByRole("group", { name: "Personal account" });
    expect(within(row).getByText("Not signed in")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("hides smart balance until there are two accounts to balance", async () => {
    installBridge({ instances: [DEFAULT_INSTANCE] });
    renderPanel();

    expect(await screen.findByText("Accounts · 1")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Smart balance" })).toBeNull();
    // A five-hour window is still reported, so its switch stays.
    expect(screen.getByRole("switch", { name: "Auto-start 5-hour windows" })).toBeTruthy();
  });

  it("hides the auto-start switch when the provider reports no five-hour window", async () => {
    installBridge({ usage: snapshot({ fiveHour: false }) });
    renderPanel();

    expect(await screen.findByRole("switch", { name: "Smart balance" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Auto-start 5-hour windows" })).toBeNull();
  });

  it("writes the provider's settings when a header switch is flipped", async () => {
    const harness = installBridge();
    renderPanel();

    const toggle = await screen.findByRole("switch", { name: "Smart balance" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(harness.providerInstances.setSettings).toHaveBeenCalledWith({
        provider: "claude",
        settings: { smartBalance: true },
      });
    });
  });

  it("explains each switch on hover", async () => {
    installBridge();
    renderPanel();

    const hint = await screen.findByRole("button", { name: "About Smart balance" });
    fireEvent.mouseEnter(hint);
    // The hover shows the switch's own explanation; its wording is not pinned.
    const text = (screen.getByRole("tooltip").textContent ?? "").trim();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe("Smart balance");
  });

  it("hangs a hint from the right edge when the left edge would push it off screen", async () => {
    installBridge();
    renderPanel();

    const hint = await screen.findByRole("button", { name: "About Smart balance" });
    // The switches live in a right-aligned header, so the anchor sits close to
    // the window edge on a normal window.
    const anchor = hint.parentElement as HTMLElement;
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      left: window.innerWidth - 40,
      right: window.innerWidth - 26,
      top: 0,
      bottom: 14,
      width: 14,
      height: 14,
      x: window.innerWidth - 40,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseEnter(hint);
    const tooltip = screen.getByRole("tooltip") as HTMLElement;
    expect(tooltip.style.right).toBe("0px");
    expect(tooltip.style.left).toBe("");
  });

  it("hangs a hint from the left edge when there is room for it", async () => {
    installBridge();
    renderPanel();

    const hint = await screen.findByRole("button", { name: "About Smart balance" });
    const anchor = hint.parentElement as HTMLElement;
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      left: 10,
      right: 24,
      top: 0,
      bottom: 14,
      width: 14,
      height: 14,
      x: 10,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseEnter(hint);
    const tooltip = screen.getByRole("tooltip") as HTMLElement;
    expect(tooltip.style.left).toBe("0px");
    expect(tooltip.style.right).toBe("");
  });

  it("selects an account when its row is clicked, turning smart balance off first", async () => {
    const harness = installBridge({ smartBalance: true });
    renderPanel();

    const work = await screen.findByRole("group", { name: "Work account" });
    fireEvent.click(work);

    await waitFor(() => {
      expect(harness.providerInstances.setSettings).toHaveBeenCalledWith({
        provider: "claude",
        settings: { smartBalance: false },
      });
    });
    await waitFor(() => {
      expect(harness.providerInstances.setDefault).toHaveBeenCalledWith({ id: "claude-work" });
    });
  });

  it("cannot select an account whose saved login stopped working", async () => {
    const broken = instance({
      id: "claude-broken",
      label: "Broken",
      signedIn: false,
      loginBroken: true,
      account: { email: "arul@old.com" },
    });
    const harness = installBridge({ instances: [DEFAULT_INSTANCE, broken] });
    renderPanel();

    const row = await screen.findByRole("group", { name: "Broken account" });
    expect(within(row).getByText("arul@old.com")).toBeTruthy();
    expect(within(row).getByText("Signed out")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Sign in" })).toBeTruthy();

    fireEvent.click(row);
    expect(harness.providerInstances.setDefault).not.toHaveBeenCalled();
    expect(harness.providerInstances.setSettings).not.toHaveBeenCalled();
  });

  it("dismisses a row menu on Escape and on a click elsewhere, and never stacks two", async () => {
    installBridge();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Personal account actions" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Personal account actions" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);

    // A second row's menu must replace the first, not sit on top of it.
    fireEvent.mouseDown(screen.getByRole("button", { name: "Work account actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Work account actions" }));
    await waitFor(() => {
      expect(screen.getAllByRole("menu")).toHaveLength(1);
    });
    expect(screen.getByRole("menu", { name: "Work account actions" })).toBeTruthy();

    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("renames an account from its row menu", async () => {
    const harness = installBridge();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Work account actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    const field = screen.getByRole("textbox", { name: "Rename Work" });
    fireEvent.change(field, { target: { value: "Acme" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => {
      expect(harness.providerInstances.rename).toHaveBeenCalledWith({ id: "claude-work", label: "Acme" });
    });
  });

  it("confirms before removing, and removes nothing when the confirm is cancelled", async () => {
    const harness = installBridge();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Work account actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));

    expect(await screen.findByText("Remove account")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(harness.providerInstances.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Work account actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "REMOVE" }));

    await waitFor(() => {
      expect(harness.providerInstances.remove).toHaveBeenCalledWith({ id: "claude-work" });
    });
  });

  it("shows the store's sentence without the Electron IPC wrapper around it", async () => {
    const harness = installBridge();
    harness.providerInstances.rename.mockRejectedValue(
      new Error(
        "Error invoking remote method 'ade.localRuntime.callAction': Error: A provider account label is at most 60 characters.",
      ),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Work account actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Work" });
    fireEvent.change(input, { target: { value: "Z".repeat(70) } });
    fireEvent.keyDown(input, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("A provider account label is at most 60 characters.");
    expect(alert.textContent).not.toContain("invoking remote method");
  });

  it("creates the account, runs the host's sign-in, and reports the signed-in email", async () => {
    const harness = installBridge();
    harness.providerInstances.loginStart.mockResolvedValue(
      loginStatus({ state: "succeeded", email: "arul@acme.com" }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a Claude Code account" });
    expect(within(sheet).getByText("Your other accounts stay signed in")).toBeTruthy();

    const start = within(sheet).getByRole("button", { name: "Continue to sign-in" });
    expect(start.hasAttribute("disabled")).toBe(true);

    fireEvent.change(within(sheet).getByRole("textbox", { name: "Account label" }), {
      target: { value: "Work" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to sign-in" }));

    await waitFor(() => {
      expect(harness.providerInstances.create).toHaveBeenCalledWith({
        provider: "claude",
        label: "Work",
      });
    });
    await waitFor(() => {
      expect(harness.providerInstances.loginStart).toHaveBeenCalledWith({ id: "claude-new" });
    });

    expect(await screen.findByText("Work is signed in")).toBeTruthy();
    expect(within(sheet).getByText("arul@acme.com")).toBeTruthy();
    await waitFor(() => {
      expect(harness.providerInstances.refresh).toHaveBeenCalledWith({
        provider: "claude",
        instanceId: "claude-new",
      });
    });
  });

  it("offers a retry when the host reports the login failed", async () => {
    const harness = installBridge();
    harness.providerInstances.loginStart.mockResolvedValue(
      loginStatus({ state: "failed", message: "The sign-in stopped (exit code 1)." }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a Claude Code account" });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Account label" }), {
      target: { value: "Work" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to sign-in" }));

    expect(await screen.findByText("Sign-in did not complete.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("restarts the sign-in from the failed sheet without creating a second account", async () => {
    const harness = installBridge();
    harness.providerInstances.loginStart
      .mockResolvedValueOnce(loginStatus({ state: "failed", message: "No login was saved." }))
      .mockResolvedValueOnce(loginStatus({ state: "succeeded", email: "arul@acme.com" }));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a Claude Code account" });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Account label" }), {
      target: { value: "Work" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to sign-in" }));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(harness.providerInstances.loginStart).toHaveBeenCalledTimes(2);
    });
    expect(harness.providerInstances.loginStart).toHaveBeenLastCalledWith({ id: "claude-new" });
    expect(harness.providerInstances.create).toHaveBeenCalledTimes(1);
  });

  it("reopens sign-in for an existing account without creating a new one", async () => {
    const harness = installBridge({
      instances: [instance({ id: "claude", label: "Personal", isDefault: true, signedIn: false })],
    });
    harness.providerInstances.loginStart.mockResolvedValue(
      loginStatus({ instanceId: "claude", state: "succeeded", email: "arul@gmail.com" }),
    );
    renderPanel();

    const row = await screen.findByRole("group", { name: "Personal account" });
    fireEvent.click(within(row).getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("dialog", { name: "Sign in to Personal" })).toBeTruthy();
    await waitFor(() => {
      expect(harness.providerInstances.loginStart).toHaveBeenCalledWith({ id: "claude" });
    });
    expect(harness.providerInstances.create).not.toHaveBeenCalled();
    expect(await screen.findByText("Personal is signed in")).toBeTruthy();
  });

  /**
   * Accounts, API keys and Models are one column on a provider's page, and
   * they used to have three different header heights and their primary action
   * in three different places — Add account alone at the bottom right, Add in
   * the API-keys header, a search field where the others had a button. Add
   * belongs with the other panels' actions, in the header.
   */
  it("puts Add account in the panel header, like every other panel's action", async () => {
    installBridge();
    const { container } = renderPanel();
    const add = await screen.findByRole("button", { name: "Add account" });
    const actions = container.querySelector("[data-provider-panel-actions]");
    expect(actions).toBeTruthy();
    expect(actions!.contains(add)).toBe(true);
    expect(add.closest("header")).toBeTruthy();
  });

  it("renders nothing when the host has no provider account registry", async () => {
    (globalThis.window as unknown as { ade: unknown }).ade = {
      usage: { getSnapshot: vi.fn().mockResolvedValue(null), onUpdate: vi.fn(() => () => {}) },
      app: { onProjectBindingChanged: vi.fn(() => () => {}) },
    };
    const { container } = renderPanel();
    await waitFor(() => {
      expect(container.querySelector("section")).toBeNull();
    });
  });
});
