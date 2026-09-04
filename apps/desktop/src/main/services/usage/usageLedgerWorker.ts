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
  runLedgerScanWithCompleteness,
  usageLedgerTranscriptRootExists,
  usageLedgerTranscriptRoots,
  type TokenEntry,
} from "./ledgers/localUsageLedgers";
import { buildCostSnapshots, bucketDaily7d } from "./usageTrackingService";
import {
  LEDGER_STREAM_HEADER_KIND,
  type UsageLedgerProviderChunk,
} from "./usageLedgerWorkerClient";

const WORKER_INPUT_MAX_BYTES = 64 * 1024;

type ProviderScanner = {
  provider: string;
  scan: () => Promise<TokenEntry[]>;
};

/**
 * Exported so a test can hold the slugs here against the keys of
 * `usageLedgerTranscriptRoots()`. A scanner whose slug is not a key there loses
 * its scan-completeness signal, silently.
 */
export const providerScanners: ProviderScanner[] = [
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

async function readInput(): Promise<{ projectRoot: string | null; projectRoots: string[] }> {
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
  const projectRoots = Array.isArray(parsed.projectRoots)
    ? [...new Set(parsed.projectRoots.filter((root): root is string =>
      typeof root === "string" && root.trim().length > 0))]
    : parsed.projectRoot ? [parsed.projectRoot] : [];
  return { projectRoot: parsed.projectRoot, projectRoots };
}

function emit(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const { projectRoot, projectRoots } = await readInput();
  await refreshDynamicTokenPricing().catch(() => 0);
  // The roster first, then one line per provider as it finishes. Buffering all
  // nine and writing a single object at the end meant a timeout — or any
  // failure — discarded every provider that had already succeeded, which on a
  // machine with a large Codex history left the Usage page permanently at zero.
  emit({
    kind: LEDGER_STREAM_HEADER_KIND,
    providers: providerScanners.map((scanner) => scanner.provider),
  });
  const nowMs = Date.now();
  const transcriptRoots = usageLedgerTranscriptRoots();

  // Scan and aggregate one provider at a time. The old Promise.all path kept
  // every provider's per-turn ledger objects alive together and pushed a busy
  // ADE runtime into multi-gigabyte peaks. This worker also keeps that work off
  // the runtime's project/chat/sync event loop.
  for (const scanner of providerScanners) {
    let entries: TokenEntry[];
    // Completeness is tracked separately from success. A scan that throws is
    // reported through `providerErrors`; a scan that swallowed an unreadable
    // directory, file or database and returned what it could is reported here,
    // because both are "this machine did not see everything under that root"
    // and the cross-machine dedupe must skip the provider either way.
    let complete: boolean;
    try {
      ({ value: entries, complete } = await runLedgerScanWithCompleteness(() => scanner.scan()));
    } catch (error) {
      emit({
        provider: scanner.provider,
        costs: [],
        projectCosts: [],
        projectCostsByRoot: {},
        entryCount: 0,
        error: getErrorMessage(error),
      } satisfies UsageLedgerProviderChunk);
      continue;
    }
    // The silent half: no failure was raised anywhere, but a provider whose
    // transcript root is present and yielded nothing has not proven the root is
    // empty — only that this pass found nothing in it.
    const incomplete = !complete
      || (entries.length === 0 && usageLedgerTranscriptRootExists(scanner.provider, transcriptRoots));
    const providerEntries = new Map([[scanner.provider, entries]]);
    const daily7d = (scanner.provider === "claude" || scanner.provider === "codex") && entries.length > 0
      ? bucketDaily7d(entries, nowMs)
      : undefined;
    emit({
      provider: scanner.provider,
      costs: buildCostSnapshots(providerEntries, "machine", projectRoot),
      projectCosts: buildCostSnapshots(providerEntries, "project", projectRoot),
      // The ledgers are walked once for the whole brain; the per-root
      // projection is a filter over entries already in hand.
      projectCostsByRoot: Object.fromEntries(projectRoots.map((root) => [
        root,
        buildCostSnapshots(providerEntries, "project", root),
      ])),
      ...(daily7d ? { daily7d } : {}),
      entryCount: entries.length,
      ...(incomplete ? { incomplete: true } : {}),
    } satisfies UsageLedgerProviderChunk);
  }
}

export async function runUsageLedgerWorkerEntrypoint(): Promise<number> {
  try {
    await main();
    return 0;
  } catch (error) {
    process.stderr.write(getErrorMessage(error).slice(0, 64 * 1024));
    return 1;
  }
}
