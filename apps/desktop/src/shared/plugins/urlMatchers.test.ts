/**
 * The URL-matcher contract, from the grammar up to the manifest field.
 *
 * Two layers in one file for the reason `network.test.ts` gives: the pattern
 * language and the manifest field that accepts it are one promise — "a plugin
 * can claim its own tracker's URLs, and only those" — and a regression in
 * either breaks it the same way. Compiling and matching are proven next door in
 * `smartLinkMatchers.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { CORE_ISSUE_PLUGIN_ID, ISSUE_PROVIDER_GITHUB, ISSUE_PROVIDER_LINEAR } from "../issueRef";
import { describeManifestAdds } from "./installDisclosure";
import { parsePluginManifest, type PluginManifest } from "./manifest";
import {
  compilePluginUrlMatcherPattern,
  CORE_ISSUE_PROVIDERS,
  coreSmartLinkHostOwner,
  isValidPluginUrlMatcherGlyph,
  isValidPluginUrlMatcherHost,
  isValidPluginUrlMatcherPattern,
  isValidPluginUrlMatcherProvider,
  parsePluginUrlMatcherLabelTemplate,
  PLUGIN_URL_MATCHER_CAPTURES_MAX,
  PLUGIN_URL_MATCHER_LABEL_MAX,
  PLUGIN_URL_MATCHER_LABEL_TEMPLATE_MAX,
  PLUGIN_URL_MATCHER_PATTERN_MAX_LENGTH,
  PLUGIN_URL_MATCHER_SEGMENTS_MAX,
  PLUGIN_URL_MATCHERS_PER_PLUGIN,
  renderPluginUrlMatcherLabel,
  sanitizePluginUrlMatcherValue,
} from "./urlMatchers";

/** Compile a pattern and run it, the way `smartLinkMatchers` does. */
function run(pattern: string, pathname: string): RegExpExecArray | null {
  const compiled = compilePluginUrlMatcherPattern(pattern);
  if (!compiled.ok) throw new Error(`pattern refused: ${compiled.reason}`);
  return new RegExp(compiled.compiled.source).exec(pathname);
}

describe("pattern grammar", () => {
  it("matches literal segments and captures one segment each", () => {
    const compiled = compilePluginUrlMatcherPattern("/browse/{key}");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.compiled.captureNames).toEqual(["key"]);
    expect(run("/browse/{key}", "/browse/ACME-12")?.[1]).toBe("ACME-12");
    expect(run("/browse/{key}", "/browse")).toBeNull();
    // A capture is ONE segment. Without this a matcher for `/browse/{key}`
    // would claim `/browse/ACME-12/attachments/secret.pdf` too.
    expect(run("/browse/{key}", "/browse/ACME-12/attachments")).toBeNull();
  });

  it("tolerates a trailing slash and refuses a longer path", () => {
    expect(run("/browse/{key}", "/browse/ACME-12/")).not.toBeNull();
    expect(run("/browse/{key}", "/browse/ACME-12/x")).toBeNull();
    expect(run("/browse/{key}", "/x/browse/ACME-12")).toBeNull();
  });

  it("matches one unnamed segment with * and any tail with **", () => {
    expect(run("/*/issue/{key}", "/acme/issue/ACME-12")?.[1]).toBe("ACME-12");
    expect(run("/*/issue/{key}", "/issue/ACME-12")).toBeNull();

    // `**` is what makes a trailing slug optional, which most trackers have.
    expect(run("/issue/{key}/**", "/issue/ACME-12")?.[1]).toBe("ACME-12");
    expect(run("/issue/{key}/**", "/issue/ACME-12/fix-the-thing")?.[1]).toBe("ACME-12");
    expect(run("/issue/{key}/**", "/issue/ACME-12/a/b/c")?.[1]).toBe("ACME-12");
  });

  it("refuses ** anywhere but last", () => {
    const refused = compilePluginUrlMatcherPattern("/issue/**/{key}");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain("last segment");
  });

  it("escapes every regex metacharacter in a literal segment", () => {
    // The literal charset admits `.`, `+`, `-`, `~`, `@` and `_`. Each is a
    // metacharacter or a range operator somewhere in regex syntax, and each has
    // to match ITSELF. This is the pin: a matcher's literal segments cannot
    // escape into pattern syntax.
    expect(run("/v1.0/{key}", "/v1.0/A-1")?.[1]).toBe("A-1");
    expect(run("/v1.0/{key}", "/v1X0/A-1")).toBeNull();
    expect(run("/a+b/{key}", "/a+b/A-1")?.[1]).toBe("A-1");
    expect(run("/a+b/{key}", "/ab/A-1")).toBeNull();
    expect(run("/a+b/{key}", "/aab/A-1")).toBeNull();
    expect(run("/x-y_z~w@v/{key}", "/x-y_z~w@v/A-1")?.[1]).toBe("A-1");

    const compiled = compilePluginUrlMatcherPattern("/v1.0/a+b");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    // Belt and braces: no unescaped metacharacter survives into the source, so
    // widening the literal charset later cannot silently open a hole.
    expect(compiled.compiled.source).toBe("^/v1\\.0/a\\+b/?$");
  });

  it("refuses a segment that is regex syntax rather than a literal", () => {
    for (const pattern of [
      "/issue/(.*)",
      "/issue/[a-z]+",
      "/issue/a|b",
      "/issue/a{2,3}",
      "/issue/^x",
      "/issue/a\\d",
    ]) {
      expect(isValidPluginUrlMatcherPattern(pattern)).toBe(false);
    }
  });

  it("never writes a capture name into the compiled source", () => {
    // Numbered groups, always. A named group would let a manifest field reach
    // regex syntax through the one place the escaper does not run.
    const ok = compilePluginUrlMatcherPattern("/issue/{issueKey}");
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.compiled.source).not.toContain("issueKey");
    expect(ok.compiled.source).toBe("^/issue/([^/]+)/?$");
  });

  it("treats a capture named after a prototype member as an ordinary name", () => {
    // `constructor` is a legal name in the grammar, so the safety has to be in
    // the lookup rather than in the spelling. A plain `captures[name] ?? ""`
    // would append the source text of `Object.prototype.constructor` to a chip.
    const compiled = compilePluginUrlMatcherPattern("/issue/{constructor}");
    expect(compiled.ok).toBe(true);
    const template = parsePluginUrlMatcherLabelTemplate("#{constructor}", ["constructor"]);
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    expect(renderPluginUrlMatcherLabel(template.parts, { constructor: "A-1" })).toBe("#A-1");
    expect(renderPluginUrlMatcherLabel(template.parts, {})).toBe("#");
    expect(renderPluginUrlMatcherLabel(template.parts, {})).not.toContain("function");
  });

  it("refuses a malformed or oversized pattern", () => {
    expect(isValidPluginUrlMatcherPattern("issue/{key}")).toBe(false);
    expect(isValidPluginUrlMatcherPattern("")).toBe(false);
    expect(isValidPluginUrlMatcherPattern(42)).toBe(false);
    expect(isValidPluginUrlMatcherPattern("/issue/{Key}")).toBe(false);
    expect(isValidPluginUrlMatcherPattern("/issue/{a}/{a}")).toBe(false);
    expect(isValidPluginUrlMatcherPattern(`/${"a".repeat(PLUGIN_URL_MATCHER_PATTERN_MAX_LENGTH)}`))
      .toBe(false);
    expect(isValidPluginUrlMatcherPattern(`/${"a/".repeat(PLUGIN_URL_MATCHER_SEGMENTS_MAX + 2)}b`))
      .toBe(false);
    const tooManyCaptures = Array.from(
      { length: PLUGIN_URL_MATCHER_CAPTURES_MAX + 1 },
      (_, index) => `{c${index}}`,
    ).join("/");
    expect(isValidPluginUrlMatcherPattern(`/${tooManyCaptures}`)).toBe(false);
  });
});

describe("core-owned hosts", () => {
  it("names the owner of a host core already parses", () => {
    expect(coreSmartLinkHostOwner("github.com")).toBe("GitHub");
    expect(coreSmartLinkHostOwner("linear.app")).toBe("Linear");
    expect(coreSmartLinkHostOwner("GitHub.com")).toBe("GitHub");
    expect(coreSmartLinkHostOwner("tracker.example.com")).toBeNull();
  });

  it("refuses a wildcard that would cover a core host, and allows one that would not", () => {
    expect(isValidPluginUrlMatcherHost("*.github.com")).toBe(false);
    expect(isValidPluginUrlMatcherHost("github.com")).toBe(false);
    expect(isValidPluginUrlMatcherHost("linear.app")).toBe(false);
    // A wildcard over a core DOMAIN is refused too, not just the apex: the
    // domain is what is being claimed, and `*.linear.app` would let a plugin
    // draw its own chips on every other name under Linear.
    expect(isValidPluginUrlMatcherHost("*.linear.app")).toBe(false);
    expect(isValidPluginUrlMatcherHost("*.atlassian.net")).toBe(true);
  });

  it("inherits the network host grammar rather than spelling a second one", () => {
    expect(isValidPluginUrlMatcherHost("Tracker.Example.com")).toBe(false);
    expect(isValidPluginUrlMatcherHost("https://tracker.example.com")).toBe(false);
    expect(isValidPluginUrlMatcherHost("tracker.example.com:443")).toBe(false);
    expect(isValidPluginUrlMatcherHost("10.0.0.1")).toBe(false);
    expect(isValidPluginUrlMatcherHost("*.com")).toBe(false);
  });
});

describe("entity provider", () => {
  it("refuses every provider ADE speaks for", () => {
    expect(isValidPluginUrlMatcherProvider("jira")).toBe(true);
    expect(isValidPluginUrlMatcherProvider(ISSUE_PROVIDER_LINEAR)).toBe(false);
    expect(isValidPluginUrlMatcherProvider(ISSUE_PROVIDER_GITHUB)).toBe(false);
    expect(isValidPluginUrlMatcherProvider(CORE_ISSUE_PLUGIN_ID)).toBe(false);
  });

  it("keeps the local list in step with issueRef", () => {
    // The list is spelled locally because this module sits under `manifest.ts`
    // and cannot import upward. Pinned here so the two cannot drift.
    expect(CORE_ISSUE_PROVIDERS).toContain(ISSUE_PROVIDER_LINEAR);
    expect(CORE_ISSUE_PROVIDERS).toContain(ISSUE_PROVIDER_GITHUB);
    expect(CORE_ISSUE_PROVIDERS).toContain(CORE_ISSUE_PLUGIN_ID);
  });

  it("refuses a malformed provider", () => {
    expect(isValidPluginUrlMatcherProvider("Jira")).toBe(false);
    expect(isValidPluginUrlMatcherProvider("9tracker")).toBe(false);
    expect(isValidPluginUrlMatcherProvider("")).toBe(false);
    expect(isValidPluginUrlMatcherProvider("a".repeat(40))).toBe(false);
  });
});

describe("label template", () => {
  it("splits literal text from capture references", () => {
    const parsed = parsePluginUrlMatcherLabelTemplate("JIRA {key} ({project})", ["key", "project"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.parts).toEqual([
      { text: "JIRA " },
      { capture: "key" },
      { text: " (" },
      { capture: "project" },
      { text: ")" },
    ]);
  });

  it("refuses a reference the pattern does not capture", () => {
    const parsed = parsePluginUrlMatcherLabelTemplate("{missing}", ["key"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("does not capture");
  });

  it("refuses unbalanced braces, emptiness and oversize", () => {
    expect(parsePluginUrlMatcherLabelTemplate("{key", ["key"]).ok).toBe(false);
    expect(parsePluginUrlMatcherLabelTemplate("key}", ["key"]).ok).toBe(false);
    expect(parsePluginUrlMatcherLabelTemplate("   ", ["key"]).ok).toBe(false);
    expect(parsePluginUrlMatcherLabelTemplate(7, ["key"]).ok).toBe(false);
    expect(
      parsePluginUrlMatcherLabelTemplate("x".repeat(PLUGIN_URL_MATCHER_LABEL_TEMPLATE_MAX + 1), []).ok,
    ).toBe(false);
  });

  it("bounds and cleans what a rendered label can say", () => {
    const parsed = parsePluginUrlMatcherLabelTemplate("{key}", ["key"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Percent-decoded, because a chip reading `ADE%2D123` shows the wrong thing.
    expect(renderPluginUrlMatcherLabel(parsed.parts, { key: "ACME%2D12" })).toBe("ACME-12");
    // Clamped: a capture is a path segment and a URL can carry a very long one.
    const long = renderPluginUrlMatcherLabel(parsed.parts, { key: "z".repeat(500) });
    expect(long.length).toBeLessThanOrEqual(PLUGIN_URL_MATCHER_LABEL_MAX);
    // A capture nothing filled renders as nothing, never as the placeholder.
    expect(renderPluginUrlMatcherLabel(parsed.parts, {})).toBe("");
  });

  it("strips the invisible characters that would rewrite the sentence around a chip", () => {
    // Built from code points rather than written literally: these characters are
    // invisible, so a source file that spells them cannot be reviewed or grepped.
    const RTL_OVERRIDE = String.fromCodePoint(0x202e);
    const NUL = String.fromCodePoint(0x00);
    const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
    const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

    // A chip sits inline with the user's own words, so a right-to-left override
    // inside a captured value reorders the text around it.
    expect(sanitizePluginUrlMatcherValue(`AC${RTL_OVERRIDE}ME`)).toBe("ACME");
    expect(sanitizePluginUrlMatcherValue(`A${NUL}BC`)).toBe("ABC");
    expect(sanitizePluginUrlMatcherValue(`A${ZERO_WIDTH_SPACE}B${BYTE_ORDER_MARK}C`)).toBe("ABC");
    expect(sanitizePluginUrlMatcherValue("  A   B  ")).toBe("A B");
    expect(isValidPluginUrlMatcherGlyph(`A${RTL_OVERRIDE}`)).toBe(false);
  });

  it("accepts one or two plain characters as a glyph and nothing else", () => {
    expect(isValidPluginUrlMatcherGlyph("J")).toBe(true);
    expect(isValidPluginUrlMatcherGlyph("JR")).toBe(true);
    // Counted in code points, so one emoji is one character.
    expect(isValidPluginUrlMatcherGlyph("\u{1F41B}")).toBe(true);
    expect(isValidPluginUrlMatcherGlyph("JIRA")).toBe(false);
    expect(isValidPluginUrlMatcherGlyph("")).toBe(false);
    expect(isValidPluginUrlMatcherGlyph("<svg/>")).toBe(false);
  });
});

/* ── The manifest field ─────────────────────────────────────────────────── */

const BASE_MANIFEST = {
  name: "acme-tracker",
  version: "1.0.0",
  displayName: "Acme Tracker",
  description: "Tracks things.",
  vocabVersion: 1,
};

function parseWith(urlMatchers: unknown): {
  manifest: PluginManifest | null;
  errors: string[];
  warnings: string[];
} {
  return parsePluginManifest({ ...BASE_MANIFEST, urlMatchers });
}

const VALID_MATCHER = {
  id: "issue",
  hosts: ["acme.atlassian.net"],
  pathPattern: "/browse/{key}/**",
  chip: { label: "ACME {key}", icon: "AT" },
  entity: { kind: "issue", provider: "acme", keyFrom: "key" },
};

describe("urlMatchers in the manifest", () => {
  it("accepts a well-formed matcher", () => {
    const { manifest, errors } = parseWith([VALID_MATCHER]);
    expect(errors).toEqual([]);
    expect(manifest?.urlMatchers).toEqual([
      {
        id: "issue",
        hosts: ["acme.atlassian.net"],
        pathPattern: "/browse/{key}/**",
        chip: { label: "ACME {key}", icon: "AT" },
        entity: { kind: "issue", provider: "acme", keyFrom: "key" },
      },
    ]);
  });

  it("is absent-means-none, and never an error", () => {
    expect(parseWith(undefined).manifest?.urlMatchers).toEqual([]);
    expect(parseWith(undefined).errors).toEqual([]);
  });

  it("refuses a core-owned host by name, and says who owns it", () => {
    const { manifest, warnings } = parseWith([
      { ...VALID_MATCHER, hosts: ["linear.app", "acme.atlassian.net"] },
    ]);
    expect(warnings.some((line) => line.includes("Linear"))).toBe(true);
    // The rest of the matcher survives: only the claimed host is dropped.
    expect(manifest?.urlMatchers?.[0]?.hosts).toEqual(["acme.atlassian.net"]);
  });

  it("drops a matcher whose only hosts are core-owned", () => {
    const { manifest, warnings } = parseWith([{ ...VALID_MATCHER, hosts: ["github.com"] }]);
    expect(manifest?.urlMatchers).toEqual([]);
    expect(warnings.some((line) => line.includes("GitHub"))).toBe(true);
  });

  it("drops a matcher whose pathPattern is not in the grammar", () => {
    const { manifest, warnings } = parseWith([{ ...VALID_MATCHER, pathPattern: "/browse/(.*)" }]);
    expect(manifest?.urlMatchers).toEqual([]);
    expect(warnings.some((line) => line.includes("pathPattern"))).toBe(true);
  });

  it("drops a matcher whose label names a capture the pattern does not declare", () => {
    const { manifest, warnings } = parseWith([
      { ...VALID_MATCHER, chip: { label: "{project}" } },
    ]);
    expect(manifest?.urlMatchers).toEqual([]);
    expect(warnings.some((line) => line.includes("chip.label"))).toBe(true);
  });

  it("drops a matcher claiming a provider ADE speaks for", () => {
    const { manifest, warnings } = parseWith([
      { ...VALID_MATCHER, entity: { kind: "issue", provider: "linear", keyFrom: "key" } },
    ]);
    expect(manifest?.urlMatchers).toEqual([]);
    expect(warnings.some((line) => line.includes("entity.provider"))).toBe(true);
  });

  it("drops a matcher whose keyFrom is not a capture", () => {
    const { manifest } = parseWith([
      { ...VALID_MATCHER, entity: { kind: "issue", provider: "acme", keyFrom: "nope" } },
    ]);
    expect(manifest?.urlMatchers).toEqual([]);
  });

  it("keeps the matcher but drops a glyph that is not one or two plain characters", () => {
    // The chip has a monogram to fall back to, so losing the whole link over its
    // badge would be the worse trade.
    const { manifest, warnings } = parseWith([
      { ...VALID_MATCHER, chip: { label: "ACME {key}", icon: "<img src=x>" } },
    ]);
    expect(manifest?.urlMatchers?.[0]?.chip).toEqual({ label: "ACME {key}" });
    expect(warnings.some((line) => line.includes("chip.icon"))).toBe(true);
  });

  it("caps how many matchers one plugin may declare, and refuses duplicate ids", () => {
    const many = Array.from({ length: PLUGIN_URL_MATCHERS_PER_PLUGIN + 3 }, (_, index) => ({
      ...VALID_MATCHER,
      id: `m${index}`,
    }));
    const { manifest, warnings } = parseWith(many);
    expect(manifest?.urlMatchers).toHaveLength(PLUGIN_URL_MATCHERS_PER_PLUGIN);
    expect(warnings.some((line) => line.includes("urlMatchers"))).toBe(true);

    const duplicated = parseWith([VALID_MATCHER, { ...VALID_MATCHER, hosts: ["b.example.com"] }]);
    expect(duplicated.manifest?.urlMatchers).toHaveLength(1);
  });

  it("treats a malformed container as an error and a malformed entry as a warning", () => {
    expect(parseWith("nope").errors.some((line) => line.includes("urlMatchers"))).toBe(true);
    const entry = parseWith([{ ...VALID_MATCHER, id: "" }]);
    expect(entry.errors).toEqual([]);
    expect(entry.warnings.length).toBeGreaterThan(0);
  });
});

describe("the install card", () => {
  it("names the domains whose links the plugin will rewrite", () => {
    // A matcher changes what the reader's OWN pasted links look like, so the
    // card names the domains rather than counting the rules.
    const { manifest } = parseWith([
      VALID_MATCHER,
      { ...VALID_MATCHER, id: "board", hosts: ["acme.atlassian.net", "acme.example.com"] },
    ]);
    expect(manifest).not.toBeNull();
    const lines = describeManifestAdds(manifest as PluginManifest);
    expect(lines).toContain("Turns acme.atlassian.net and acme.example.com links into chips");
  });

  it("says nothing when the plugin claims no URLs", () => {
    const { manifest } = parseWith(undefined);
    const lines = describeManifestAdds(manifest as PluginManifest);
    expect(lines.some((line) => line.includes("into chips"))).toBe(false);
  });
});
