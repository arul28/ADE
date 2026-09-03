/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import { readPluginPageTheme } from "../pageTheme";

afterEach(() => {
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
});

/**
 * jsdom does not resolve custom properties through `getComputedStyle`, so the
 * VALUES come from a stub here. What is under test is the selection — which
 * names cross into a plugin page at all — and that is the half with a rule
 * behind it: exactly the namespaces a plugin theme may set.
 */
function withComputedValues(values: Record<string, string>): void {
  const original = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((element: Element) => {
    const computed = original(element as HTMLElement);
    return {
      ...computed,
      getPropertyValue: (name: string) => values[name] ?? computed.getPropertyValue(name),
    } as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle;
}

describe("readPluginPageTheme", () => {
  it("carries the palette namespaces and nothing else", () => {
    const style = document.createElement("style");
    style.textContent = ":root{--color-bg:#101010;--shell-border:#222;--work-header-h:28px;--secret-token:nope;--x:1}";
    document.head.appendChild(style);
    withComputedValues({
      "--color-bg": " #101010 ",
      "--shell-border": "#222",
      "--work-header-h": "28px",
      "--secret-token": "nope",
    });

    const snapshot = readPluginPageTheme(document, window);
    expect(snapshot.tokens["--color-bg"]).toBe("#101010");
    expect(snapshot.tokens["--shell-border"]).toBe("#222");
    expect(snapshot.tokens["--work-header-h"]).toBe("28px");
    // Not one of `PLUGIN_THEME_TOKEN_PREFIXES`, so it is not part of the
    // palette and a page never sees it.
    expect(snapshot.tokens["--secret-token"]).toBeUndefined();
    expect(snapshot.tokens["--x"]).toBeUndefined();
  });

  it("reports the scheme the app is actually painting", () => {
    expect(readPluginPageTheme(document, window).scheme).toBe("dark");
    document.documentElement.setAttribute("data-theme", "light");
    expect(readPluginPageTheme(document, window).scheme).toBe("light");
  });
});
