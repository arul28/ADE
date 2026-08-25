/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticReportPayload } from "../../../shared/types/diagnostics";
import type { DiagnosticUploadResult } from "../../../shared/diagnosticsUpload";
import { ReportIssueButton } from "./ReportIssueButton";

const uploadDiagnosticReport = vi.hoisted(() => vi.fn());
vi.mock("../../../shared/diagnosticsUpload", async () => {
  const actual = await vi.importActual<typeof import("../../../shared/diagnosticsUpload")>(
    "../../../shared/diagnosticsUpload",
  );
  return { ...actual, uploadDiagnosticReport };
});

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

function installBridge(openIssue: ReturnType<typeof vi.fn>) {
  (window as unknown as { ade?: unknown }).ade = {
    diagnostics: { openIssue },
  };
}

afterEach(() => {
  cleanup();
  uploadDiagnosticReport.mockReset();
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

  it("ignores an upload result that belongs to a report the user already replaced", async () => {
    // "Report issue" stays enabled while a send is in flight, so the first
    // upload's reply can land after a second report exists. Showing its
    // reference then would point a maintainer at the wrong report.
    const openIssue = vi
      .fn()
      .mockResolvedValueOnce(payload({ report: "first report" }))
      .mockResolvedValueOnce(payload({ report: "second report" }));
    installBridge(openIssue);
    let settleFirstUpload: (result: DiagnosticUploadResult) => void = () => {};
    uploadDiagnosticReport.mockImplementationOnce(
      () => new Promise<DiagnosticUploadResult>((resolve) => { settleFirstUpload = resolve; }),
    );

    render(<ReportIssueButton context={CONTEXT} />);
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    await screen.findByRole("button", { name: "Send to ADE" });
    fireEvent.click(screen.getByRole("button", { name: "Send to ADE" }));
    await screen.findByRole("button", { name: "Sending…" });

    // A second report, generated while the first upload is still open.
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    await waitFor(() => {
      expect(openIssue).toHaveBeenCalledTimes(2);
    });

    settleFirstUpload({ ok: true, id: "abc", reference: "ADE-STALE-REF" });

    // The stale reply frees the Send button again but never claims the newer
    // report was sent.
    await screen.findByRole("button", { name: "Send to ADE" });
    expect(screen.queryByText(/ADE-STALE-REF/)).toBeNull();
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
