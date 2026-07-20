import { describe, expect, it } from "vitest";
import { titleCaseProviderName } from "./providerMetadata";

describe("providerMetadata Kimi aliases", () => {
  it("maps every Kimi/Moonshot catalog id to the Kimi brand label", () => {
    // The opencode catalog emits `moonshotai` (and `kimi-for-coding`) as the
    // canonical provider ids; both must render as "Kimi" like `kimi`/`moonshot`.
    expect(titleCaseProviderName("kimi")).toBe("Kimi");
    expect(titleCaseProviderName("moonshot")).toBe("Kimi");
    expect(titleCaseProviderName("moonshotai")).toBe("Kimi");
    expect(titleCaseProviderName("kimi-for-coding")).toBe("Kimi");
  });
});
