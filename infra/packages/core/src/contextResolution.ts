export type HostedContextSource = "inline" | "mirror" | "inline_fallback";

export type ResolvedContextParams = {
  params: Record<string, unknown>;
  source: HostedContextSource;
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function withHandoff(args: {
  raw: Record<string, unknown>;
  source: HostedContextSource;
  handoffRaw: Record<string, unknown>;
  reasonCode?: string;
  approxParamsBytes?: number | null;
  refSha256?: string | null;
  warnings: string[];
}): Record<string, unknown> {
  return {
    ...args.raw,
    __adeHandoff: {
      schema: "ade.handoff.v1",
      ...args.handoffRaw,
      contextSource: args.source,
      ...(args.reasonCode ? { reasonCode: args.reasonCode } : {}),
      ...(args.approxParamsBytes != null ? { approxParamsBytes: args.approxParamsBytes } : {}),
      ...(args.refSha256 ? { refSha256: args.refSha256 } : {}),
      warnings: args.warnings
    }
  };
}

export async function resolveContextParams(args: {
  params: Record<string, unknown>;
  fetchContextRef: (sha256: string) => Promise<unknown>;
}): Promise<ResolvedContextParams> {
  const raw = isRecord(args.params) ? args.params : {};
  const warnings: string[] = [];
  const handoffRaw = isRecord(raw.__adeHandoff) ? (raw.__adeHandoff as Record<string, unknown>) : {};
  const refRaw = raw.__adeContextRef;

  if (!isRecord(refRaw)) {
    const source =
      typeof handoffRaw.contextSource === "string" &&
      (handoffRaw.contextSource === "inline" || handoffRaw.contextSource === "mirror" || handoffRaw.contextSource === "inline_fallback")
        ? (handoffRaw.contextSource as HostedContextSource)
        : "inline";
    return {
      params: withHandoff({
        raw,
        source,
        handoffRaw,
        warnings
      }),
      source: source === "mirror" ? "inline" : source,
      warnings
    };
  }

  const sha256 = typeof refRaw.sha256 === "string" ? refRaw.sha256.trim() : "";
  const reasonCode = typeof refRaw.reasonCode === "string" ? refRaw.reasonCode : "";
  const approxParamsBytes = Number.isFinite(Number(refRaw.approxParamsBytes)) ? Number(refRaw.approxParamsBytes) : null;

  if (!sha256) {
    warnings.push("context_ref_missing_sha256");
    return {
      params: withHandoff({
        raw,
        source: "inline_fallback",
        handoffRaw,
        reasonCode,
        approxParamsBytes,
        warnings
      }),
      source: "inline_fallback",
      warnings
    };
  }

  try {
    const fetched = await args.fetchContextRef(sha256);
    if (isRecord(fetched)) {
      return {
        params: withHandoff({
          raw: fetched as Record<string, unknown>,
          source: "mirror",
          handoffRaw,
          reasonCode,
          approxParamsBytes,
          refSha256: sha256,
          warnings
        }),
        source: "mirror",
        warnings
      };
    }
    warnings.push("context_ref_invalid_payload");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`context_ref_fetch_failed:${message}`);
  }

  const inlineFallback = raw.__adeContextInline;
  if (isRecord(inlineFallback)) {
    return {
      params: withHandoff({
        raw: inlineFallback as Record<string, unknown>,
        source: "inline_fallback",
        handoffRaw,
        reasonCode,
        approxParamsBytes,
        refSha256: sha256,
        warnings
      }),
      source: "inline_fallback",
      warnings
    };
  }

  warnings.push("context_ref_fallback_missing_inline_payload");
  return {
    params: withHandoff({
      raw,
      source: "inline_fallback",
      handoffRaw,
      reasonCode,
      approxParamsBytes,
      refSha256: sha256,
      warnings
    }),
    source: "inline_fallback",
    warnings
  };
}
