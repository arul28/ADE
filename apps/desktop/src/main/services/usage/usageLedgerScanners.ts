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
import { scanGrokLogs, scanPiLogs, scanQwenLogs } from "./ledgers/acpProviderLedgers";

/**
 * The one list of local usage-history scanners. The ledger worker walks it one
 * provider at a time; the in-process scan (a test harness) walks it with the
 * scanners the harness injected under each `dependency` name.
 *
 * Each `provider` slug must be a key of `usageLedgerTranscriptRoots()`. A
 * scanner whose slug is not a key there loses its scan-completeness signal,
 * silently; a test holds the two lists together.
 */
export const usageLedgerScanners = [
  { provider: "claude", dependency: "scanClaudeLogs", scan: scanClaudeLogs },
  { provider: "codex", dependency: "scanCodexLogs", scan: scanCodexLogs },
  { provider: "cursor", dependency: "scanCursorLogs", scan: scanCursorLogs },
  { provider: "cursor-agent", dependency: "scanCursorAgentLogs", scan: scanCursorAgentLogs },
  { provider: "openclaw", dependency: "scanOpenClawLogs", scan: scanOpenClawLogs },
  { provider: "opencode", dependency: "scanOpenCodeLogs", scan: scanOpenCodeLogs },
  { provider: "droid", dependency: "scanDroidLogs", scan: scanDroidLogs },
  { provider: "copilot", dependency: "scanCopilotLogs", scan: scanCopilotLogs },
  { provider: "gemini", dependency: "scanGeminiLogs", scan: scanGeminiLogs },
  { provider: "pi", dependency: "scanPiLogs", scan: scanPiLogs },
  { provider: "qwen", dependency: "scanQwenLogs", scan: scanQwenLogs },
  { provider: "grok", dependency: "scanGrokLogs", scan: scanGrokLogs },
] as const satisfies readonly { provider: string; dependency: string; scan: () => Promise<TokenEntry[]> }[];

/** The dependency name a harness injects one scanner under (`scanClaudeLogs`, ...). */
export type UsageLedgerScannerDependency = (typeof usageLedgerScanners)[number]["dependency"];

/** Harness overrides for the scanners, by dependency name. */
export type UsageLedgerScannerOverrides = Partial<Record<UsageLedgerScannerDependency, () => Promise<TokenEntry[]>>>;

/** The providers whose scanned days feed the 7-day daily chart. */
export const DAILY_7D_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"]);
