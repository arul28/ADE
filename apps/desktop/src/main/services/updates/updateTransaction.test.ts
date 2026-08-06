import { describe, expect, it, vi } from "vitest";
import {
  runUpdateTransaction,
  UPDATE_TRANSACTION_FAILURE_COPY,
  type UpdateTransactionDeps,
  type UpdateTransactionStepId,
} from "./updateTransaction";

function deps(overrides: Partial<UpdateTransactionDeps> = {}): UpdateTransactionDeps {
  return {
    installedVersion: "1.2.56",
    expectedVersion: "1.2.56",
    reinstallService: async () => ({ ok: true, detail: "installed" }),
    restartService: async () => ({ ok: true, detail: "restarted" }),
    checkHealth: async () => ({ ok: true, version: "1.2.56", detail: "" }),
    ...overrides,
  };
}

function statusOf(
  steps: { id: UpdateTransactionStepId; status: string }[],
  id: UpdateTransactionStepId,
): string | undefined {
  return steps.find((step) => step.id === id)?.status;
}

describe("runUpdateTransaction", () => {
  it("reports every step ok when the swap, service, restart, and health all land", async () => {
    const result = await runUpdateTransaction(deps());

    expect(result.ok).toBe(true);
    expect(result.failureMessage).toBeNull();
    expect(result.version).toBe("1.2.56");
    expect(result.steps.map((step) => step.id)).toEqual(["swap", "service", "restart", "health"]);
    expect(result.steps.every((step) => step.status === "ok")).toBe(true);
  });

  it("fails the swap step when the app relaunched on the old version", async () => {
    const reinstallService = vi.fn();
    const result = await runUpdateTransaction(deps({
      installedVersion: "1.2.55",
      expectedVersion: "1.2.56",
      reinstallService,
    }));

    expect(result.ok).toBe(false);
    expect(result.failureMessage).toBe(UPDATE_TRANSACTION_FAILURE_COPY.swap);
    expect(statusOf(result.steps, "swap")).toBe("failed");
    // Nothing downstream is attempted once the app itself did not change.
    expect(reinstallService).not.toHaveBeenCalled();
    expect(statusOf(result.steps, "service")).toBe("skipped");
    expect(statusOf(result.steps, "restart")).toBe("skipped");
    expect(statusOf(result.steps, "health")).toBe("skipped");
  });

  it("names the service step when the background service could not be set up", async () => {
    const restartService = vi.fn();
    const result = await runUpdateTransaction(deps({
      reinstallService: async () => ({ ok: false, detail: "launchctl bootstrap failed" }),
      restartService,
    }));

    expect(result.ok).toBe(false);
    expect(result.failureMessage).toBe(
      "Updated the app, but the background service couldn't be set up — click Repair.",
    );
    expect(statusOf(result.steps, "swap")).toBe("ok");
    expect(result.steps.find((step) => step.id === "service")).toEqual({
      id: "service",
      status: "failed",
      detail: "launchctl bootstrap failed",
    });
    expect(restartService).not.toHaveBeenCalled();
    expect(statusOf(result.steps, "restart")).toBe("skipped");
  });

  it("produces the restart line verbatim when the service did not come back", async () => {
    const result = await runUpdateTransaction(deps({
      restartService: async () => ({ ok: false, detail: "endpoint never rebound" }),
    }));

    expect(result.ok).toBe(false);
    expect(result.failureMessage).toBe(
      "Updated the app, but the background service didn't restart — click Repair.",
    );
    expect(statusOf(result.steps, "restart")).toBe("failed");
    expect(statusOf(result.steps, "health")).toBe("skipped");
  });

  it("names the health step when the restarted service does not answer", async () => {
    const result = await runUpdateTransaction(deps({
      checkHealth: async () => ({ ok: false, version: null, detail: "No answer at /tmp/ade.sock." }),
    }));

    expect(result.ok).toBe(false);
    expect(result.failureMessage).toBe(
      "Updated the app, but the background service isn't answering — click Repair.",
    );
    expect(result.steps.find((step) => step.id === "health")).toEqual({
      id: "health",
      status: "failed",
      detail: "No answer at /tmp/ade.sock.",
    });
  });

  it("turns a thrown dependency into a failed step instead of rejecting", async () => {
    const result = await runUpdateTransaction(deps({
      restartService: async () => {
        throw new Error("Recovery is already running.");
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.failureMessage).toBe(UPDATE_TRANSACTION_FAILURE_COPY.restart);
    expect(result.steps.find((step) => step.id === "restart")).toEqual({
      id: "restart",
      status: "failed",
      detail: "Recovery is already running.",
    });
  });

  it("fails the swap step when the running version cannot be read", async () => {
    const result = await runUpdateTransaction(deps({ installedVersion: "  " }));

    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.failureMessage).toBe(UPDATE_TRANSACTION_FAILURE_COPY.swap);
  });

  it("accepts any installed version when no expected version is known", async () => {
    const result = await runUpdateTransaction(deps({ expectedVersion: null }));

    expect(result.ok).toBe(true);
    expect(statusOf(result.steps, "swap")).toBe("ok");
  });
});
