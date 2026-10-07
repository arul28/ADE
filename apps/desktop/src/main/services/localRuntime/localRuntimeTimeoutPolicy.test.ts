import { describe, expect, it } from "vitest";
import {
  ACP_PROVIDER_UPDATE_REMOTE_TRANSPORT_TIMEOUT_MS,
  localRuntimeActionTimeoutMs,
  longRunningLocalRuntimeActionTimeoutMs,
} from "./localRuntimeTimeoutPolicy";
import { ACP_PROVIDER_UPDATE_RUN_BUDGET_MS } from "../ai/acpProviderUpdate";

describe("localRuntimeActionTimeoutMs", () => {
  it("gives Cursor Cloud open-chat the same long budget as handoff", () => {
    expect(localRuntimeActionTimeoutMs("ai", "openCursorCloudChat")).toBe(120_000);
    expect(localRuntimeActionTimeoutMs("ai", "createCursorCloudRun")).toBe(120_000);
    expect(localRuntimeActionTimeoutMs("chat", "handoffSession")).toBe(120_000);
  });

  it("keeps the default 30s budget for ordinary actions", () => {
    expect(localRuntimeActionTimeoutMs("ai", "listCursorCloudAgents")).toBe(30_000);
  });

  // A GitHub Stack merge polls GitHub for up to 20s, then cleans up each
  // merged PR. At the 30s default the daemon reported failure while the merge
  // went on, so the action gets a budget that outlives the foreground poll.
  it("lets a stack merge outlive its foreground GitHub poll", () => {
    expect(localRuntimeActionTimeoutMs("pr", "land")).toBe(120_000);
    expect(longRunningLocalRuntimeActionTimeoutMs("pr.land")).toBe(120_000);
  });

  it("outlives a cold simulator launch and a preview build", () => {
    // boot (90s) + xcodebuild (600s) + install (180s) + launch (60s) = 930s
    // all run inside one daemon action, so the budget must exceed that sum.
    // At the 30s default the renderer reported "Remote ADE service timed out"
    // while the build kept going.
    expect(localRuntimeActionTimeoutMs("ios_simulator", "launch")).toBe(17 * 60_000);
    for (const action of ["renderPreview", "renderCurrentPreview", "ensurePreviewWorkspace"]) {
      expect(localRuntimeActionTimeoutMs("ios_simulator", action)).toBe(10 * 60_000);
    }
  });

  it("lets a provider CLI update finish before the transport or the brain gives up on it", () => {
    // The install plus the version re-read run inside one action. The remote
    // transport must outlive it, and the brain's action outlive the transport.
    // (The renderer's IPC budgets are pinned in ipcTimeouts.test.ts.)
    expect(ACP_PROVIDER_UPDATE_REMOTE_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(ACP_PROVIDER_UPDATE_RUN_BUDGET_MS);
    expect(localRuntimeActionTimeoutMs("ai", "acpProviderUpdate")).toBeGreaterThan(ACP_PROVIDER_UPDATE_REMOTE_TRANSPORT_TIMEOUT_MS);
  });

  it("leaves cheap simulator actions on the default budget", () => {
    expect(localRuntimeActionTimeoutMs("ios_simulator", "tap")).toBe(30_000);
    expect(localRuntimeActionTimeoutMs("ios_simulator", "getStatus")).toBe(30_000);
  });
});
