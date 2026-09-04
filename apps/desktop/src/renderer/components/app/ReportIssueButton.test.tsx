/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsManualSendResult } from "../../../shared/types/diagnostics";
import { ReportIssueButton } from "./ReportIssueButton";

/**
 * The button is one press with one answer, and the answer is the contract.
 *
 * Nothing here reaches the clipboard or a browser: the report is built,
 * redacted, budgeted and uploaded in the main process, so what this file pins
 * is that the screen's own failure context goes with the request and that every
 * outcome comes back as a sentence rather than a status code.
 */

const CONTEXT = {
  surface: "project_recovery",
  headline: "ADE couldn't open this project",
  code: "db_integrity",
  technicalDetail: "sqlite disk image is malformed",
  projectRoot: "/tmp/photon",
};

const revealReport = vi.fn();

function installBridge(sendManual: ReturnType<typeof vi.fn> | undefined) {
  (window as unknown as { ade?: unknown }).ade = {
    diagnostics: {
      ...(sendManual ? { sendManual } : {}),
      revealReport,
    },
  };
}

afterEach(() => {
  cleanup();
  revealReport.mockReset();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ReportIssueButton", () => {
  it("renders nothing when the preload has no diagnostics bridge", () => {
    delete (window as unknown as { ade?: unknown }).ade;
    const { container } = render(<ReportIssueButton context={CONTEXT} />);

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when an older preload cannot send a report", () => {
    installBridge(undefined);
    const { container } = render(<ReportIssueButton context={CONTEXT} />);

    expect(container.innerHTML).toBe("");
  });

  it("sends the screen's own failure context to ADE and reads back the reference", async () => {
    const sendManual = vi.fn().mockResolvedValue({
      ok: true,
      reference: "ADE-7QK2",
      reportPath: "/tmp/userData/diagnostic-reports/report.md",
    } satisfies DiagnosticsManualSendResult);
    installBridge(sendManual);

    render(<ReportIssueButton context={CONTEXT} />);
    fireEvent.click(screen.getByRole("button", { name: "Send a report to ADE" }));

    // The whole context, not a surface alone: the code and the technical text
    // are what make a crash report readable, and main is what decides which
    // project's logs go with them.
    await waitFor(() => {
      expect(sendManual).toHaveBeenCalledWith(CONTEXT);
    });
    await screen.findByText(/Report sent\. Reference ADE-7QK2/);
    // The saved copy is offered only through main, never as a path to read.
    fireEvent.click(screen.getByRole("button", { name: "View report" }));
    expect(revealReport).toHaveBeenCalledWith("/tmp/userData/diagnostic-reports/report.md");
  });

  it("names a refusal in one sentence, never a status code", async () => {
    const sendManual = vi.fn().mockResolvedValue({
      ok: false,
      reason: "local_limit",
      limit: 5,
    } satisfies DiagnosticsManualSendResult);
    installBridge(sendManual);

    render(<ReportIssueButton context={CONTEXT} />);
    fireEvent.click(screen.getByRole("button", { name: "Send a report to ADE" }));

    await screen.findByText(/already sent 5 reports from this computer today/i);
    expect(screen.queryByRole("button", { name: "View report" })).toBeNull();
  });

  it("answers a bridge that throws with a named failure rather than a broken screen", async () => {
    const sendManual = vi.fn().mockRejectedValue(new Error("ENOSPC: no space left on device"));
    installBridge(sendManual);

    render(<ReportIssueButton context={CONTEXT} />);
    fireEvent.click(screen.getByRole("button", { name: "Send a report to ADE" }));

    await screen.findByText(/couldn't send the report/i);
    // The raw errno never reaches the user on a screen that is already failing.
    expect(screen.queryByText(/ENOSPC/)).toBeNull();
  });

  it("keeps a second send out while the first is still in flight", async () => {
    let settle: (result: DiagnosticsManualSendResult) => void = () => {};
    const sendManual = vi.fn().mockImplementation(
      () => new Promise<DiagnosticsManualSendResult>((resolve) => { settle = resolve; }),
    );
    installBridge(sendManual);

    render(<ReportIssueButton context={CONTEXT} />);
    fireEvent.click(screen.getByRole("button", { name: "Send a report to ADE" }));
    const button = await screen.findByRole("button", { name: "Sending…" });

    fireEvent.click(button);
    expect(sendManual).toHaveBeenCalledTimes(1);

    settle({ ok: true, reference: "ADE-1", reportPath: "" });
    await screen.findByText(/Reference ADE-1/);
    // No path came back, so nothing offers to open one.
    expect(screen.queryByRole("button", { name: "View report" })).toBeNull();
  });

  it("drops the disclosure inside one-line banners, and keeps it when asked", () => {
    installBridge(vi.fn());
    const { rerender } = render(<ReportIssueButton context={CONTEXT} variant="ghost" />);

    // A ghost button lives in a single-line banner; the fold would turn that
    // strip into a paragraph, so the summary moves to the button's tooltip.
    expect(screen.queryByText("What's in the report?")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Send a report to ADE" }).getAttribute("title"),
    ).toMatch(/Personal details are removed/);

    rerender(<ReportIssueButton context={CONTEXT} variant="ghost" showDisclosure />);
    expect(screen.getByText("What's in the report?")).toBeTruthy();
    // The one sentence that tells the user what is stripped must survive any
    // rewording of the fold above it.
    expect(
      screen.getByText(/File paths, your name, email addresses and any sign-in codes are removed/i),
    ).toBeTruthy();
  });
});
