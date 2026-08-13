import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PLUGIN_REGISTRY_LIMITS,
  isSafeRegistryUrl,
  parsePluginRegistryEntry,
  parsePluginRegistryIndex,
  parsePluginRegistryIndexJson,
  requiresChecksumVerification,
  verifyPluginChecksum,
} from "./registryIndex";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pluginId: "graph",
    displayName: "Graph",
    description: "The lane and commit graph, as its own tab.",
    author: "ADE",
    version: "1.0.0",
    repo: "https://github.com/ade-plugins/graph",
    ...overrides,
  };
}

describe("registry entry parsing", () => {
  it("keeps a well-formed entry and derives the installable source from the repo", () => {
    const parsed = parsePluginRegistryEntry(entry({
      surfaces: ["lanes", "not-a-surface"],
      sockets: ["row-menu-item", "nonsense"],
      installs: 12.4,
      stars: 7,
      adds: ["Graph tab", 42],
    }));
    expect(parsed).not.toHaveProperty("reason");
    if ("reason" in parsed) return;
    expect(parsed.entry).toMatchObject({
      pluginId: "graph",
      version: "1.0.0",
      repo: "https://github.com/ade-plugins/graph",
      source: "https://github.com/ade-plugins/graph",
      surfaces: ["lanes"],
      sockets: ["row-menu-item"],
      installs: 12,
      stars: 7,
      adds: ["Graph tab"],
    });
  });

  it("refuses an entry whose identity would not be a plugin", () => {
    const rejected: Array<[string, Record<string, unknown>]> = [
      ["path traversal in the id", entry({ pluginId: "../escape" })],
      ["uppercase id", entry({ pluginId: "Graph" })],
      ["missing version", entry({ version: undefined })],
      ["non-semver version", entry({ version: "latest" })],
      ["missing repo", entry({ repo: undefined })],
    ];
    for (const [label, raw] of rejected) {
      const parsed = parsePluginRegistryEntry(raw);
      expect(parsed, label).toHaveProperty("reason");
    }
  });

  it("refuses source URLs that are not plain https", () => {
    // A directory entry is third-party text and its source URL reaches `git`.
    expect(isSafeRegistryUrl("http://github.com/x/y")).toBe(false);
    expect(isSafeRegistryUrl("https://user:token@github.com/x/y")).toBe(false);
    expect(isSafeRegistryUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRegistryUrl("git@github.com:x/y.git")).toBe(false);
    expect(isSafeRegistryUrl("https://github.com/x/y")).toBe(true);
  });

  it("falls back to the repo when the source URL is unusable", () => {
    const parsed = parsePluginRegistryEntry(entry({ source: "http://mirror.example/graph" }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.source).toBe("https://github.com/ade-plugins/graph");
  });

  it("refuses an official claim from outside ADE's curated repositories", () => {
    const forged = parsePluginRegistryEntry(entry({
      official: true,
      repo: "https://github.com/attacker/graph",
    }));
    if ("reason" in forged) throw new Error(forged.reason);
    expect(forged.entry.official).toBe(false);
    expect(forged.warnings.join(" ")).toContain("claims official");

    // A path that only LOOKS curated until a URL parser normalizes it.
    const traversal = parsePluginRegistryEntry(entry({
      official: true,
      repo: "https://github.com/ade-plugins/../attacker/graph",
    }));
    if ("reason" in traversal) throw new Error(traversal.reason);
    expect(traversal.entry.official).toBe(false);

    const real = parsePluginRegistryEntry(entry({ official: true }));
    if ("reason" in real) throw new Error(real.reason);
    expect(real.entry.official).toBe(true);
    expect(real.warnings).toEqual([]);
  });

  it("refuses an accent that is not a hex colour, since it reaches a CSS property", () => {
    const parsed = parsePluginRegistryEntry(entry({ accent: "red;color:blue" }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.accent).toBeNull();
    expect(parsed.warnings.join(" ")).toContain("not a hex colour");

    // Anything past the length ceiling never reaches the hex check, and must
    // still not reach the stylesheet.
    const long = parsePluginRegistryEntry(entry({ accent: "red; background: url(https://exfil.example)" }));
    if ("reason" in long) throw new Error(long.reason);
    expect(long.entry.accent).toBeNull();

    const good = parsePluginRegistryEntry(entry({ accent: "#7C6FF0" }));
    if ("reason" in good) throw new Error(good.reason);
    expect(good.entry.accent).toBe("#7C6FF0");
  });

  it("counts the live publishing owner as curated", () => {
    // The official set is published under `arul28` today. Getting this wrong is
    // not cosmetic: `official` also decides whether an install is refused for a
    // missing checksum, so a demoted entry silently loses its tamper check.
    const parsed = parsePluginRegistryEntry(entry({
      official: true,
      repo: "https://github.com/arul28/ade-graph",
    }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.official).toBe(true);
    expect(parsed.warnings).toEqual([]);
  });

  it("reads the icon under its published name and its older one", () => {
    const published = parsePluginRegistryEntry(entry({
      iconGlyph: "graph",
      iconColor: "#7C6FF0",
      icon: "puzzle",
      accent: "#111111",
    }));
    if ("reason" in published) throw new Error(published.reason);
    expect(published.entry.icon).toBe("graph");
    expect(published.entry.accent).toBe("#7C6FF0");

    const legacy = parsePluginRegistryEntry(entry({ icon: "puzzle", accent: "#111111" }));
    if ("reason" in legacy) throw new Error(legacy.reason);
    expect(legacy.entry.icon).toBe("puzzle");
    expect(legacy.entry.accent).toBe("#111111");
  });

  it("keeps only media items the app could render", () => {
    const parsed = parsePluginRegistryEntry(entry({
      media: [
        { kind: "image", src: "https://raw.githubusercontent.com/a/b/main/one.png", caption: "One" },
        { kind: "video", src: "https://raw.githubusercontent.com/a/b/main/clip.mp4" },
        // Every one of these is dropped, and the rest of the list survives.
        { kind: "image", src: "http://insecure.example/two.png" },
        { kind: "image", src: "javascript:alert(1)" },
        { kind: "gif", src: "https://raw.githubusercontent.com/a/b/main/three.gif" },
        { src: "https://raw.githubusercontent.com/a/b/main/four.png" },
        "not an object",
      ],
    }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.media).toEqual([
      { kind: "image", src: "https://raw.githubusercontent.com/a/b/main/one.png", caption: "One" },
      { kind: "video", src: "https://raw.githubusercontent.com/a/b/main/clip.mp4", caption: null },
    ]);
  });

  it("caps the gallery and tolerates media that is not a list", () => {
    const many = Array.from({ length: PLUGIN_REGISTRY_LIMITS.maxMedia + 4 }, (_unused, index) => ({
      kind: "image",
      src: `https://raw.githubusercontent.com/a/b/main/${index}.png`,
    }));
    const parsed = parsePluginRegistryEntry(entry({ media: many }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.media).toHaveLength(PLUGIN_REGISTRY_LIMITS.maxMedia);

    const notAList = parsePluginRegistryEntry(entry({ media: { kind: "image" } }));
    if ("reason" in notAList) throw new Error(notAList.reason);
    expect(notAList.entry.media).toEqual([]);
  });

  it("keeps only https links, and always has a repository one", () => {
    const parsed = parsePluginRegistryEntry(entry({
      iconUrl: "http://insecure.example/icon.png",
      links: {
        repository: "https://github.com/arul28/ade-graph",
        homepage: "http://insecure.example",
        docs: "https://docs.example/graph",
        license: "javascript:alert(1)",
      },
    }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.iconUrl).toBeNull();
    expect(parsed.entry.links).toEqual({
      repository: "https://github.com/arul28/ade-graph",
      homepage: null,
      changelog: null,
      license: null,
      docs: "https://docs.example/graph",
    });

    // An entry that publishes no links at all still points somewhere.
    const bare = parsePluginRegistryEntry(entry());
    if ("reason" in bare) throw new Error(bare.reason);
    expect(bare.entry.links.repository).toBe("https://github.com/ade-plugins/graph");
  });

  it("reads a download size and the extra downloads a plugin declares", () => {
    const parsed = parsePluginRegistryEntry(entry({
      sizeBytes: 4_404_019.6,
      extraDownloads: [{ label: "Speech model", bytes: 147_800_000 }],
    }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.sizeBytes).toBe(4_404_020);
    expect(parsed.entry.extraDownloads).toEqual([{ label: "Speech model", bytes: 147_800_000 }]);
  });

  it("treats an unmeasured, impossible or malformed size as no size at all", () => {
    // Absent is the common case and must not become a number. Zero is the
    // interesting one: the crawler derives sizes from an API that reports 0 for
    // a repository it has not sized, and "0 B" on the page is a confident wrong
    // answer where nothing is the true one.
    for (const value of [undefined, 0, -1, "4 MB", Number.NaN, Number.POSITIVE_INFINITY, 1e30]) {
      const parsed = parsePluginRegistryEntry(entry({ sizeBytes: value }));
      if ("reason" in parsed) throw new Error(parsed.reason);
      expect(parsed.entry.sizeBytes, `sizeBytes ${String(value)}`).toBeNull();
    }
  });

  it("drops an unreadable extra download without dropping the entry", () => {
    const parsed = parsePluginRegistryEntry(entry({
      extraDownloads: [
        { label: "Speech model", bytes: 147_800_000 },
        { label: "", bytes: 10 },
        { label: "No size" },
        { label: "Negative", bytes: -5 },
        { label: "x".repeat(PLUGIN_REGISTRY_LIMITS.maxDownloadLabelChars + 1), bytes: 10 },
        "not an object",
      ],
    }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.extraDownloads).toEqual([{ label: "Speech model", bytes: 147_800_000 }]);

    const notAList = parsePluginRegistryEntry(entry({ extraDownloads: { label: "Speech model", bytes: 10 } }));
    if ("reason" in notAList) throw new Error(notAList.reason);
    expect(notAList.entry.extraDownloads).toEqual([]);
  });

  it("caps the number of extra downloads an entry may publish", () => {
    const parsed = parsePluginRegistryEntry(entry({
      extraDownloads: Array.from({ length: PLUGIN_REGISTRY_LIMITS.maxExtraDownloads + 3 }, (_unused, index) => ({
        label: `Asset ${index}`,
        bytes: 1024,
      })),
    }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.extraDownloads).toHaveLength(PLUGIN_REGISTRY_LIMITS.maxExtraDownloads);
  });

  it("drops checksums that are not a version mapped to a sha256", () => {
    const parsed = parsePluginRegistryEntry(entry({
      checksums: { "1.0.0": DIGEST_A, "not-a-version": DIGEST_B, "1.1.0": "short" },
    }));
    if ("reason" in parsed) throw new Error(parsed.reason);
    expect(parsed.entry.checksums).toEqual({ "1.0.0": DIGEST_A });
  });
});

describe("registry index parsing", () => {
  it("drops a bad entry without losing the index", () => {
    const result = parsePluginRegistryIndex({
      version: 1,
      generatedAt: "2026-08-11T00:00:00.000Z",
      entries: [entry(), { pluginId: "Bad Id", version: "1.0.0" }, entry({ pluginId: "history" })],
    });
    expect(result.index?.entries.map((row) => row.pluginId)).toEqual(["graph", "history"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("keeps the first claim on a duplicated plugin id", () => {
    const result = parsePluginRegistryIndex({
      version: 1,
      entries: [
        entry({ displayName: "Official graph" }),
        entry({ displayName: "Impostor", repo: "https://github.com/someone/graph" }),
      ],
    });
    expect(result.index?.entries).toHaveLength(1);
    expect(result.index?.entries[0]?.displayName).toBe("Official graph");
  });

  it("accepts an index from a newer registry rather than refusing the document", () => {
    const result = parsePluginRegistryIndex({
      version: 99,
      entries: [entry({ somethingThisBuildHasNeverHeardOf: true })],
    });
    expect(result.index?.entries).toHaveLength(1);
  });

  it("refuses a document that is not an index", () => {
    expect(parsePluginRegistryIndex(null).index).toBeNull();
    expect(parsePluginRegistryIndex({ entries: [] }).index).toBeNull();
    expect(parsePluginRegistryIndex({ version: 1 }).index).toBeNull();
  });

  it("refuses an oversized document before parsing it", () => {
    const oversized = " ".repeat(PLUGIN_REGISTRY_LIMITS.maxBytes + 1);
    const result = parsePluginRegistryIndexJson(oversized);
    expect(result.index).toBeNull();
    expect(result.errors[0]).toContain("byte ceiling");
  });

  it("refuses an entry count above the ceiling", () => {
    const result = parsePluginRegistryIndex({
      version: 1,
      entries: new Array(PLUGIN_REGISTRY_LIMITS.maxEntries + 1).fill(entry()),
    });
    expect(result.index).toBeNull();
  });

  it("reports a JSON syntax error rather than throwing", () => {
    const result = parsePluginRegistryIndexJson("{ nope");
    expect(result.index).toBeNull();
    expect(result.errors[0]).toContain("not valid JSON");
  });
});

describe("the seed index in registry/", () => {
  // The seed lives at the repo root until it is extracted into the standalone
  // registry repository (registry/README.md, "Extraction"). Once it moves, this
  // case has nothing to check and skips rather than failing — the enforcing
  // parser is what ships, and it is covered above.
  const seedPath = path.join(__dirname, "..", "..", "..", "..", "..", "registry", "index.json");
  const present = fs.existsSync(seedPath);

  it.runIf(present)("parses with no dropped entries", () => {
    const result = parsePluginRegistryIndexJson(fs.readFileSync(seedPath, "utf8"));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.index?.entries.length).toBeGreaterThan(0);
    // Every official plugin the app bundles must exist in the directory, or the
    // directory would look like it is missing the plugins ADE itself ships. The
    // full agreement — versions, descriptions, theme flags — is checked against
    // the packages themselves in `pilotPackages.test.ts`; this is the floor.
    const ids = result.index?.entries.map((row) => row.pluginId) ?? [];
    for (const pluginId of ["ade-graph", "ade-log-viewer"]) {
      expect(ids).toContain(pluginId);
    }
  });

  it.runIf(present)("only marks featured plugins that featured.json curates", () => {
    const index = parsePluginRegistryIndexJson(fs.readFileSync(seedPath, "utf8")).index;
    const featured = JSON.parse(
      fs.readFileSync(path.join(path.dirname(seedPath), "featured.json"), "utf8"),
    ) as { featured: string[] };
    const marked = (index?.entries ?? []).filter((row) => row.featured).map((row) => row.pluginId);
    expect(marked.sort()).toEqual([...featured.featured].sort());
  });
});

describe("official signing", () => {
  const official = { official: true, checksums: { "1.0.0": DIGEST_A } };

  it("verifies a matching digest, case-insensitively", () => {
    expect(verifyPluginChecksum({ entry: official, version: "1.0.0", actual: DIGEST_A.toUpperCase() }))
      .toEqual({ kind: "verified" });
  });

  it("reports a mismatch rather than silently accepting it", () => {
    expect(verifyPluginChecksum({ entry: official, version: "1.0.0", actual: DIGEST_B }))
      .toMatchObject({ kind: "mismatch", expected: DIGEST_A });
    // A digest that is not even a sha256 is a mismatch, never an "unverified"
    // pass: the installer computed something, and it is not what was published.
    expect(verifyPluginChecksum({ entry: official, version: "1.0.0", actual: "" }))
      .toMatchObject({ kind: "mismatch" });
  });

  it("distinguishes an unvouched-for version from a tampered one", () => {
    expect(verifyPluginChecksum({ entry: official, version: "2.0.0", actual: DIGEST_A }).kind)
      .toBe("unverified");
    expect(verifyPluginChecksum({
      entry: { official: false, checksums: {} },
      version: "1.0.0",
      actual: DIGEST_A,
    }).kind).toBe("unverified");
  });

  it("requires verification only where a digest was actually published", () => {
    expect(requiresChecksumVerification(official, "1.0.0")).toBe(true);
    expect(requiresChecksumVerification(official, "2.0.0")).toBe(false);
    expect(requiresChecksumVerification({ official: false, checksums: { "1.0.0": DIGEST_A } }, "1.0.0"))
      .toBe(false);
  });
});
