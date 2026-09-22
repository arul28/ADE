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
import type { ProviderInstance } from "../../../../../shared/types/providerInstances";
import type { PtyExitEvent, UsageSnapshot } from "../../../../../shared/types";
import { ProviderAccountsPanel } from "./ProviderAccountsPanel";

vi.mock("../../../terminals/TerminalView", () => ({
  TerminalView: ({ ptyId }: { ptyId: string }) => <div data-testid="terminal-view">{ptyId}</div>,
}));

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

function snapshot(options?: { fiveHour?: boolean }): UsageSnapshot {
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
  };
}

type Harness = {
  providerInstances: Record<string, ReturnType<typeof vi.fn>>;
  pty: Record<string, ReturnType<typeof vi.fn>>;
  emitPtyExit: (event: PtyExitEvent) => void;
};

function installBridge(options?: {
  instances?: ProviderInstance[];
  usage?: UsageSnapshot;
  smartBalance?: boolean;
}): Harness {
  const list = options?.instances ?? [DEFAULT_INSTANCE, WORK_INSTANCE];
  let exitListener: ((event: PtyExitEvent) => void) | null = null;

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
    getSettings: vi.fn().mockResolvedValue({
      smartBalance: options?.smartBalance ?? false,
      autoStartWindows: false,
    }),
    setSettings: vi.fn().mockResolvedValue({ smartBalance: true, autoStartWindows: false }),
    loginCommand: vi.fn().mockResolvedValue({ command: "claude", args: ["/login"], env: {} }),
    refresh: vi.fn().mockResolvedValue([
      instance({ id: "claude-new", label: "Work", signedIn: true, account: { email: "arul@acme.com" } }),
    ]),
  };

  const pty = {
    create: vi.fn().mockResolvedValue({ ptyId: "pty-1", sessionId: "session-1", pid: 42 }),
    dispose: vi.fn().mockResolvedValue({ disposed: true, reason: "disposed" }),
    onExit: vi.fn((cb: (event: PtyExitEvent) => void) => {
      exitListener = cb;
      return () => {
        if (exitListener === cb) exitListener = null;
      };
    }),
  };

  (globalThis.window as unknown as { ade: unknown }).ade = {
    providerInstances,
    pty,
    lanes: {
      list: vi.fn().mockResolvedValue([{ id: "lane-1", laneType: "primary" }]),
    },
    usage: {
      getSnapshot: vi.fn().mockResolvedValue(options?.usage ?? snapshot()),
      onUpdate: vi.fn(() => () => {}),
    },
    app: {
      onProjectBindingChanged: vi.fn(() => () => {}),
    },
  };

  return {
    providerInstances,
    pty,
    emitPtyExit: (event) => exitListener?.(event),
  };
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

  it("renders one row per instance with its identity, usage, and default marker", async () => {
    installBridge();
    renderPanel();

    expect(await screen.findByText("Accounts · 2")).toBeTruthy();

    const personal = await screen.findByRole("group", { name: "Personal account" });
    expect(within(personal).getByText("arul@gmail.com · Max")).toBeTruthy();
    expect(within(personal).getByText("5h 15% · wk 28% left")).toBeTruthy();
    expect(within(personal).getByText("Default")).toBeTruthy();

    const work = screen.getByRole("group", { name: "Work account" });
    expect(within(work).getByText("arul@acme.com · Team")).toBeTruthy();
    expect(within(work).getByText("5h 0% · wk 8% left")).toBeTruthy();
    expect(within(work).queryByText("Default")).toBeNull();
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
    expect(screen.getByRole("tooltip").textContent).toContain(
      "picks the account with the most room when a chat starts",
    );
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

  it("promotes an account to default from its row menu", async () => {
    const harness = installBridge();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Work account actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Set as default" }));

    await waitFor(() => {
      expect(harness.providerInstances.setDefault).toHaveBeenCalledWith({ id: "claude-work" });
    });
  });

  it("does not offer to make the default account the default again", async () => {
    installBridge();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Personal account actions" }));
    expect(screen.queryByRole("menuitem", { name: "Set as default" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
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

  it("stores a new accent picked from the row menu's swatches", async () => {
    const harness = installBridge();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Work account actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Change accent" }));
    fireEvent.click(screen.getByRole("button", { name: "Accent #a78bfa" }));

    await waitFor(() => {
      expect(harness.providerInstances.setAccent).toHaveBeenCalledWith({
        id: "claude-work",
        accentColor: "#a78bfa",
      });
    });
  });

  it("confirms before removing, and removes nothing when the confirm is cancelled", async () => {
    const harness = installBridge();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Work account actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));

    expect(await screen.findByText("Remove account")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "CANCEL" }));
    expect(harness.providerInstances.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Work account actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "REMOVE" }));

    await waitFor(() => {
      expect(harness.providerInstances.remove).toHaveBeenCalledWith({ id: "claude-work" });
    });
  });

  it("surfaces the store's own refusal when a remove is not allowed", async () => {
    const harness = installBridge();
    harness.providerInstances.remove.mockRejectedValue(
      new Error("The default account cannot be removed. Make another account the default first."),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Personal account actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "REMOVE" }));

    expect(
      await screen.findByText(
        "The default account cannot be removed. Make another account the default first.",
      ),
    ).toBeTruthy();
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

  it("creates the account, runs its login in a PTY, and reports the signed-in email", async () => {
    const harness = installBridge();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a Claude Code account" });
    expect(
      within(sheet).getByText("This account gets its own sign-in. Your other accounts are not touched."),
    ).toBeTruthy();

    const signIn = within(sheet).getByRole("button", { name: "Sign in →" });
    expect(signIn.hasAttribute("disabled")).toBe(true);

    fireEvent.change(within(sheet).getByRole("textbox", { name: "Account label" }), {
      target: { value: "Work" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Sign in →" }));

    await waitFor(() => {
      expect(harness.providerInstances.create).toHaveBeenCalledWith({
        provider: "claude",
        label: "Work",
        accentColor: expect.any(String),
      });
    });

    await waitFor(() => {
      expect(harness.pty.create).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          tracked: false,
          command: "claude",
          args: ["/login"],
          env: { CLAUDE_CONFIG_DIR: "/home/claude-new" },
        }),
      );
    });

    expect(await screen.findByTestId("terminal-view")).toBeTruthy();
    expect(screen.getByText("Waiting for sign-in…")).toBeTruthy();

    harness.emitPtyExit({ ptyId: "pty-1", sessionId: "session-1", exitCode: 0 });

    await waitFor(() => {
      expect(harness.providerInstances.refresh).toHaveBeenCalledWith({ provider: "claude" });
    });
    expect(await screen.findByText("arul@acme.com")).toBeTruthy();
  });

  it("offers a retry when the login exits without writing credentials", async () => {
    const harness = installBridge();
    harness.providerInstances.refresh.mockResolvedValue([
      instance({ id: "claude-new", label: "Work", signedIn: false }),
    ]);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a Claude Code account" });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Account label" }), {
      target: { value: "Work" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Sign in →" }));
    await screen.findByTestId("terminal-view");

    harness.emitPtyExit({ ptyId: "pty-1", sessionId: "session-1", exitCode: 1 });

    expect(await screen.findByText("Sign-in did not complete.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("re-reads the registry once when Check again is used, without polling", async () => {
    const harness = installBridge();
    harness.providerInstances.refresh.mockResolvedValue([
      instance({ id: "claude-new", label: "Work", signedIn: false }),
    ]);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a Claude Code account" });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Account label" }), {
      target: { value: "Work" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Sign in →" }));
    await screen.findByTestId("terminal-view");

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => {
      expect(harness.providerInstances.refresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Waiting for sign-in…")).toBeTruthy();
  });

  it("reopens sign-in straight into a terminal for an existing account", async () => {
    const harness = installBridge({
      instances: [instance({ id: "claude", label: "Personal", isDefault: true, signedIn: false })],
    });
    renderPanel();

    const row = await screen.findByRole("group", { name: "Personal account" });
    fireEvent.click(within(row).getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(harness.providerInstances.loginCommand).toHaveBeenCalledWith({ id: "claude" });
    });
    expect(harness.providerInstances.create).not.toHaveBeenCalled();
    expect(await screen.findByTestId("terminal-view")).toBeTruthy();
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
