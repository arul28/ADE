import { spawn } from "node:child_process";
import path from "node:path";
import zlib from "node:zlib";
import { providerSupportsHandoffFork } from "../../../shared/types/chat";
import type {
  AgentChatCrossMachineForkTransport,
  AgentChatCrossMachineHandoffCapsule,
} from "../../../shared/types/chat";

export const CROSS_MACHINE_FORK_MAIN_MAX_UNCOMPRESSED = 18 * 1024 * 1024;
export const CROSS_MACHINE_FORK_SIDEFILES_MAX_UNCOMPRESSED = 4 * 1024 * 1024;
export const CROSS_MACHINE_FORK_TRANSCRIPT_MAX_UNCOMPRESSED = 3 * 1024 * 1024;
export const CROSS_MACHINE_FORK_MAIN_MAX_BASE64 = 26 * 1024 * 1024;
export const CROSS_MACHINE_FORK_SIDEFILES_MAX_BASE64 = 6 * 1024 * 1024;
export const CROSS_MACHINE_FORK_TRANSCRIPT_MAX_BASE64 = 5 * 1024 * 1024;
// Transport-safe budget for the whole fork capsule's base64 payload. Kept under the 25 MiB sync envelope cap
// (MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES in apps/ade-cli/src/services/sync/syncProtocol.ts) and the 25 MiB WS
// maxPayload (SYNC_HOST_MAX_PAYLOAD_BYTES in apps/ade-cli/src/services/sync/sharedSyncListener.ts).
export const CROSS_MACHINE_FORK_ENCODED_BUDGET_BYTES = 20 * 1024 * 1024;
export const CROSS_MACHINE_FORK_BRIEF_STUB = "Fork handoff — full conversation history transported.";

export function gzipToBase64(content: Buffer | string): {
  contentBase64Gzip: string;
  uncompressedBytes: number;
} {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return {
    contentBase64Gzip: zlib.gzipSync(buffer).toString("base64"),
    uncompressedBytes: buffer.length,
  };
}

export function gunzipFromBase64(contentBase64Gzip: string, maxBytes?: number): Buffer {
  const compressed = Buffer.from(contentBase64Gzip, "base64");
  return maxBytes === undefined
    ? zlib.gunzipSync(compressed)
    : zlib.gunzipSync(compressed, { maxOutputLength: maxBytes });
}

export function enforceCrossMachineForkEncodedBudget(
  forkTransport: AgentChatCrossMachineForkTransport,
  transcriptEnvelopes: AgentChatCrossMachineHandoffCapsule["transcriptEnvelopes"],
  maxEncodedBytes = CROSS_MACHINE_FORK_ENCODED_BUDGET_BYTES,
): boolean {
  const transcriptBytes = transcriptEnvelopes?.contentBase64Gzip.length ?? 0;
  const sideFileBytes = (forkTransport.sideFiles ?? []).reduce(
    (total, sideFile) => total + sideFile.contentBase64Gzip.length,
    0,
  );
  const requiredBytes = forkTransport.mainFile.contentBase64Gzip.length + transcriptBytes;
  if (requiredBytes + sideFileBytes <= maxEncodedBytes) return false;
  if (requiredBytes > maxEncodedBytes) {
    throw new Error("This chat's history is too large to fork across machines. Send it as a brief instead.");
  }
  forkTransport.sideFiles = undefined;
  return true;
}

export function crossMachineForkOversizeError(uncompressedBytes: number): Error {
  const mib = (uncompressedBytes / (1024 * 1024)).toFixed(1);
  const error = new Error(
    `This chat's history is too large to send as a fork (${mib} MiB, limit 18 MiB). Send it as a brief instead.`,
  ) as Error & { code: string };
  error.code = "CROSS_MACHINE_FORK_OVERSIZE";
  return error;
}

export const runCliCapture = (
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<{ stdout: Buffer; stderr: string; exitCode: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${path.basename(bin)} timed out after ${opts.timeoutMs}ms.`));
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
      });
    });
    child.stdin?.end();
  });

export function validateForkTransport(capsule: AgentChatCrossMachineHandoffCapsule): void {
  const forkTransport = capsule.forkTransport;
  if (forkTransport === undefined) return;
  if (!forkTransport || typeof forkTransport !== "object" || Array.isArray(forkTransport)) {
    throw new Error("The handoff capsule has a malformed fork transport.");
  }
  if (
    !providerSupportsHandoffFork(forkTransport.provider)
    || forkTransport.provider !== capsule.source.provider
  ) {
    throw new Error("The handoff capsule has an invalid fork transport provider.");
  }
  if (
    typeof forkTransport.nativeSessionId !== "string"
    || !forkTransport.nativeSessionId.trim()
    || forkTransport.nativeSessionId.length > 400
    || forkTransport.nativeSessionId.includes("\0")
  ) {
    throw new Error("The handoff capsule has an invalid native session id.");
  }
  if (!new Set<string>(["claude-jsonl", "codex-rollout", "opencode-export", "droid-jsonl"]).has(forkTransport.kind)) {
    throw new Error("The handoff capsule has an invalid fork transport kind.");
  }
  const mainFile = forkTransport.mainFile;
  if (!mainFile || typeof mainFile !== "object" || Array.isArray(mainFile)) {
    throw new Error("The handoff capsule has a malformed fork main file.");
  }
  if (
    typeof mainFile.name !== "string"
    || !mainFile.name.trim()
    || mainFile.name.length > 255
    || mainFile.name.includes("\0")
    || mainFile.name.includes("/")
    || mainFile.name.includes("\\")
    || mainFile.name === "."
    || mainFile.name === ".."
  ) {
    throw new Error("The handoff capsule has an invalid fork main file name.");
  }
  const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
  if (
    typeof mainFile.contentBase64Gzip !== "string"
    || !base64Pattern.test(mainFile.contentBase64Gzip)
    || mainFile.contentBase64Gzip.length > CROSS_MACHINE_FORK_MAIN_MAX_BASE64
  ) {
    throw new Error("The handoff capsule has invalid fork main file content.");
  }
  if (!validPositiveByteCount(mainFile.uncompressedBytes, CROSS_MACHINE_FORK_MAIN_MAX_UNCOMPRESSED)) {
    throw new Error("The handoff capsule fork main file exceeds its portable limit.");
  }

  if (forkTransport.sideFiles === undefined) return;
  if (!Array.isArray(forkTransport.sideFiles) || forkTransport.sideFiles.length > 1_000) {
    throw new Error("The handoff capsule has too many fork side files.");
  }
  let totalUncompressedBytes = 0;
  let totalBase64Bytes = 0;
  for (const sideFile of forkTransport.sideFiles) {
    if (!sideFile || typeof sideFile !== "object" || Array.isArray(sideFile)) {
      throw new Error("The handoff capsule has a malformed fork side file.");
    }
    if (
      typeof sideFile.relPath !== "string"
      || !sideFile.relPath
      || sideFile.relPath.length > 1_024
      || sideFile.relPath.includes("\0")
      || path.isAbsolute(sideFile.relPath)
      || sideFile.relPath.split(/[\\/]/).includes("..")
    ) {
      throw new Error("The handoff capsule has an invalid fork side file path.");
    }
    if (
      typeof sideFile.contentBase64Gzip !== "string"
      || !base64Pattern.test(sideFile.contentBase64Gzip)
    ) {
      throw new Error("The handoff capsule has invalid fork side file content.");
    }
    if (
      typeof sideFile.uncompressedBytes !== "number"
      || !Number.isFinite(sideFile.uncompressedBytes)
      || !Number.isInteger(sideFile.uncompressedBytes)
      || sideFile.uncompressedBytes <= 0
    ) {
      throw new Error("The handoff capsule has an invalid fork side file size.");
    }
    totalUncompressedBytes += sideFile.uncompressedBytes;
    totalBase64Bytes += sideFile.contentBase64Gzip.length;
  }
  if (totalUncompressedBytes > CROSS_MACHINE_FORK_SIDEFILES_MAX_UNCOMPRESSED) {
    throw new Error("The handoff capsule fork side files exceed their portable limit.");
  }
  if (totalBase64Bytes > CROSS_MACHINE_FORK_SIDEFILES_MAX_BASE64) {
    throw new Error("The handoff capsule fork side file content exceeds its portable limit.");
  }
}

function validPositiveByteCount(value: unknown, max: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value > 0
    && value <= max;
}
