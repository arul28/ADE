import { JsonRpcError, JsonRpcErrorCode } from "../jsonrpc";
import { markExpectedFromWire } from "../../../desktop/src/shared/expectedError";
import {
  BRAIN_CONNECTION_LOST_CODE,
  BRAIN_LOG_TAIL_MAX_ENTRIES,
  brainLogTailEntry,
  isErrorCodeShaped,
  type BrainConnectionLossData,
  type BrainLogTailEntry,
} from "../../../desktop/src/shared/brainConnectionLoss";
import { brainLogPath, resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { readBrainHeartbeat } from "../services/runtime/brainHeartbeat";
import { readFileTail } from "../sentry/brainServiceDiagnostics";
import { isPidAlive } from "../serviceManager/common";

/** What a relay can say about a lost brain; built when the loss happens. */
export type DescribeBrainConnectionLoss = () => Omit<BrainConnectionLossData, "code" | "socketError">;

/** A brain's error reply as one error: its code, message, data and expected mark intact. */
export function jsonRpcErrorFromReply(error: Record<string, unknown>): JsonRpcError {
  const code = typeof error.code === "number" && Number.isInteger(error.code)
    ? error.code
    : JsonRpcErrorCode.internalError;
  const message = typeof error.message === "string" && error.message ? error.message : "ADE JSON-RPC request failed.";
  return markExpectedFromWire(new JsonRpcError(code, message, error.data), error.expected);
}

/**
 * The answer for calls a socket to the brain was carrying when it failed or
 * closed (see `BRAIN_CONNECTION_LOST_CODE`). A typed error, so a relaying
 * dispatcher forwards it as it is instead of redacting a Node socket error
 * into an "Internal error" reference. The message keeps "runtime endpoint
 * closed", which the CLI reads as the expected end of a `shutdown`.
 */
export function brainConnectionLostError(
  error: Error | null,
  describeLoss: DescribeBrainConnectionLoss | null,
): JsonRpcError {
  const errno = error ? (error as NodeJS.ErrnoException).code : undefined;
  const socketError = isErrorCodeShaped(errno) ? errno : null;
  let loss: ReturnType<DescribeBrainConnectionLoss> | null = null;
  try {
    loss = describeLoss?.() ?? null;
  } catch {
    loss = null;
  }
  const message = socketError
    ? `${BRAIN_CONNECTION_LOST_CODE}: ADE brain connection lost: the brain on this machine closed its socket (${socketError}) before it answered.`
    : `${BRAIN_CONNECTION_LOST_CODE}: ADE brain connection lost: the ADE runtime endpoint closed before it answered.`;
  const data: Partial<BrainConnectionLossData> = { code: BRAIN_CONNECTION_LOST_CODE, socketError, ...(loss ?? {}) };
  return new JsonRpcError(JsonRpcErrorCode.internalError, message, data);
}

/**
 * The brain log's last lines as level, event name and errno-shaped code only
 * (`brainLogTailEntry` drops anything else). Reads the file's last 16 KB.
 */
function readBrainLogTail(logPath: string): BrainLogTailEntry[] {
  const text = readFileTail(logPath, 16 * 1024);
  if (!text) return [];
  const entries: BrainLogTailEntry[] = [];
  for (const line of text.split("\n").map((value) => value.trim()).filter(Boolean).slice(-BRAIN_LOG_TAIL_MAX_ENTRIES)) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const errorValue = record.err ?? record.error;
    const code = errorValue && typeof errorValue === "object"
      ? (errorValue as Record<string, unknown>).code
      : record.code;
    const entry = brainLogTailEntry(record.level, record.event, code);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Whether the brain this relay talked to is still alive, whether another
 * brain has since taken the machine's heartbeat (a service manager or
 * watchdog restart), and the brain log's last lines. The exit code is not
 * knowable here: the brain is not this process's child.
 */
export function describeBrainConnectionLoss(brainPid: number | null): ReturnType<DescribeBrainConnectionLoss> {
  const layout = resolveMachineAdeLayout();
  const beat = readBrainHeartbeat(layout.runtimeDir);
  const brainAlive = brainPid != null ? isPidAlive(brainPid) : null;
  const replaced = beat != null && beat.pid !== brainPid && isPidAlive(beat.pid);
  return {
    brainState: brainAlive === true
      ? "alive"
      : replaced
        ? "exited_and_replaced"
        : brainAlive === false ? "exited" : "unknown",
    heartbeatAgeSec: beat ? Math.max(0, Math.round((Date.now() - beat.ts) / 1000)) : null,
    brainLogTail: readBrainLogTail(brainLogPath(layout)),
  };
}
