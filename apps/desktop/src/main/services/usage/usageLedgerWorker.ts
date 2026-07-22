import type { UsageProvider } from "../../../shared/types";
import { getErrorMessage, isRecord } from "../shared/utils";
import { refreshDynamicTokenPricing } from "./usagePricing";
import {
  scanClaudeLogs,
  scanCodexLogs,
  scanCopilotLogs,
  scanCursorAgentLogs,
  scanCursorLogs,
  scanDroidLogs,
  scanGeminiLogs,
  scanOpenClawLogs,
  scanOpenCodeLogs,
  type TokenEntry,
} from "./ledgers/localUsageLedgers";
import { buildCostSnapshots, bucketDaily7d } from "./usageTrackingService";
import type { UsageLedgerScanResult } from "./usageLedgerWorkerClient";

const WORKER_INPUT_MAX_BYTES = 64 * 1024;

type ProviderScanner = {
  provider: string;
  scan: () => Promise<TokenEntry[]>;
};

const providerScanners: ProviderScanner[] = [
  { provider: "claude", scan: scanClaudeLogs },
  { provider: "codex", scan: scanCodexLogs },
  { provider: "cursor", scan: scanCursorLogs },
  { provider: "cursor-agent", scan: scanCursorAgentLogs },
  { provider: "openclaw", scan: scanOpenClawLogs },
  { provider: "opencode", scan: scanOpenCodeLogs },
  { provider: "droid", scan: scanDroidLogs },
  { provider: "copilot", scan: scanCopilotLogs },
  { provider: "gemini", scan: scanGeminiLogs },
];

async function readInput(): Promise<{ projectRoot: string | null }> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw, "utf8") > WORKER_INPUT_MAX_BYTES) {
      throw new Error("Usage ledger worker input is too large");
    }
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || (parsed.projectRoot !== null && typeof parsed.projectRoot !== "string")) {
    throw new Error("Usage ledger worker input is invalid");
  }
  return { projectRoot: parsed.projectRoot };
}

async function main(): Promise<void> {
  const { projectRoot } = await readInput();
  await refreshDynamicTokenPricing().catch(() => 0);
  const result: UsageLedgerScanResult = {
    costs: [],
    projectCosts: [],
    daily7d: {},
    entryCounts: {},
    providerErrors: {},
  };
  const nowMs = Date.now();

  // Scan and aggregate one provider at a time. The old Promise.all path kept
  // every provider's per-turn ledger objects alive together and pushed a busy
  // ADE runtime into multi-gigabyte peaks. This worker also keeps that work off
  // the runtime's project/chat/sync event loop.
  for (const scanner of providerScanners) {
    let entries: TokenEntry[];
    try {
      entries = await scanner.scan();
    } catch (error) {
      result.providerErrors[scanner.provider] = getErrorMessage(error);
      result.entryCounts[scanner.provider] = 0;
      continue;
    }
    result.entryCounts[scanner.provider] = entries.length;
    const providerEntries = new Map([[scanner.provider, entries]]);
    result.costs.push(...buildCostSnapshots(providerEntries, "machine", projectRoot));
    result.projectCosts.push(...buildCostSnapshots(providerEntries, "project", projectRoot));
    if ((scanner.provider === "claude" || scanner.provider === "codex") && entries.length > 0) {
      result.daily7d[scanner.provider as UsageProvider] = bucketDaily7d(entries, nowMs);
    }
  }

  process.stdout.write(JSON.stringify(result));
}

void main().catch((error) => {
  process.stderr.write(getErrorMessage(error).slice(0, 64 * 1024));
  process.exitCode = 1;
});
