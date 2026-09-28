import { beforeEach, describe, expect, it } from "vitest";
import { getShippedTheme } from "../../shared/theme";
import { resolveTheme } from "../../shared/theme";
import { appliedThemeVarNames, applyAdeTheme, clearAppliedTheme } from "./applyTheme";

type FakeElement = {
  style: {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
    colorScheme: string;
  };
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  props: Map<string, string>;
  attrs: Map<string, string>;
};

function fakeElement(): FakeElement {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  return {
    style: {
      setProperty: (name, value) => void props.set(name, value),
      removeProperty: (name) => void props.delete(name),
      colorScheme: "",
    },
    setAttribute: (name, value) => void attrs.set(name, value),
    getAttribute: (name) => attrs.get(name) ?? null,
    props,
    attrs,
  };
}

function fakeDocument(): { doc: Document; root: FakeElement; body: FakeElement } {
  const root = fakeElement();
  const body = fakeElement();
  return { doc: { documentElement: root, body } as unknown as Document, root, body };
}

describe("applyAdeTheme", () => {
  beforeEach(() => {
    clearAppliedTheme(fakeElement() as unknown as HTMLElement);
  });

  it("writes identity attributes and the base-mode structural block", () => {
    const { doc, root, body } = fakeDocument();
    applyAdeTheme(resolveTheme(getShippedTheme("parchment")!), doc);
    expect(root.attrs.get("data-theme")).toBe("light");
    expect(root.attrs.get("data-theme-id")).toBe("parchment");
    expect(body.attrs.get("data-theme-id")).toBe("parchment");
    expect(root.style.colorScheme).toBe("light");
  });

  it("writes a custom theme's variables as inline properties", () => {
    const { doc, root } = fakeDocument();
    const custom = {
      formatVersion: 1 as const,
      id: "inline-test",
      name: "Inline Test",
      baseMode: "dark" as const,
      source: "custom" as const,
      palette: { bg: "#101418", fg: "#e6edf7", surface: "#141a22", card: "#18202a", accent: "#60a5fa" },
    };
    applyAdeTheme(resolveTheme(custom), doc);
    expect(root.props.get("--color-bg")).toBe("#101418");
    expect(root.props.get("--color-accent")).toBe("#60a5fa");
    expect(appliedThemeVarNames().length).toBeGreaterThan(0);
  });

  it("clears the previous theme's variables so a switch leaves nothing behind", () => {
    const first = fakeDocument();
    applyAdeTheme(resolveTheme({
      formatVersion: 1,
      id: "one",
      name: "One",
      baseMode: "dark",
      source: "custom",
      palette: { bg: "#101418", fg: "#e6edf7", surface: "#141a22", card: "#18202a", accent: "#60a5fa" },
    }), first.doc);
    const written = appliedThemeVarNames().slice();
    expect(written.length).toBeGreaterThan(0);

    // Switching to a stylesheet theme emits no inline vars, so the previous
    // theme's properties must all be removed.
    const second = fakeDocument();
    applyAdeTheme(resolveTheme(getShippedTheme("dark")!), second.doc);
    for (const name of written) {
      expect(second.root.props.has(name)).toBe(false);
    }
    expect(appliedThemeVarNames()).toEqual([]);
    expect(second.root.attrs.get("data-theme-id")).toBe("dark");
  });
});
