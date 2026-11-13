/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DiagnosticsManualSendResult, DiagnosticsPrepareResult } from "../../../shared/types/diagnostics";
import { DiagnosticsSharingSection } from "./DiagnosticsSharingSection";

/**
 * The always-available way to send a report.
 *
 * A press builds the report and shows it; "Send" uploads exactly that text.
 * What is tested here is that the person reads the report before it goes, and
 * that every refusal says something a person can act on.
 */

const PREPARED: DiagnosticsPrepareResult = {
  ok: true,
  id: "draft-1",
  report: "# ADE diagnostic report\n",
  bytes: 24,
  expiresAtMs: Date.now() + 600_000,
  noteMaxChars: 2000,
};

function mountSection(overrides: {
  prepareReport?: () => Promise<DiagnosticsPrepareResult>;
  sendReport?: () => Promise<DiagnosticsManualSendResult>;
  revealReport?: (reportPath: string) => Promise<void>;
  omitBridge?: boolean;
} = {}) {
  const prepareReport = vi.fn(overrides.prepareReport ?? (async () => PREPARED));
  const sendReport = vi.fn(
    overrides.sendReport ?? (async () => ({ ok: true as const, reference: "abcd1234", reportPath: "/tmp/report.md" })),
  );
  const discardReport = vi.fn(async () => undefined);
  const revealReport = vi.fn(overrides.revealReport ?? (async () => undefined));
  (window as unknown as { ade?: unknown }).ade = {
    diagnostics: overrides.omitBridge
      ? { revealReport }
      : { revealReport, prepareReport, sendReport, discardReport },
  };
  return { ...render(<DiagnosticsSharingSection />), prepareReport, sendReport, discardReport, revealReport };
}

/** Presses the first button and waits for the preview with its Send button. */
async function prepareAndReview() {
  fireEvent.click(await screen.findByRole("button", { name: "Send a report to ADE…" }));
  await screen.findByRole("button", { name: "Send" });
}

async function prepareAndSend() {
  await prepareAndReview();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

beforeEach(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("DiagnosticsSharingSection manual send", () => {
  it("shows the report before anything is sent, and Cancel discards it", async () => {
    const { prepareReport, sendReport, discardReport } = mountSection();

    await prepareAndReview();

    expect(prepareReport).toHaveBeenCalledTimes(1);
    expect((await screen.findByLabelText("Report text")).textContent).toContain("ADE diagnostic report");
    expect(sendReport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(discardReport).toHaveBeenCalledWith("draft-1");
    });
    expect(sendReport).not.toHaveBeenCalled();
  });

  it("sends the prepared report by its id, names the reference, and offers to show what was sent", async () => {
    const { sendReport, revealReport } = mountSection();

    await prepareAndSend();

    await waitFor(() => {
      expect(sendReport).toHaveBeenCalledWith("draft-1", undefined);
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Sent. Reference abcd1234");
    // The user can read the bytes that left their computer.
    fireEvent.click(screen.getByRole("button", { name: "View report" }));
    expect(revealReport).toHaveBeenCalledWith("/tmp/report.md");
  });

  it("says something different for each refusal, and never a status code", async () => {
    const results: DiagnosticsManualSendResult[] = [
      { ok: false, reason: "local_limit", limit: 5 },
      // The two 429s are deliberately distinguishable: one is about this person,
      // the other is about ADE.
      { ok: false, reason: "rate_limited" },
      { ok: false, reason: "unavailable" },
      { ok: false, reason: "failed" },
    ];

    const shown: string[] = [];
    for (const result of results) {
      mountSection({ sendReport: async () => result });
      await prepareAndSend();
      const text = (await screen.findByRole("status")).textContent ?? "";
      expect(text.trim(), `a sentence for ${result.ok ? "ok" : result.reason}`).not.toBe("");
      for (const code of ["429", "503", "status"]) expect(text).not.toContain(code);
      shown.push(text);
      cleanup();
    }
    expect(new Set(shown).size).toBe(results.length);
    // The local limit names its own number, so the person knows how many is enough.
    expect(shown[0]).toContain("5");
  });

  it("does not claim a local report copy exists when an oversized report cannot be saved", async () => {
    // A `too_large` refusal with a path means the copy exists, so the button
    // that opens it is there. Without a path the copy was never written.
    mountSection({
      sendReport: async () => ({ ok: false, reason: "too_large", reportPath: "/tmp/report.md" }),
    });
    await prepareAndSend();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "View report" })).toBeTruthy();
    });
    cleanup();

    mountSection({ sendReport: async () => ({ ok: false, reason: "too_large" }) });
    await prepareAndSend();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("too big to send");
    });
    expect(screen.getByRole("status").textContent).not.toContain("is saved on this computer");
    expect(screen.queryByRole("button", { name: "View report" })).toBeNull();
  });

  it("hides the control on a preload that predates it rather than offering a dead button", () => {
    mountSection({ omitBridge: true });

    expect(screen.queryByRole("button", { name: "Send a report to ADE…" })).toBeNull();
  });
});
