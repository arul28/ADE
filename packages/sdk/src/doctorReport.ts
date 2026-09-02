/**
 * The `doctor()` report, assembled from sources the client already holds.
 *
 * Pure: every value it needs is passed in, so the shape of a support bundle can
 * be read and tested without a runtime, a socket, or a child process. The one
 * judgement it makes is `ok`, and it makes it from three facts that are each
 * checkable on their own.
 */

import { LEGACY_BINARY_SOURCE, type ResolvedBinarySource } from "./binary.js";
import type { RuntimeSignature } from "./runtimeSignature.js";
import { SDK_VERSION } from "./version.js";
import type { DoctorReport, ProviderStatus } from "./types.js";

export type DoctorInput = {
  binary: {
    binaryPath: string;
    runtimeRoot: string | null;
    nodeModulesPath: string | null;
    source: DoctorReport["runtime"]["source"];
    checksumVerified: boolean;
  };
  /** `<binary> --version`, or the runtime's self-reported version when attached. */
  version: string | null;
  signature: RuntimeSignature | null;
  providers: Record<string, ProviderStatus>;
  socketPath: string;
  socketConnected: boolean;
  runtimeVersion: string | null;
  runtimePid: number | null;
  events: DoctorReport["events"];
  threads: { tracked: number; live: number };
  recentErrors: DoctorReport["recentErrors"];
};

/**
 * The 0.1.x spelling of `doctor().binary.source`.
 *
 * Derived rather than stored beside `runtime.source`, which is the modern
 * five-value field. `"attached"` has no 0.1.x spelling — that mode postdates
 * the field — and reads back as the caller-pinned value it most resembles.
 */
function legacyBinarySource(
  source: DoctorReport["runtime"]["source"],
): DoctorReport["binary"]["source"] {
  return source === "attached" ? "option" : LEGACY_BINARY_SOURCE[source as ResolvedBinarySource];
}

export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const { binary, version, providers } = input;
  const path = binary.binaryPath || "(attached)";
  return {
    // Three independent facts, all required: the socket answers, events have a
    // transport, and at least one provider is actually usable. A report that
    // said `ok` with no usable provider would send a support thread looking in
    // the wrong place.
    ok:
      input.socketConnected &&
      input.events.mode !== "unavailable" &&
      Object.values(providers).some((entry) => entry.available),
    sdkVersion: SDK_VERSION,
    binary: {
      path,
      version,
      source: legacyBinarySource(binary.source),
      checksumVerified: binary.checksumVerified,
    },
    runtime: {
      source: binary.source,
      binaryPath: path,
      version,
      runtimeRoot: binary.runtimeRoot,
      nodeModulesPath: binary.nodeModulesPath,
      signature: input.signature,
      downloadedThisSession: binary.source === "downloaded",
      checksumVerified: binary.checksumVerified,
    },
    socket: {
      path: input.socketPath,
      connected: input.socketConnected,
      runtimeVersion: input.runtimeVersion,
      pid: input.runtimePid,
    },
    events: input.events,
    providers,
    threads: input.threads,
    recentErrors: input.recentErrors,
  };
}
