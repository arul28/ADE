/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectRecoveryDiagnosis,
  ProjectRepairReport,
} from "../../../shared/types/recovery";
import { useAppStore } from "../../state/appStore";
import { expectNoJargon, JARGON_PATTERN } from "../../../test/jargonGuard";
import { ProjectRecoveryScreen } from "./ProjectRecoveryScreen";
import { settingsRouteFor } from "../settings/settingsManifest";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));

const ROOT = "/tmp/recover-me";

function makeDiagnosis(over: Partial<ProjectRecoveryDiagnosis> = {}): ProjectRecoveryDiagnosis {
  return {
    state: "db_repair_needed",
    code: "db_integrity",
    headline: "This project's index needs a repair",
    body: "ADE can rebuild the project's index. Your files and chats stay where they are.",
    canAutoRepair: true,
    technicalDetail: "sqlite disk image is malformed; socket /tmp/ade.sock is stale",
    ...over,
  };
}

function makeReport(over: Partial<ProjectRepairReport> = {}): ProjectRepairReport {
  return {
    ok: true,
    steps: [
      { id: "check_space", label: "Checking free space", status: "ok" },
      { id: "validate_database", label: "Validating the project index", status: "ok" },
    ],
    dbHealthy: true,
    chatsTotal: 5,
    chatsNeedingAttention: 1,
    filesRemoved: 0,
    ...over,
  };
}

type RecoveryBridge = {
  diagnose?: unknown;
  repair?: unknown;
  onRepairStep?: unknown;
  openBackgroundSettings?: unknown;
};

/**
 * The preload bridge this screen reads. Installed per test rather than once,
 * because most tests care about exactly which calls the screen makes.
 */
function installRecoveryBridge(recovery: RecoveryBridge) {
  globalThis.window.ade = { recovery } as any;
}

function setError(over: Record<string, unknown> = {}) {
  useAppStore.setState({
    projectTransition: null,
    projectTransitionError: {
      code: "db_integrity",
      message: "Project index failed to open (ENOSPC).",
      rootPath: ROOT,
      ...over,
    },
  });
}

describe("ProjectRecoveryScreen", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    navigateMock.mockReset();
    useAppStore.setState({
      projectTransition: null,
      projectTransitionError: null,
      clearProjectTransitionError: vi.fn(),
      switchProjectToPath: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // Restart ADE leaves a stamp that outlives the renderer; one test's click
    // must not change the next test's ladder.
    window.localStorage.clear();
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else globalThis.window.ade = originalAde;
  });

  it("renders the diagnosis headline and body as the hero", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError();

    render(<ProjectRecoveryScreen />);

    await waitFor(() => expect(diagnose).toHaveBeenCalledWith(ROOT));
    expect(await screen.findByText("This project needs a quick fix")).toBeTruthy();
    expect(screen.getByText(/Fix it finishes the job/i)).toBeTruthy();
  });

  it("hides the fix offer when the diagnosis says it can't auto-repair", async () => {
    const diagnose = vi.fn(async () =>
      makeDiagnosis({
        state: "socket_owned_by_other",
        code: "socket_owned_by_other",
        headline: "unused",
        body: "unused",
        canAutoRepair: false,
      }),
    );
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError({ code: "socket_owned_by_other" });

    render(<ProjectRecoveryScreen />);

    await screen.findByText("Another copy of ADE is open");
    expect(screen.queryByRole("button", { name: "Fix it" })).toBeNull();
    // The prerequisite the person owns still shows, and the way forward is to
    // try the open again rather than run a repair that cannot help.
    expect(screen.getByText(/Quit the other copy of ADE/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("waits out a starting background service and reopens the project by itself", async () => {
    vi.useFakeTimers();
    try {
      const starting = makeDiagnosis({
        state: "brain_starting",
        code: "unknown",
        headline: "unused",
        body: "unused",
        canAutoRepair: false,
      });
      const healthy = makeDiagnosis({
        state: "healthy",
        code: "unknown",
        headline: "unused",
        body: "unused",
        canAutoRepair: false,
      });
      const diagnose = vi.fn()
        .mockResolvedValueOnce(starting)
        .mockResolvedValueOnce(starting)
        .mockResolvedValue(healthy);
      const repair = vi.fn();
      installRecoveryBridge({ diagnose, repair, onRepairStep: () => () => {} });
      const switchProjectToPath = vi.fn(async () => {});
      useAppStore.setState({ switchProjectToPath });
      setError({ code: "unknown" });

      render(<ProjectRecoveryScreen />);
      await vi.waitFor(() => {
        expect(screen.getByText("ADE is starting")).toBeTruthy();
      });
      // It says who is doing the work, so the spinner is not the whole story.
      expect(screen.getByText(/Waiting for ADE/)).toBeTruthy();
      // No fix offer while it is merely starting: a fix would restart it.
      expect(screen.queryByRole("button", { name: "Fix it" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      // ...but the way out stays: nobody is pinned on a spinner.
      expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();

      await vi.advanceTimersByTimeAsync(2_100);
      expect(diagnose).toHaveBeenCalledTimes(2);
      expect(switchProjectToPath).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_100);
      await vi.waitFor(() => {
        expect(switchProjectToPath).toHaveBeenCalledWith(ROOT);
      });
      expect(repair).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "provider_thread_missing",
    "provider_resume_failed",
    "continuity_reconstruction_required",
    // The main process classifies this one as unknown_failure/repairable too.
    // The screen used to keep its own list and left it off, so a failed
    // diagnosis turned a repairable project into a dead end.
    "optional_mcp_failed",
  ] as const)("offers fallback repair for %s when diagnosis is unavailable", async (code) => {
    const diagnose = vi.fn(async () => { throw new Error("diagnosis unavailable"); });
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError({ code });

    render(<ProjectRecoveryScreen />);

    expect(await screen.findByRole("button", { name: "Fix it" })).toBeTruthy();
    const details = document.querySelector("details")?.textContent ?? "";
    const visibleText = (document.body.textContent ?? "").replace(details, "");
    expectNoJargon(visibleText);
  });

  it("falls back to the main process's verdict when the diagnosis fails", async () => {
    const diagnose = vi.fn(async () => { throw new Error("diagnosis unavailable"); });
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError({ code: "socket_owned_by_other" });

    render(<ProjectRecoveryScreen />);

    // socket_owned_by_other is the one code the service says it cannot repair,
    // so no fix offer — and the prerequisite the person owns still shows.
    expect(await screen.findByText("Another copy of ADE is open")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix it" })).toBeNull();
    expect(screen.getByText(/Quit the other copy of ADE/)).toBeTruthy();
  });

  it("runs a repair, reveals steps + success report, then re-attempts the open", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    const repair = vi.fn(async () => makeReport());
    installRecoveryBridge({ diagnose, repair });
    setError();
    const retry = useAppStore.getState().switchProjectToPath as ReturnType<typeof vi.fn>;

    render(<ProjectRecoveryScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Fix it" }));
    await waitFor(() => expect(repair).toHaveBeenCalledWith(ROOT));

    // Steps animate in as a checklist.
    expect(await screen.findByText("Checking free space")).toBeTruthy();
    expect(await screen.findByText("Validating the project index")).toBeTruthy();

    // Success card.
    expect(await screen.findByText("Fixed. Opening the project…")).toBeTruthy();
    expect(screen.getByText("4 chats picked up where they left off.")).toBeTruthy();
    expect(screen.getByText(/1 chat needs a look/i)).toBeTruthy();
    expect(screen.getByText("No files were removed.")).toBeTruthy();

    // Re-attempts the failed open after a beat.
    await waitFor(() => expect(retry).toHaveBeenCalledWith(ROOT), { timeout: 3000 });
  });

  it("shows the plain-language next action when a repair fails", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    const repair = vi.fn(async () =>
      makeReport({
        ok: false,
        steps: [
          { id: "check_space", label: "Checking free space", status: "failed" },
        ],
        dbHealthy: null,
        chatsTotal: null,
        chatsNeedingAttention: null,
        failureCode: "disk_full",
        nextAction: "Free up at least 2 GB of space, then try again.",
      }),
    );
    installRecoveryBridge({ diagnose, repair });
    setError();

    render(<ProjectRecoveryScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Fix it" }));

    expect(
      await screen.findByText("Free up at least 2 GB of space, then try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("names a next action when the repair fails without one of its own", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    const repair = vi.fn(async () =>
      makeReport({
        ok: false,
        steps: [{ id: "restart_service", label: "Restarting ADE", status: "failed" }],
        dbHealthy: null,
        chatsTotal: null,
        chatsNeedingAttention: null,
      }),
    );
    installRecoveryBridge({ diagnose, repair });
    const updateRelaunchApp = vi.fn(async () => true);
    (globalThis.window.ade as any).updateRelaunchApp = updateRelaunchApp;
    setError();

    render(<ProjectRecoveryScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Fix it" }));

    // A dead end is the failure mode this screen exists to prevent: with no
    // nextAction from the main process it still names what failed and climbs
    // to the next rung, Restart ADE, instead of telling the person to quit.
    expect(await screen.findByText("ADE's background service still won't start")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart ADE" }));
    expect(updateRelaunchApp).toHaveBeenCalledTimes(1);
  });

  it("keeps raw internals inside the technical fold and off the main surface", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError();

    const { container } = render(<ProjectRecoveryScreen />);
    await screen.findByText("This project needs a quick fix");

    const details = container.querySelector("details");
    const foldText = details?.textContent ?? "";
    const mainText = (document.body.textContent ?? "").replace(foldText, "");

    expect(foldText).toMatch(JARGON_PATTERN);
    expectNoJargon(mainText);
  });

  it("sends the person to System Settings when macOS is blocking ADE", async () => {
    const diagnose = vi.fn(async () =>
      makeDiagnosis({
        state: "background_blocked",
        code: "background_item_blocked",
        headline: "unused",
        body: "unused",
        canAutoRepair: false,
      }),
    );
    const openBackgroundSettings = vi.fn(async () => {});
    installRecoveryBridge({ diagnose, repair: vi.fn(), openBackgroundSettings });
    setError({ code: "background_item_blocked" });

    render(<ProjectRecoveryScreen />);

    await screen.findByText("macOS isn't letting ADE's background service run");
    // No fix can change the switch, so the one offer is the Settings pane.
    expect(screen.queryByRole("button", { name: "Fix it" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));

    expect(openBackgroundSettings).toHaveBeenCalledTimes(1);
  });

  it("navigates to the storage settings tab from See what uses space", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis({
      state: "disk_full",
      code: "disk_full",
      headline: "unused",
      body: "unused",
      canAutoRepair: true,
    }));
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError();
    const clear = useAppStore.getState().clearProjectTransitionError as ReturnType<typeof vi.fn>;

    render(<ProjectRecoveryScreen />);
    await screen.findByText("Your computer is out of space");
    fireEvent.click(screen.getByRole("button", { name: "See what uses space" }));

    // The takeover must exit (clear the error) before navigating, or
    // ProjectTabHost keeps rendering this screen and Settings never shows.
    expect(clear).toHaveBeenCalled();
    // Route comes from the settings manifest, so this assertion follows the
    // storage card if it ever moves tabs instead of pinning a stale literal.
    expect(navigateMock).toHaveBeenCalledWith(settingsRouteFor("storage.usage"));
  });

  it("clears the transition error when Back is pressed", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError();
    const clear = useAppStore.getState().clearProjectTransitionError as ReturnType<typeof vi.fn>;

    render(<ProjectRecoveryScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(clear).toHaveBeenCalled();
  });
});
