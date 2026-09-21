import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS_PRESET_ACCENT,
  HARNESS_PRESET_EXPORT_KIND,
  HARNESS_PRESET_EXPORT_VERSION,
  HARNESS_PRESET_LOGO_EXPORT_MAX_BYTES,
  HARNESS_PRESET_SUBAGENT_INHERIT,
  HarnessPresetImportError,
  exportHarnessPreset,
  harnessPresetAgentOverrideNote,
  harnessPresetMatchesQuery,
  importHarnessPreset,
  normalizeHarnessPresetList,
  presetSourceLabel,
  presetSubagentLabel,
  presetSummary,
  uniqueHarnessPresetName,
  validateHarnessPreset,
  type HarnessPreset,
} from "./harnessPresets";

function preset(overrides: Partial<HarnessPreset> = {}): HarnessPreset {
  return {
    id: "hp_1",
    name: "Opus on work",
    harness: "claude",
    source: { kind: "account", provider: "claude", instanceId: "claude-work" },
    model: "claude-opus-4-5",
    subagentModel: HARNESS_PRESET_SUBAGENT_INHERIT,
    agentOverrides: {},
    permissionMode: "default",
    accentColor: "#d97757",
    logo: { kind: "ade" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function dataUrlOfBytes(bytes: number): string {
  // 4 base64 chars per 3 bytes, no padding when the length is a multiple of 3.
  const base64Length = Math.ceil(bytes / 3) * 4;
  return `data:image/png;base64,${"A".repeat(base64Length)}`;
}

describe("validateHarnessPreset", () => {
  it("accepts a complete draft", () => {
    expect(validateHarnessPreset(preset())).toEqual({});
  });

  it("names every missing field rather than failing on the first one", () => {
    const errors = validateHarnessPreset({
      name: "   ",
      harness: "not-a-harness" as HarnessPreset["harness"],
      model: "",
      source: { kind: "account", provider: "claude", instanceId: "" } as HarnessPreset["source"],
    });
    expect(Object.keys(errors).sort()).toEqual(["harness", "model", "name", "source"]);
    expect(errors.name).toMatch(/name/i);
  });

  it("rejects an accent that is not six-digit hex", () => {
    expect(validateHarnessPreset(preset({ accentColor: "rebeccapurple" })).accentColor).toBeTruthy();
    expect(validateHarnessPreset(preset({ accentColor: "#abc" })).accentColor).toBeTruthy();
    expect(validateHarnessPreset(preset({ accentColor: "#AABBCC" })).accentColor).toBeUndefined();
  });

  it("rejects a logo that is not an image data URL", () => {
    expect(
      validateHarnessPreset(preset({ logo: { kind: "upload", dataUrl: "https://example.com/a.png" } })).logo,
    ).toBeTruthy();
    expect(
      validateHarnessPreset(preset({ logo: { kind: "upload", dataUrl: "data:image/png;base64,AAAA" } })).logo,
    ).toBeUndefined();
  });

  it("refuses an account source for a provider that holds one identity", () => {
    const errors = validateHarnessPreset(
      preset({ source: { kind: "account", provider: "cursor" as "claude", instanceId: "x" } }),
    );
    expect(errors.source).toBeTruthy();
  });
});

describe("normalizeHarnessPresetList", () => {
  it("drops rows that could never be launched and de-duplicates ids", () => {
    const rows = [
      preset(),
      preset({ id: "hp_1", name: "Duplicate id" }),
      { ...preset({ id: "hp_2" }), model: "" },
      { ...preset({ id: "hp_3" }), harness: "nonsense" },
      "not an object",
    ];
    const normalized = normalizeHarnessPresetList(rows);
    expect(normalized.map((entry) => entry.id)).toEqual(["hp_1"]);
  });

  it("fills in the defaults a partial row is missing", () => {
    const [normalized] = normalizeHarnessPresetList([
      {
        id: "hp_9",
        harness: "codex",
        source: { kind: "subscription", provider: "codex" },
        model: "gpt-5-codex",
      },
    ]);
    expect(normalized?.name).toBe("Codex CLI");
    expect(normalized?.subagentModel).toBe(HARNESS_PRESET_SUBAGENT_INHERIT);
    expect(normalized?.permissionMode).toBe("default");
    expect(normalized?.accentColor).toBe(DEFAULT_HARNESS_PRESET_ACCENT);
    expect(normalized?.logo).toEqual({ kind: "ade" });
    expect(normalized?.updatedAt).toBe(normalized?.createdAt);
  });

  it("returns an empty list for anything that is not an array", () => {
    expect(normalizeHarnessPresetList(null)).toEqual([]);
    expect(normalizeHarnessPresetList({ presets: [] })).toEqual([]);
  });
});

describe("exportHarnessPreset", () => {
  it("carries a key reference and never a key value", () => {
    const withStrayKey = {
      ...preset({
        source: { kind: "key", provider: "anthropic", credentialId: "cred_7", label: "Anthropic (personal)" },
      }),
    } as HarnessPreset & { source: Record<string, unknown> };
    // A writer elsewhere stapling the value onto the in-memory object must not
    // reach the file: export rebuilds the source from a fixed field list.
    (withStrayKey.source as Record<string, unknown>).apiKey = "sk-ant-secret";

    const exported = exportHarnessPreset(withStrayKey as HarnessPreset);
    const json = JSON.stringify(exported);
    expect(json).not.toContain("sk-ant-secret");
    expect(json).not.toContain("apiKey");
    expect(exported.preset.source).toEqual({
      kind: "key",
      provider: "anthropic",
      credentialId: "cred_7",
      label: "Anthropic (personal)",
    });
    expect(exported.notes.join(" ")).toMatch(/key itself is not in this file/i);
  });

  it("leaves this machine's bookkeeping behind", () => {
    const exported = exportHarnessPreset(preset());
    expect(exported.kind).toBe(HARNESS_PRESET_EXPORT_KIND);
    expect(exported.version).toBe(HARNESS_PRESET_EXPORT_VERSION);
    expect(exported.preset).not.toHaveProperty("id");
    expect(exported.preset).not.toHaveProperty("createdAt");
    expect(exported.preset).not.toHaveProperty("updatedAt");
  });

  it("keeps a small logo and drops an oversized one with a note", () => {
    const small = exportHarnessPreset(
      preset({ logo: { kind: "upload", dataUrl: dataUrlOfBytes(4096) } }),
    );
    expect(small.preset.logo.kind).toBe("upload");
    expect(small.notes.some((note) => /logo/i.test(note))).toBe(false);

    const large = exportHarnessPreset(
      preset({ logo: { kind: "upload", dataUrl: dataUrlOfBytes(HARNESS_PRESET_LOGO_EXPORT_MAX_BYTES + 4096) } }),
    );
    expect(large.preset.logo).toEqual({ kind: "ade" });
    expect(large.notes.some((note) => /logo was too large/i.test(note))).toBe(true);
  });
});

describe("importHarnessPreset", () => {
  it("round-trips a preset into a draft with no id or timestamps", () => {
    const exported = exportHarnessPreset(preset());
    const { preset: draft, missing } = importHarnessPreset(exported, {
      accountInstanceIds: ["claude-work"],
    });
    expect(missing).toEqual([]);
    expect(draft).not.toHaveProperty("id");
    expect(draft.name).toBe("Opus on work");
    expect(draft.model).toBe("claude-opus-4-5");
    expect(draft.harness).toBe("claude");
  });

  it("reports an account this machine does not hold", () => {
    const exported = exportHarnessPreset(preset());
    expect(importHarnessPreset(exported, { accountInstanceIds: [] }).missing).toEqual(["account"]);
  });

  it("reports a key this machine does not hold", () => {
    const exported = exportHarnessPreset(
      preset({ source: { kind: "key", provider: "openai", credentialId: "cred_x", label: "OpenAI" } }),
    );
    expect(importHarnessPreset(exported, { credentialIds: ["cred_other"] }).missing).toEqual(["key"]);
    expect(importHarnessPreset(exported, { credentialIds: ["cred_x"] }).missing).toEqual([]);
  });

  it("reports a proxy sign-in the host cannot perform", () => {
    const exported = exportHarnessPreset(
      preset({ harness: "droid", source: { kind: "subscription", provider: "claude" } }),
    );
    expect(importHarnessPreset(exported).missing).toEqual(["subscription-signin"]);
    expect(importHarnessPreset(exported, { proxySignInAvailable: true }).missing).toEqual([]);
  });

  it("accepts the JSON text a file picker hands back", () => {
    const text = JSON.stringify(exportHarnessPreset(preset()));
    expect(importHarnessPreset(text, { accountInstanceIds: ["claude-work"] }).preset.name).toBe("Opus on work");
  });

  it("refuses a file that is not a harness, in a sentence", () => {
    expect(() => importHarnessPreset("{not json")).toThrow(HarnessPresetImportError);
    expect(() => importHarnessPreset({ kind: "something-else" })).toThrow(/not a harness/i);
    expect(() => importHarnessPreset({ kind: HARNESS_PRESET_EXPORT_KIND, version: 99, preset: {} })).toThrow(
      /newer version/i,
    );
    expect(() =>
      importHarnessPreset({
        kind: HARNESS_PRESET_EXPORT_KIND,
        version: 1,
        preset: { harness: "claude", source: { kind: "subscription", provider: "claude" } },
      }),
    ).toThrow(/does not name a model/i);
  });
});

describe("labels", () => {
  it("summarises as harness then model", () => {
    expect(presetSummary(preset())).toBe("Claude Code · claude-opus-4-5");
    expect(presetSummary(preset(), () => "Claude Opus 4.5")).toBe("Claude Code · Claude Opus 4.5");
  });

  it("names the source in the user's terms", () => {
    expect(presetSourceLabel(preset().source, () => "Work")).toBe("Claude Code account · Work");
    expect(
      presetSourceLabel({ kind: "key", provider: "openai", credentialId: "c", label: "OpenAI ••••4f2a" }),
    ).toBe("API key · OpenAI ••••4f2a");
    expect(presetSourceLabel({ kind: "subscription", provider: "codex" })).toBe("Codex CLI subscription");
  });

  it("reads the inherit token as a sentence", () => {
    expect(presetSubagentLabel(preset())).toBe("Same as main");
    expect(presetSubagentLabel(preset({ subagentModel: "claude-haiku-4-5" }))).toBe("claude-haiku-4-5");
  });

  it("says what pinning a built-in agent costs", () => {
    expect(harnessPresetAgentOverrideNote("explore")).toBe(
      "Explore now runs on ADE's copy of Anthropic's Explore prompt. Updates to Claude Code do not change it.",
    );
  });
});

describe("uniqueHarnessPresetName", () => {
  it("numbers rather than appending copy to copy", () => {
    expect(uniqueHarnessPresetName("Opus work", [])).toBe("Opus work");
    expect(uniqueHarnessPresetName("Opus work", ["Opus work"])).toBe("Opus work 2");
    expect(uniqueHarnessPresetName("Opus work", ["Opus work", "opus work 2"])).toBe("Opus work 3");
  });
});

describe("harnessPresetMatchesQuery", () => {
  it("matches name, harness label and model", () => {
    const entry = preset();
    expect(harnessPresetMatchesQuery(entry, "")).toBe(true);
    expect(harnessPresetMatchesQuery(entry, "opus on")).toBe(true);
    expect(harnessPresetMatchesQuery(entry, "claude code")).toBe(true);
    expect(harnessPresetMatchesQuery(entry, "opus-4-5")).toBe(true);
    expect(harnessPresetMatchesQuery(entry, "droid")).toBe(false);
  });
});
