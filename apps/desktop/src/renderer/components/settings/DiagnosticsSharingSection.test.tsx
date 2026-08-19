/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  DiagnosticsManualSendResult,
  DiagnosticsSharingStatus,
} from "../../../shared/types/diagnostics";
import { DiagnosticsSharingSection } from "./DiagnosticsSharingSection";

/**
 * The always-available way to send a report.
 *
 * Every other "Report issue" button in the app sits on a screen that has
 * already broken, so a user whose app merely feels wrong had nowhere to press —
 * while this very section told them ADE sends "the same report the Report issue
 * button makes". What is tested here is that the promise is now true and that
 * every refusal says something a person can act on.
 */

const SHARING_ON: DiagnosticsSharingStatus = {
  enabled: true,
  sendsInWindow: 0,
  limit: 3,
  manualSendsInWindow: 0,
  manualLimit: 5,
};

function mountSection(overrides: {
  sharing?: DiagnosticsSharingStatus;
  sendManual?: () => Promise<DiagnosticsManualSendResult>;
  revealReport?: (reportPath: string) => Promise<void>;
  omitSendManual?: boolean;
}) {
  const sendManual = overrides.sendManual
    ?? (async () => ({ ok: true as const, reference: "abcd1234", reportPath: "/tmp/report.md" }));
  const revealReport = overrides.revealReport ?? (async () => undefined);
  (window as unknown as { ade?: unknown }).ade = {
    diagnostics: {
      getSharing: async () => overrides.sharing ?? SHARING_ON,
      setSharing: async () => overrides.sharing ?? SHARING_ON,
      revealReport,
      ...(overrides.omitSendManual ? {} : { sendManual }),
    },
  };
  return { ...render(<DiagnosticsSharingSection />), sendManual, revealReport };
}

async function pressSend() {
  const button = await screen.findByRole("button", { name: "Send a report to ADE" });
  fireEvent.click(button);
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
  it("sends, names the reference, and offers to show exactly what was sent", async () => {
    const revealReport = vi.fn(async () => undefined);
    mountSection({ revealReport });

    await pressSend();

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Report sent. Reference abcd1234");
    // Same affordance the auto-send toast offers: the user can read the bytes
    // that left their computer.
    fireEvent.click(screen.getByRole("button", { name: "View report" }));
    expect(revealReport).toHaveBeenCalledWith("/tmp/report.md");
  });

  it("says something different for each refusal, and never a status code", async () => {
    const cases: Array<[DiagnosticsManualSendResult, string]> = [
      [
        { ok: false, reason: "local_limit", limit: 5 },
        "You've already sent 5 reports from this computer today. Try again tomorrow.",
      ],
      // The two 429s the account directory answers with are deliberately
      // distinguishable, and they are two different situations to a user: one
      // is about them, the other is not.
      [
        { ok: false, reason: "rate_limited" },
        "You've already sent several reports today. Try again tomorrow.",
      ],
      [
        { ok: false, reason: "unavailable" },
        "ADE isn't accepting reports right now. Try again later.",
      ],
      [
        { ok: false, reason: "failed" },
        "ADE couldn't send the report. Check your connection and try again.",
      ],
    ];

    for (const [result, copy] of cases) {
      mountSection({ sendManual: async () => result });
      await pressSend();
      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toContain(copy);
      });
      for (const text of ["429", "503", "status"]) {
        expect(screen.getByRole("status").textContent).not.toContain(text);
      }
      cleanup();
    }
  });

  it("says out loud that a click does not turn automatic reports back on", async () => {
    mountSection({ sharing: { ...SHARING_ON, enabled: false } });

    // The send is still allowed — the toggle governs what ADE does BY ITSELF,
    // and refusing here would leave this user unable to report anything — but
    // it must never read as re-enabling background sharing.
    expect(await screen.findByText(/Automatic reports are off/)).toBeTruthy();
    expect(screen.getByText(/does not turn\s+automatic reports back on/)).toBeTruthy();

    await pressSend();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Report sent");
    });
  });

  it("hides the control on a preload that predates it rather than offering a dead button", async () => {
    mountSection({ omitSendManual: true });

    // The toggle still renders; only the action it cannot perform is absent.
    await screen.findByRole("switch");
    expect(screen.queryByRole("button", { name: "Send a report to ADE" })).toBeNull();
  });
});
