import type { RemoteRuntimeSshHostKeyTrustStatus } from "../../../shared/types/remoteRuntime";

export class PairedRuntimeTransportUnavailableError extends Error {
  readonly code = "PAIRED_RUNTIME_TRANSPORT_UNAVAILABLE" as const;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PairedRuntimeTransportUnavailableError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }
}

export class PairedRuntimeCompatibilityError extends Error {
  readonly code = "PAIRED_RUNTIME_COMPATIBILITY" as const;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PairedRuntimeCompatibilityError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }
}

export class PairedRuntimeSshTrustRequiredError extends Error {
  readonly code = "PAIRED_RUNTIME_SSH_TRUST_REQUIRED" as const;

  constructor(
    readonly trustStatus: Extract<
      RemoteRuntimeSshHostKeyTrustStatus,
      { state: "needs_trust" | "changed" }
    >,
  ) {
    super(
      trustStatus.state === "changed"
        ? "The SSH host key changed after the paired connection failed."
        : "The SSH host key must be trusted before ADE can fall back from the paired connection.",
    );
    this.name = "PairedRuntimeSshTrustRequiredError";
  }
}
