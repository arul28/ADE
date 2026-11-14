import { describe, expect, it } from "vitest";
import { classifyProviderAccountRefusal } from "./providerAccountRefusal";

describe("classifyProviderAccountRefusal", () => {
  it.each([
    // A usage limit keeps its own card and reset time, even when it offers an upgrade.
    ["a usage limit that offers an upgrade to the plan", "You've hit your usage limit. Upgrade to your plan or try again later.", null],
    ["a usage limit that names a tier to upgrade to", "You've hit your usage limit. Upgrade to Pro or try again later.", null],
    // A real plan refusal: signing in again does not help.
    ["a provider plan that does not include the product", "The subscription does not have access to Kimi Code.", "plan"],
    ["a plan_required error from the provider", "plan_required", "plan"],
  ])("reads %s as the verdict %j", (_label, text, expected) => {
    expect(classifyProviderAccountRefusal(text)).toBe(expected);
  });
});
