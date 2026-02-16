import { describe, expect, it } from "vitest";
import { resolveContextParams } from "../../../../../../infra/packages/core/src/contextResolution";

describe("resolveContextParams", () => {
  it("resolves mirror ref payloads and writes mirror handoff metadata", async () => {
    const sha = "a".repeat(64);
    const result = await resolveContextParams({
      params: {
        __adeContextRef: {
          sha256: sha,
          reasonCode: "AUTO_MIRROR_PARAMS_LARGE",
          approxParamsBytes: 777
        },
        __adeContextInline: { fallback: true },
        __adeHandoff: {
          manifestRefs: {
            lane: "proj/lane-1/manifest.json"
          }
        }
      },
      fetchContextRef: async () => ({ packBody: "full payload" })
    });

    expect(result.source).toBe("mirror");
    expect(result.params.packBody).toBe("full payload");
    expect((result.params.__adeHandoff as any).contextSource).toBe("mirror");
    expect((result.params.__adeHandoff as any).reasonCode).toBe("AUTO_MIRROR_PARAMS_LARGE");
    expect((result.params.__adeHandoff as any).approxParamsBytes).toBe(777);
    expect((result.params.__adeHandoff as any).refSha256).toBe(sha);
    expect(result.warnings.length).toBe(0);
  });

  it("falls back to inline payload when context ref fetch fails", async () => {
    const sha = "b".repeat(64);
    const result = await resolveContextParams({
      params: {
        __adeContextRef: {
          sha256: sha,
          reasonCode: "AUTO_MIRROR_JOBTYPE_CONFLICT",
          approxParamsBytes: 333
        },
        __adeContextInline: { compact: "fallback" }
      },
      fetchContextRef: async () => {
        throw new Error("blob missing");
      }
    });

    expect(result.source).toBe("inline_fallback");
    expect(result.params.compact).toBe("fallback");
    expect((result.params.__adeHandoff as any).contextSource).toBe("inline_fallback");
    expect(result.warnings.some((warning) => warning.startsWith("context_ref_fetch_failed:"))).toBe(true);
  });
});
