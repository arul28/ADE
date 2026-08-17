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
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else globalThis.window.ade = originalAde;
  });

  it("renders the diagnosis headline and body as the hero", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError();

    render(<ProjectRecoveryScreen />);

    await waitFor(() => expect(diagnose).toHaveBeenCalledWith(ROOT));
    expect(await screen.findByText("This project's index needs a repair")).toBeTruthy();
    expect(screen.getByText(/rebuild the project's index/i)).toBeTruthy();
  });

  it("hides Repair ADE when the diagnosis says it can't auto-repair", async () => {
    const diagnose = vi.fn(async () =>
      makeDiagnosis({
        state: "socket_owned_by_other",
        code: "socket_owned_by_other",
        headline: "Another window is using this project",
        body: "Close the other ADE window, then try again.",
        canAutoRepair: false,
      }),
    );
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError({ code: "socket_owned_by_other" });

    render(<ProjectRecoveryScreen />);

    await screen.findByText("Another window is using this project");
    expect(screen.queryByRole("button", { name: "Repair ADE" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review storage" })).toBeTruthy();
  });

  it("waits out a starting background service and reopens the project by itself", async () => {
    vi.useFakeTimers();
    try {
      const starting = makeDiagnosis({
        state: "brain_starting",
        code: "unknown",
        headline: "ADE's background service is starting.",
        body: "This can take a minute the first time. ADE will open the project as soon as it's ready.",
        canAutoRepair: false,
      });
      const healthy = makeDiagnosis({
        state: "healthy",
        code: "unknown",
        headline: "ADE is ready to open this project.",
        body: "No repair is needed.",
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
        expect(screen.getByText("ADE's background service is starting.")).toBeTruthy();
      });
      expect(screen.getByText(/Waiting for the background service/)).toBeTruthy();
      // It says who is doing the work, so the spinner is not the whole story,
      // without restating the body sentence above it.
      expect(screen.getByText(/ADE keeps\s+checking and opens the project on its own/)).toBeTruthy();
      // No Repair offer while it is merely starting: Repair would restart it.
      expect(screen.queryByRole("button", { name: "Repair ADE" })).toBeNull();
      // ...but the ways out stay: nobody is pinned on a spinner.
      expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Review storage" })).toBeTruthy();

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

    expect(await screen.findByRole("button", { name: "Repair ADE" })).toBeTruthy();
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
    // so no Repair offer — and the prerequisite the person owns still shows.
    expect(await screen.findByText("Another window is using this project")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair ADE" })).toBeNull();
    expect(screen.getByText("What to do")).toBeTruthy();
    expect(screen.getByText(/Quit the other copy of ADE/)).toBeTruthy();
  });

  it("runs a repair, reveals steps + success report, then re-attempts the open", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    const repair = vi.fn(async () => makeReport());
    installRecoveryBridge({ diagnose, repair });
    setError();
    const retry = useAppStore.getState().switchProjectToPath as ReturnType<typeof vi.fn>;

    render(<ProjectRecoveryScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Repair ADE" }));
    await waitFor(() => expect(repair).toHaveBeenCalledWith(ROOT));

    // Steps animate in as a checklist.
    expect(await screen.findByText("Checking free space")).toBeTruthy();
    expect(await screen.findByText("Validating the project index")).toBeTruthy();

    // Success report.
    expect(await screen.findByText(/ADE repaired the project and reopened it/i)).toBeTruthy();
    expect(screen.getByText("Project database: healthy")).toBeTruthy();
    expect(screen.getByText("4 chats resumed normally")).toBeTruthy();
    expect(screen.getByText(/1 chat needs your/i)).toBeTruthy();
    expect(screen.getByText(/No project files were removed/i)).toBeTruthy();

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
    fireEvent.click(await screen.findByRole("button", { name: "Repair ADE" }));

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
    setError();

    render(<ProjectRecoveryScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Repair ADE" }));

    // A dead end is the failure mode this screen exists to prevent: with no
    // nextAction from the main process it still says what to do next.
    expect(await screen.findByText("What to do next")).toBeTruthy();
    expect(screen.getByText(/Try the repair once more/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("keeps raw internals inside the technical fold and off the main surface", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError();

    const { container } = render(<ProjectRecoveryScreen />);
    await screen.findByText("This project's index needs a repair");

    const details = container.querySelector("details");
    const foldText = details?.textContent ?? "";
    const mainText = (document.body.textContent ?? "").replace(foldText, "");

    expect(foldText).toMatch(JARGON_PATTERN);
    expectNoJargon(mainText);
  });

  it("navigates to the storage settings tab from Review storage", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    installRecoveryBridge({ diagnose, repair: vi.fn() });
    setError();
    const clear = useAppStore.getState().clearProjectTransitionError as ReturnType<typeof vi.fn>;

    render(<ProjectRecoveryScreen />);
    await screen.findByText("This project's index needs a repair");
    fireEvent.click(screen.getByRole("button", { name: "Review storage" }));

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
