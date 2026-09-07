import { describe, expect, it } from "vitest";

import { resolveLinkOpenTarget } from "./linkOpenTarget";

describe("resolveLinkOpenTarget", () => {
  it("follows the preference on a plain click", () => {
    expect(resolveLinkOpenTarget({ mode: "in-app" })).toBe("in-app");
    expect(resolveLinkOpenTarget({ mode: "external" })).toBe("external");
  });

  it("treats Cmd as Mod on macOS and Ctrl elsewhere", () => {
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { metaKey: true }, isMac: true })).toBe("external");
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { ctrlKey: true }, isMac: false })).toBe("external");
    // The other platform's key is not Mod, so it must not trigger the override.
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { ctrlKey: true }, isMac: true })).toBe("in-app");
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { metaKey: true }, isMac: false })).toBe("in-app");
  });

  it("opens externally on Mod+Click even when the preference is in-app", () => {
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { metaKey: true }, isMac: true })).toBe("external");
  });

  it("opens in ADE on Shift+Click even when the preference is external", () => {
    expect(resolveLinkOpenTarget({ mode: "external", modifiers: { shiftKey: true } })).toBe("in-app");
  });

  it("lets Mod win over Shift, because Mod is the escape hatch", () => {
    expect(
      resolveLinkOpenTarget({
        mode: "in-app",
        modifiers: { metaKey: true, shiftKey: true },
        isMac: true,
      }),
    ).toBe("external");
  });

  it("ignores modifiers that carry no meaning here", () => {
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: {} })).toBe("in-app");
    expect(resolveLinkOpenTarget({ mode: "external", modifiers: null })).toBe("external");
  });
});
