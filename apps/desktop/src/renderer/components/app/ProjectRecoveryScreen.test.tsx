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
    globalThis.window.ade = { recovery: { diagnose, repair: vi.fn() } } as any;
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
    globalThis.window.ade = { recovery: { diagnose, repair: vi.fn() } } as any;
    setError({ code: "socket_owned_by_other" });

    render(<ProjectRecoveryScreen />);

    await screen.findByText("Another window is using this project");
    expect(screen.queryByRole("button", { name: "Repair ADE" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review storage" })).toBeTruthy();
  });

  it.each([
    "provider_thread_missing",
    "provider_resume_failed",
    "continuity_reconstruction_required",
  ] as const)("offers fallback repair for %s when diagnosis is unavailable", async (code) => {
    const diagnose = vi.fn(async () => { throw new Error("diagnosis unavailable"); });
    globalThis.window.ade = { recovery: { diagnose, repair: vi.fn() } } as any;
    setError({ code });

    render(<ProjectRecoveryScreen />);

    expect(await screen.findByRole("button", { name: "Repair ADE" })).toBeTruthy();
    const details = document.querySelector("details")?.textContent ?? "";
    const visibleText = (document.body.textContent ?? "").replace(details, "");
    expectNoJargon(visibleText);
  });

  it("runs a repair, reveals steps + success report, then re-attempts the open", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    const repair = vi.fn(async () => makeReport());
    globalThis.window.ade = { recovery: { diagnose, repair } } as any;
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
    globalThis.window.ade = { recovery: { diagnose, repair } } as any;
    setError();

    render(<ProjectRecoveryScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Repair ADE" }));

    expect(
      await screen.findByText("Free up at least 2 GB of space, then try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("keeps raw internals inside the technical fold and off the main surface", async () => {
    const diagnose = vi.fn(async () => makeDiagnosis());
    globalThis.window.ade = { recovery: { diagnose, repair: vi.fn() } } as any;
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
    globalThis.window.ade = { recovery: { diagnose, repair: vi.fn() } } as any;
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
    globalThis.window.ade = { recovery: { diagnose, repair: vi.fn() } } as any;
    setError();
    const clear = useAppStore.getState().clearProjectTransitionError as ReturnType<typeof vi.fn>;

    render(<ProjectRecoveryScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(clear).toHaveBeenCalled();
  });
});
