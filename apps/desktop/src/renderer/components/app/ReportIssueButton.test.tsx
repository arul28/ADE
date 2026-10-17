/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticReportPayload } from "../../../shared/types/diagnostics";
import { ReportIssueButton } from "./ReportIssueButton";

const CONTEXT = {
  surface: "project_recovery",
  headline: "ADE couldn't open this project",
  code: "db_integrity",
  technicalDetail: "sqlite disk image is malformed",
  projectRoot: "/tmp/photon",
};

function payload(over: Partial<DiagnosticReportPayload> = {}): DiagnosticReportPayload {
  return {
    report: "# ADE diagnostic report\n\n- Surface: project_recovery\n",
    filePath: "/tmp/userData/diagnostic-reports/report.md",
    issueUrl: "https://github.com/arul28/ADE/issues/new?title=x",
    installId: "ade_0123456789abcdef0123456789abcdef",
    copied: true,
    opened: true,
    ...over,
  };
}

function installBridge(openIssue: ReturnType<typeof vi.fn>, sendManual?: ReturnType<typeof vi.fn>) {
  (window as unknown as { ade?: unknown }).ade = {
    diagnostics: { openIssue, ...(sendManual ? { sendManual } : {}) },
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ReportIssueButton", () => {
  it("renders nothing when the preload has no diagnostics bridge", () => {
    delete (window as unknown as { ade?: unknown }).ade;
    const { container } = render(<ReportIssueButton context={CONTEXT} />);

    expect(container.innerHTML).toBe("");
  });

  it("sends the caller's context and confirms the report is on the clipboard", async () => {
    const openIssue = vi.fn().mockResolvedValue(payload());
    installBridge(openIssue);

    render(<ReportIssueButton context={CONTEXT} />);
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    await waitFor(() => {
      expect(openIssue).toHaveBeenCalledWith(CONTEXT);
    });
    await screen.findByText(/Report copied/i);
    expect(screen.getByRole("button", { name: "Copy again" })).toBeTruthy();
  });

  it("says so plainly when the report could not be prepared", async () => {
    const openIssue = vi.fn().mockRejectedValue(new Error("ENOSPC: no space left on device"));
    installBridge(openIssue);

    render(<ReportIssueButton context={CONTEXT} />);
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    await screen.findByText(/couldn't prepare the report/i);
    // The raw errno never reaches the user on a screen that is already failing.
    expect(screen.queryByText(/ENOSPC/)).toBeNull();
  });

  it("ignores a GitHub issue reply that belongs to a report the user already replaced", async () => {
    // "Open GitHub issue" can still be in flight when the user reports again,
    // so its reply can land after a second report was sent. Showing it then
    // would describe the wrong report.
    let settleFirstIssue: (result: DiagnosticReportPayload) => void = () => {};
    const openIssue = vi.fn().mockImplementationOnce(
      () => new Promise<DiagnosticReportPayload>((resolve) => { settleFirstIssue = resolve; }),
    );
    const sendManual = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, reference: "first123", reportPath: "", report: "first report" })
      .mockResolvedValueOnce({ ok: true, reference: "second45", reportPath: "", report: "second report" });
    installBridge(openIssue, sendManual);

    render(<ReportIssueButton context={CONTEXT} />);
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    await screen.findByText(/reference first123/);
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub issue" }));
    await screen.findByRole("button", { name: "Opening…" });

    // A second report, sent while the first issue is still opening.
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    await screen.findByText(/reference second45/);

    settleFirstIssue(payload({ report: "first report" }));

    // The stale reply frees the link again but never lands under the newer report.
    await screen.findByRole("button", { name: "Open GitHub issue" });
    expect(screen.queryByText(/Report copied/)).toBeNull();
  });

  it("drops the disclosure inside one-line banners, and keeps it when asked", () => {
    installBridge(vi.fn());
    const { rerender } = render(<ReportIssueButton context={CONTEXT} variant="ghost" />);

    // A ghost button lives in a single-line banner; the fold would turn that
    // strip into a paragraph, so the summary moves to the button's tooltip.
    expect(screen.queryByText("What's in the report?")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Report issue" }).getAttribute("title"),
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
