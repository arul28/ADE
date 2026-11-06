/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DiagnosticsManualSendResult } from "../../../shared/types/diagnostics";
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

function mountSection(overrides: {
  sendManual?: () => Promise<DiagnosticsManualSendResult>;
  revealReport?: (reportPath: string) => Promise<void>;
  omitSendManual?: boolean;
}) {
  const sendManual = overrides.sendManual
    ?? (async () => ({ ok: true as const, reference: "abcd1234", reportPath: "/tmp/report.md" }));
  const revealReport = overrides.revealReport ?? (async () => undefined);
  (window as unknown as { ade?: unknown }).ade = {
    diagnostics: {
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
    const results: DiagnosticsManualSendResult[] = [
      { ok: false, reason: "local_limit", limit: 5 },
      // The two 429s the account directory answers with are deliberately
      // distinguishable, and they are two different situations to a user: one
      // is about them, the other is not.
      { ok: false, reason: "rate_limited" },
      { ok: false, reason: "unavailable" },
      { ok: false, reason: "failed" },
    ];

    const shown: string[] = [];
    for (const result of results) {
      mountSection({ sendManual: async () => result });
      await pressSend();
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
    // The local copy is written before the upload is attempted, so a `too_large`
    // refusal usually comes back with a path — and then the sentence about
    // opening it is true and the button that does so is there.
    mountSection({
      sendManual: async () => ({ ok: false, reason: "too_large", reportPath: "/tmp/report.md" }),
    });
    await pressSend();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("It's saved on this computer");
    });
    expect(screen.getByRole("button", { name: "View report" })).toBeTruthy();
    cleanup();

    // When the copy could not be written the main process answers without one,
    // and telling this user to open a file sends them looking for something
    // that is not there.
    mountSection({ sendManual: async () => ({ ok: false, reason: "too_large" }) });
    await pressSend();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "This report is too big to send, and ADE couldn't save a copy on this computer.",
      );
    });
    expect(screen.getByRole("status").textContent).not.toContain("It's saved on this computer");
    expect(screen.queryByRole("button", { name: "View report" })).toBeNull();
  });

  it("hides the control on a preload that predates it rather than offering a dead button", () => {
    mountSection({ omitSendManual: true });

    expect(screen.queryByRole("button", { name: "Send a report to ADE" })).toBeNull();
  });
});
