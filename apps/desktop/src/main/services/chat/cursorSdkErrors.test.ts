import { describe, expect, it } from "vitest";
import { cursorSdkResultWithStreamFailure } from "./cursorSdkErrors";

describe("cursorSdkResultWithStreamFailure", () => {
  it("marks successful wait results as errors after a stream failure", () => {
    const result = cursorSdkResultWithStreamFailure(
      {
        id: "run-1",
        requestId: "req-1",
        status: "finished",
        result: "partial result",
      },
      { message: "Stream closed with error code NGHTTP2_INTERNAL_ERROR", code: "network" },
      "local",
    );

    expect(result).toMatchObject({
      id: "run-1",
      requestId: "req-1",
      status: "error",
      result: "partial result",
      error: {
        message: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
        code: "network",
      },
    });
  });

  it("leaves existing SDK error results unchanged", () => {
    const result = {
      id: "run-2",
      status: "error",
      error: { message: "SDK failed", code: "resource_exhausted" },
    };

    expect(cursorSdkResultWithStreamFailure(result, { message: "stream failed" }, "cloud")).toBe(result);
  });
});
