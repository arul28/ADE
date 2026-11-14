/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportIssueButton } from "./ReportIssueButton";
import { closeReportDialog } from "./ReportIssueDialog";

let failureCount = 0;

/**
 * A failure no earlier test has reported. The dialog keeps each failure's sent
 * reference for a while, so a repeated failure would start with the old result.
 */
function newFailure() {
  failureCount += 1;
  return {
    surface: "project_recovery",
    headline: `ADE couldn't open this project (${failureCount})`,
    code: "db_integrity",
    technicalDetail: "sqlite disk image is malformed",
    projectRoot: "/tmp/photon",
  };
}

const REPORT = "# ADE diagnostic report\n\n- Surface: project_recovery\n";

function installBridge(overrides: Record<string, unknown> = {}) {
  const prepareReport = vi.fn().mockResolvedValue({
    ok: true,
    id: "draft-1",
    report: REPORT,
    bytes: REPORT.length,
    expiresAtMs: Date.now() + 600_000,
    noteMaxChars: 2000,
  });
  const sendReport = vi.fn().mockResolvedValue({
    ok: true,
    reference: "abcd1234",
    reportPath: "/tmp/userData/diagnostic-reports/report.md",
  });
  const discardReport = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { ade?: unknown }).ade = {
    diagnostics: { prepareReport, sendReport, discardReport, ...overrides },
  };
  return { prepareReport, sendReport, discardReport };
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /Report this error to ADE/ }));
}

afterEach(() => {
  closeReportDialog();
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ReportIssueButton", () => {
  it("renders nothing when the preload has no diagnostics bridge", () => {
    delete (window as unknown as { ade?: unknown }).ade;
    const { container } = render(<ReportIssueButton context={newFailure()} />);

    expect(container.innerHTML).toBe("");
  });

  it("opens a dialog that previews the report it prepared, and sends nothing", async () => {
    const { prepareReport, sendReport } = installBridge();

    const CONTEXT = newFailure();
    render(<ReportIssueButton context={CONTEXT} />);
    openDialog();

    await waitFor(() => {
      expect(prepareReport).toHaveBeenCalledWith(CONTEXT);
    });
    expect((await screen.findByLabelText("Report text")).textContent).toContain("ADE diagnostic report");
    expect(sendReport).not.toHaveBeenCalled();
  });

  it("cancel discards the prepared report and sends nothing", async () => {
    const { discardReport, sendReport } = installBridge();

    const CONTEXT = newFailure();
    render(<ReportIssueButton context={CONTEXT} />);
    openDialog();
    await screen.findByLabelText("Report text");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(discardReport).toHaveBeenCalledWith("draft-1");
    });
    expect(sendReport).not.toHaveBeenCalled();
  });

  it("send uploads the prepared report by its id and shows the reference", async () => {
    const { sendReport } = installBridge();

    const CONTEXT = newFailure();
    render(<ReportIssueButton context={CONTEXT} />);
    openDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(sendReport).toHaveBeenCalledWith("draft-1", undefined);
    });
    expect((await screen.findAllByText(/abcd1234/)).length).toBeGreaterThan(0);
  });

  it("a failed send shows an alert and offers Try again", async () => {
    installBridge({
      sendReport: vi.fn().mockResolvedValue({ ok: false, reason: "unavailable" }),
    });

    const CONTEXT = newFailure();
    render(<ReportIssueButton context={CONTEXT} />);
    openDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
