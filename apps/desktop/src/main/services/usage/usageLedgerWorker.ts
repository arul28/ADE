import { getErrorMessage, isRecord } from "../shared/utils";
import { refreshDynamicTokenPricing } from "./usagePricing";
import {
  runLedgerScanWithCompleteness,
  usageLedgerTranscriptRootExists,
  usageLedgerTranscriptRoots,
  type TokenEntry,
} from "./ledgers/localUsageLedgers";
import { DAILY_7D_PROVIDERS, usageLedgerScanners } from "./usageLedgerScanners";
import { buildCostSnapshots, bucketDaily7d } from "./usageTrackingService";
import {
  LEDGER_STREAM_HEADER_KIND,
  type UsageLedgerProviderChunk,
} from "./usageLedgerWorkerClient";

const WORKER_INPUT_MAX_BYTES = 64 * 1024;

type UsageLedgerWorkerInput = {
  projectRoot: string | null;
  projectRoots: string[];
};

/** Reads the caller's JSON input. */
function parseUsageLedgerWorkerInput(raw: string): UsageLedgerWorkerInput {
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

/**
 * Reads the whole input, then decodes it once. Decoding chunk by chunk would
 * split a multi-byte character (a CJK project path) at a chunk boundary.
 */
export async function readUsageLedgerWorkerInput(
  stdin: AsyncIterable<Buffer | string>,
  maxBytes = WORKER_INPUT_MAX_BYTES,
): Promise<UsageLedgerWorkerInput> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    byteCount += bytes.length;
    if (byteCount > maxBytes) throw new Error("Usage ledger worker input is too large");
    chunks.push(bytes);
  }
  return parseUsageLedgerWorkerInput(Buffer.concat(chunks, byteCount).toString("utf8"));
}

function emit(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const { projectRoot, projectRoots } = await readUsageLedgerWorkerInput(process.stdin);
  await refreshDynamicTokenPricing().catch(() => 0);
  // The roster first, then one line per provider as it finishes. Buffering every
  // provider and writing a single object at the end meant a timeout — or any
  // failure — discarded every provider that had already succeeded, which on a
  // machine with a large Codex history left the Usage page permanently at zero.
  emit({
    kind: LEDGER_STREAM_HEADER_KIND,
    providers: usageLedgerScanners.map((scanner) => scanner.provider),
  });
  const nowMs = Date.now();
  const transcriptRoots = usageLedgerTranscriptRoots();

  // Scan and aggregate one provider at a time. The old Promise.all path kept
  // every provider's per-turn ledger objects alive together and pushed a busy
  // ADE runtime into multi-gigabyte peaks. This worker also keeps that work off
  // the runtime's project/chat/sync event loop.
  for (const scanner of usageLedgerScanners) {
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
    const daily7d = DAILY_7D_PROVIDERS.has(scanner.provider) && entries.length > 0
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
