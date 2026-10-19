/**
 * What every provider runtime, probe and status row says when ADE's pinned copy
 * of the provider's tool is not on this machine.
 *
 * ADE never runs a provider CLI the user installed: each provider resolves only
 * ADE's own copy (resolvers in this directory), and when there is none the
 * reason is one of the tools cache's states (`getPinnedToolStatus`). This
 * module turns those states into the one sentence every surface shows, and
 * gives runtime starts one way to wait for a download and fail clearly.
 *
 *   await awaitPinnedToolDownload("qwen");                // start or join the download
 *   const resolved = resolveAcpExecutable("qwen");        // then resolve
 *   if (resolved.source === "fallback-command") throw pinnedToolNotReadyError("qwen");
 *
 * Everything acts on the tools cache of the process it runs in, so it must run
 * in the brain that owns the chat or lane: a remote chat downloads on its own
 * machine.
 */
import { pinnedToolDownload, retryPinnedToolDownload } from "../../../../../ade-cli/src/services/tools/onDemand";
import {
  getPinnedToolStatus,
  resolvePinnedTool,
  type PinnedToolState,
  type PinnedToolStatus,
} from "../../../../../ade-cli/src/services/tools/pinnedTool";
import type { ToolErrorKind } from "../../../../../ade-cli/src/services/tools/errors";
import { ACP_PROVIDER_IDS, ACP_PROVIDER_METADATA, type AcpProviderId } from "../../../shared/acpProviderMetadata";
import type { MuseBinaryStatus } from "../../../shared/museBinary";
import type { PinnedProviderToolStatus } from "../../../shared/types/config";
import { PINNED_PROVIDER_TOOLS } from "../../../shared/pinnedToolSpawnEnv";
import { claudeFallForwardStatusLine } from "./claudeFallForward";
import { codexFallForwardStatusLine } from "./codexFallForward";
import { museFallForwardStatusLine } from "./museFallForward";
import { getMuseBinaryStatus, startMuseBinaryFetch } from "./museExecutable";

/** The pinned tool behind a provider id, or null for a provider ADE pins nothing for. */
export function pinnedToolForProvider(provider: string): { tool: string; label: string } | null {
  const fixed = PINNED_PROVIDER_TOOLS[provider];
  if (fixed) return fixed;
  if ((ACP_PROVIDER_IDS as readonly string[]).includes(provider)) {
    // ACP tools are named after the provider; Antigravity and later ACP
    // providers get a row here the moment they join ACP_PROVIDER_IDS.
    return { tool: provider, label: ACP_PROVIDER_METADATA[provider as AcpProviderId].label };
  }
  return null;
}

function hostTarget(): string {
  return `${process.platform}-${process.arch}`;
}

function capitalized(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const ERROR_KIND_WORDS: Readonly<Partial<Record<ToolErrorKind, string>>> = {
  network: "the download failed",
  integrity: "the download did not match ADE's checksum",
  "disk-space": "not enough free disk space",
  extract: "the download could not be unpacked",
  "lock-timeout": "another ADE was still installing it",
  filesystem: "it could not be written to disk",
};

function failureReason(errorKind: string | null): string {
  return (errorKind && ERROR_KIND_WORDS[errorKind as ToolErrorKind]) ?? errorKind ?? "unknown error";
}

/**
 * The sentence for a tool that is not ready, or null when it is. Downloading,
 * failed (with the typed kind and a retry hint), not available for this
 * machine's platform, or not downloaded yet.
 */
export function pinnedToolBlocker(label: string, status: PinnedToolStatus): string | null {
  switch (status.state) {
    case "ready":
      return null;
    case "downloading":
      return `ADE is downloading ${label} for this machine. Refresh when it finishes.`;
    case "failed":
      return `Couldn't download ${label}: ${failureReason(status.errorKind)}. Retry from Settings > Providers.`;
    case "unavailable":
      return status.errorKind === "unsupported-target"
        ? `${capitalized(label)} is not available on this machine (${hostTarget()}).`
        : `This ADE build has no pinned ${label}.`;
    case "missing":
      return status.fetchAllowed
        ? `ADE has not downloaded ${label} for this machine yet. It downloads the first time this machine uses it.`
        : `ADE has not downloaded ${label} for this machine, and downloads are turned off in this ADE process.`;
  }
}

/** Where `tool` stands, as a state and the sentence for it. Never throws. */
export function pinnedToolState(tool: string, label: string): { state: PinnedToolState; status: PinnedToolStatus; blocker: string | null } {
  const status = getPinnedToolStatus(tool);
  return { state: status.state, status, blocker: pinnedToolBlocker(label, status) };
}

/**
 * Presence of a provider's runtime for a status row: installed when its
 * resolver found ADE's copy (`resolvedPath`), else the tools cache's reason.
 * The resolver is the authority because it also knows the dev/test override
 * and a source checkout's `node_modules` copy, which the cache does not.
 */
export function pinnedToolPresence(
  tool: string,
  label: string,
  resolvedPath: string | null,
): { installed: boolean; path: string | null; state: PinnedToolState; blocker: string | null } {
  if (resolvedPath) return { installed: true, path: resolvedPath, state: "ready", blocker: null };
  const { state, blocker } = pinnedToolState(tool, label);
  // The cache can hold a copy the resolver refused (e.g. not executable);
  // that is not a ready runtime.
  return { installed: false, path: null, state: state === "ready" ? "missing" : state, blocker };
}

/** How to run ADE's pinned Cursor CLI: an entry plus the arguments before the CLI's own. */
export type PinnedCursorAgentCli = { command: string; leadingArgs: string[]; env: Record<string, string> };

/**
 * ADE's pinned Cursor CLI (`cursor-cli`): Cursor's own bundled Node running
 * `index.js`, exactly as its `cursor-agent` launcher does (`--use-system-ca`
 * on POSIX, `CURSOR_INVOKED_AS`), with its self-update off. Null when it is
 * not on this machine. Never a `cursor-agent` from the PATH, never a download.
 */
export function resolvePinnedCursorAgentCli(platform: NodeJS.Platform = process.platform): PinnedCursorAgentCli | null {
  const pinned = resolvePinnedTool(PINNED_PROVIDER_TOOLS.cursor.tool, { platform });
  const script = pinned?.files.script;
  if (!pinned || !script) return null;
  return {
    command: pinned.entryPath,
    leadingArgs: [...(platform === "win32" ? [] : ["--use-system-ca"]), script, "--disable-auto-update"],
    env: { CURSOR_INVOKED_AS: "cursor-agent" },
  };
}

/** Thrown by a runtime start whose pinned tool is not on this machine. */
export class PinnedToolNotReadyError extends Error {
  readonly tool: string;
  readonly state: PinnedToolState;
  readonly errorKind: ToolErrorKind | null;

  constructor(tool: string, label: string, status: PinnedToolStatus) {
    super(pinnedToolBlocker(label, status) ?? `ADE could not start ${label} on this machine.`);
    this.name = "PinnedToolNotReadyError";
    this.tool = tool;
    this.state = status.state;
    this.errorKind = status.errorKind;
  }
}

/** The error for a runtime start that found no copy of `tool`. */
export function pinnedToolNotReadyError(tool: string, label: string): PinnedToolNotReadyError {
  return new PinnedToolNotReadyError(tool, label, getPinnedToolStatus(tool));
}

/**
 * ADE's pinned copy of a provider's tool, for a process that is about to run
 * it: waits for its download when this machine has not fetched it yet, and
 * throws the download state (downloading, failed, not available here) when
 * there is still none. Never a CLI the user installed.
 */
export async function requirePinnedProviderExecutable<T extends { path: string; source: string }>(
  provider: string,
  resolve: () => T,
): Promise<T> {
  const tool = pinnedToolForProvider(provider);
  if (tool) await awaitPinnedToolDownload(tool.tool);
  const resolved = resolve();
  if (resolved.source === "fallback-command" || !resolved.path) {
    throw tool ? pinnedToolNotReadyError(tool.tool, tool.label) : new Error(`ADE has no ${provider} runtime on this machine.`);
  }
  return resolved;
}

/**
 * Wait for the download of `tool` when this machine has not fetched it yet.
 * Resolves at once (no await) when it is on disk or nothing would download;
 * `onStart` runs only when a download is actually awaited. Never rejects: the
 * caller resolves afterwards and reports a miss with {@link pinnedToolNotReadyError}.
 */
export async function awaitPinnedToolDownload(tool: string, onStart?: () => void): Promise<void> {
  const pending = pinnedToolDownload(tool);
  if (!pending) return;
  onStart?.();
  await pending;
}

/**
 * Muse keeps its own fetch tracker (`ensureMuseBinary`, older than the tools
 * cache's on-demand downloads), so its row reads that tracker, not the cache's.
 */
function museToolStatus(status: MuseBinaryStatus): PinnedProviderToolStatus {
  const state: PinnedProviderToolStatus["state"] = status.state === "installed"
    ? "ready"
    : status.state === "unsupported"
      ? "unavailable"
      : status.state;
  const label = "Muse";
  const message = state === "ready"
    ? null
    : state === "downloading"
      ? `ADE is downloading ${label} for this machine. Refresh when it finishes.`
      : state === "failed"
        ? `Couldn't download ${label}: ${failureReason(status.errorKind)}. Retry from Settings > Providers.`
        : state === "unavailable"
          ? `${label} is not available on this machine (${hostTarget()}).`
          : `ADE has not downloaded ${label} for this machine yet. It downloads the first time this machine uses it.`;
  return {
    provider: "muse",
    tool: "muse",
    label,
    state,
    version: status.pinnedVersion,
    runningVersion: state === "ready" ? status.pinnedVersion : null,
    downloading: state === "downloading",
    receivedBytes: status.receivedBytes,
    totalBytes: status.totalBytes,
    errorKind: status.errorKind,
    failureReason: state === "failed" ? failureReason(status.errorKind) : null,
    message,
    fetchAllowed: state !== "unavailable",
    // An untested build ADE moved to, or Meta's floor this ADE cannot meet.
    notice: museFallForwardStatusLine(),
  };
}

function requireProviderTool(provider: string): { tool: string; label: string } {
  const pinned = pinnedToolForProvider(provider);
  if (!pinned) throw new Error(`ADE pins no tool for provider '${provider}'.`);
  return pinned;
}

/**
 * Where ADE's copy of a provider's tool stands on THIS machine, for a
 * Settings row or a chat card (the `ai.pinnedToolStatus` action). No spawn,
 * no network. Throws for a provider ADE pins nothing for.
 */
export function getPinnedProviderToolStatus(provider: string): PinnedProviderToolStatus {
  if (provider === "muse") return museToolStatus(getMuseBinaryStatus());
  const pinned = requireProviderTool(provider);
  const status = getPinnedToolStatus(pinned.tool);
  return {
    provider,
    tool: pinned.tool,
    label: pinned.label,
    state: status.state,
    version: status.version,
    runningVersion: status.runningVersion,
    downloading: status.downloading,
    receivedBytes: status.receivedBytes,
    totalBytes: status.totalBytes,
    errorKind: status.errorKind,
    failureReason: status.state === "failed" ? failureReason(status.errorKind) : null,
    message: pinnedToolBlocker(pinned.label, status),
    fetchAllowed: status.fetchAllowed,
    // Claude Code and Codex are the tools ADE may move past their pin on its own (Muse: museToolStatus).
    ...(pinned.tool === "claude-code" ? { notice: claudeFallForwardStatusLine() } : {}),
    ...(pinned.tool === "codex" ? { notice: codexFallForwardStatusLine() } : {}),
  };
}

/**
 * The user's Download/Retry for a provider's tool on THIS machine (the
 * `ai.pinnedToolDownload` action): starts or joins the download, ignoring the
 * automatic retry backoff, and returns at once with the new status. A
 * download is hundreds of MB, so a remote caller must not hold its action
 * open for it; callers poll `ai.pinnedToolStatus` while `downloading`.
 */
export function startPinnedProviderToolDownload(provider: string): PinnedProviderToolStatus {
  if (provider === "muse") return museToolStatus(startMuseBinaryFetch());
  const pinned = requireProviderTool(provider);
  // Resolves to the ToolError (recorded for the status) or null; never rejects.
  void retryPinnedToolDownload(pinned.tool);
  return getPinnedProviderToolStatus(provider);
}
