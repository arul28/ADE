import { describe, expect, it } from "vitest";
import { createDynamicOpenCodeModelDescriptor } from "../../../shared/modelRegistry";
import { resolveOpenCodeModelSelection } from "./openCodeRuntime";

describe("resolveOpenCodeModelSelection", () => {
  it("uses openCodeProviderId and openCodeModelId when present", () => {
    const d = createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "lmstudio",
      openCodeModelId: "openai/gpt-oss-20b",
    });
    expect(resolveOpenCodeModelSelection(d)).toEqual({
      providerID: "lmstudio",
      modelID: "openai/gpt-oss-20b",
    });
  });

  it("decodes paired ids from the registry id when explicit fields are missing", () => {
    const d = createDynamicOpenCodeModelDescriptor("legacy-only");
    expect(resolveOpenCodeModelSelection(d)).toEqual({
      providerID: "opencode",
      modelID: "legacy-only",
    });
  });
});
