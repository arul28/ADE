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

