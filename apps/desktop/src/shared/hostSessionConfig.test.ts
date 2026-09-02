import { describe, expect, it } from "vitest";

import type {
  AgentChatPermissionCapability,
  AgentChatPermissionPolicy,
  AgentChatSettingSources,
} from "./types/chat";
import {
  CLAUDE_BLOCKED_CALLER_SERVERS_PREFIX,
  CLAUDE_DENY_SANDBOX_ROOT_RESIDUAL,
  CLAUDE_SETTING_SOURCE_MAP,
  CLAUDE_TOOL_LEVEL_MCP_RESIDUAL_PREFIX,
  HOST_SETTING_SOURCES_VALUES,
  INSTRUCTIONS_SUPPORT,
  PERMISSION_POLICY_SUPPORT,
  SETTING_SOURCES_SUPPORT,
  instructionsSupport,
  normalizeHostInstructions,
  normalizeInstructionsCapability,
  normalizePermissionCapability,
  normalizeSettingSources,
  normalizeSettingSourcesCapability,
  permissionPolicySupport,
  resolveInstructionsCapability,
  resolvePermissionCapability,
  resolveSettingSourcesCapability,
  settingSourcesSupport,
} from "./hostSessionConfig";
import type { ShippedProvider } from "./providers";

const PROVIDERS: readonly ShippedProvider[] = [
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
  "pi",
];

describe("normalizeHostInstructions", () => {
  it("treats a bare string as append", () => {
    expect(normalizeHostInstructions("be terse")).toEqual({ mode: "append", text: "be terse" });
  });

  it("trims both forms", () => {
    expect(normalizeHostInstructions("  padded  ")).toEqual({ mode: "append", text: "padded" });
    expect(normalizeHostInstructions({ mode: "replace", text: "  x  " }))
      .toEqual({ mode: "replace", text: "x" });
  });

  it("keeps an explicit replace", () => {
    expect(normalizeHostInstructions({ mode: "replace", text: "only this" }))
      .toEqual({ mode: "replace", text: "only this" });
  });

  it("defaults an unknown mode to append rather than refusing the text", () => {
    expect(normalizeHostInstructions({ mode: "clobber", text: "x" }))
      .toEqual({ mode: "append", text: "x" });
  });

  // An empty `replace` would silently erase ADE's own prompt, and an empty
  // `append` would make the capability report claim something was applied.
  it.each([
    ["empty string", ""],
    ["whitespace string", "   "],
    ["empty text", { mode: "append", text: "" }],
    ["whitespace text", { mode: "replace", text: "\n\t " }],
    ["missing text", { mode: "append" }],
    ["non-string text", { mode: "append", text: 7 }],
    ["null", null],
    ["undefined", undefined],
    ["array", ["hello"]],
    ["number", 12],
  ])("rejects %s", (_label, value) => {
    expect(normalizeHostInstructions(value)).toBeNull();
  });
});

describe("normalizeSettingSources", () => {
  it.each(HOST_SETTING_SOURCES_VALUES)("accepts %s", (value) => {
    expect(normalizeSettingSources(value)).toBe(value);
  });

  it("trims", () => {
    expect(normalizeSettingSources(" project ")).toBe("project");
  });

  it.each([
    ["unknown word", "everything"],
    ["empty", ""],
    ["null", null],
    ["number", 1],
    ["array", ["all"]],
  ])("rejects %s", (_label, value) => {
    expect(normalizeSettingSources(value)).toBeNull();
  });
});

describe("CLAUDE_SETTING_SOURCE_MAP", () => {
  it("names every value, so no case falls through to the SDK default", () => {
    expect(Object.keys(CLAUDE_SETTING_SOURCE_MAP).sort())
      .toEqual([...HOST_SETTING_SOURCES_VALUES].sort());
  });

  it("maps none to an empty layer list rather than omitting the option", () => {
    expect(CLAUDE_SETTING_SOURCE_MAP.none).toEqual([]);
  });

  it("maps the three loading values", () => {
    expect(CLAUDE_SETTING_SOURCE_MAP.project).toEqual(["project"]);
    expect(CLAUDE_SETTING_SOURCE_MAP.user).toEqual(["user"]);
    expect(CLAUDE_SETTING_SOURCE_MAP.all).toEqual(["user", "project", "local"]);
  });
});

describe("the three provider tables", () => {
  // `expect(accessor(p)).toBe(TABLE[p])` is not a test: the accessor IS that
  // read, so any table content passes. What is worth pinning is that a row
  // exists at all for every shipped provider, and that the settingSources row
  // names every value — both of which a new provider or a new value can break.
  it.each(PROVIDERS)("has a row in all three tables for %s", (provider) => {
    expect(instructionsSupport(provider)).not.toBeNull();
    expect(settingSourcesSupport(provider)).not.toBeNull();
    expect(permissionPolicySupport(provider)).not.toBeNull();
  });

  it.each(PROVIDERS)("names every settingSources value in %s's row", (provider) => {
    const support = settingSourcesSupport(provider);
    expect(Object.keys(support!.levelFor).sort())
      .toEqual([...HOST_SETTING_SOURCES_VALUES].sort());
  });

  // `residual` is documented as non-null exactly when the level is
  // "best-effort"; a null there would be a claim that nothing is missing.
  it.each(PROVIDERS)("states a residual for %s exactly when it is best-effort", (provider) => {
    const row = PERMISSION_POLICY_SUPPORT[provider];
    expect(row.residual != null).toBe(row.level === "best-effort");
  });

  // Every table read goes through a hasOwnProperty guard, so an inherited
  // Object.prototype key cannot return a function the callers read `.level` off.
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "returns null for the inherited key %s",
    (key) => {
      expect(instructionsSupport(key)).toBeNull();
      expect(settingSourcesSupport(key)).toBeNull();
      expect(permissionPolicySupport(key)).toBeNull();
    },
  );
});

describe("resolveInstructionsCapability", () => {
  const EXPECTED: Record<ShippedProvider, "applied" | "best-effort" | "ignored"> = {
    claude: "applied",
    codex: "applied",
    opencode: "applied",
    pi: "applied",
    cursor: "best-effort",
    droid: "best-effort",
  };

  it.each(PROVIDERS)("reports %s at its table level", (provider) => {
    const report = resolveInstructionsCapability(provider, { mode: "append" });
    expect(report.level).toBe(EXPECTED[provider]);
    // A mechanism is always stated, and a detail exactly when the level is not
    // "applied" — an unexplained downgrade is the thing this report exists to
    // prevent. Comparing to the table's own strings would pass for any content.
    expect(report.mechanism.length).toBeGreaterThan(0);
    expect(report.detail != null).toBe(report.level !== "applied");
  });

  it.each(PROVIDERS)("echoes the requested mode for %s", (provider) => {
    expect(resolveInstructionsCapability(provider, { mode: "replace" }).mode).toBe("replace");
  });

  // A provider added with no table row is a provider added without a decision.
  it("reports an unknown provider as ignored and names it", () => {
    const report = resolveInstructionsCapability("qwen", { mode: "append" });
    expect(report.level).toBe("ignored");
    expect(report.mode).toBe("append");
    expect(report.mechanism).toContain("qwen");
    expect(report.detail).not.toBeNull();
  });
});

describe("resolveSettingSourcesCapability", () => {
  // The independently stated answer for every provider and value, the way
  // `resolveInstructionsCapability`'s EXPECTED does it. Recomputing these from
  // `SETTING_SOURCES_SUPPORT` would assert the resolver copies the table, which
  // it plainly does; what is worth pinning is what the table SAYS.
  const EXPECTED_SETTING_SOURCES: Record<
    ShippedProvider,
    Record<AgentChatSettingSources, "applied" | "best-effort" | "ignored">
  > = {
    claude: { none: "applied", project: "applied", user: "applied", all: "applied" },
    codex: { none: "ignored", project: "best-effort", user: "ignored", all: "best-effort" },
    cursor: { none: "ignored", project: "ignored", user: "ignored", all: "ignored" },
    droid: { none: "ignored", project: "ignored", user: "ignored", all: "ignored" },
    opencode: { none: "ignored", project: "ignored", user: "ignored", all: "ignored" },
    pi: { none: "ignored", project: "ignored", user: "ignored", all: "ignored" },
  };

  it.each(PROVIDERS)("reports %s at the level for the requested value", (provider) => {
    for (const value of HOST_SETTING_SOURCES_VALUES) {
      const report = resolveSettingSourcesCapability(provider, value);
      expect(report.value).toBe(value);
      expect(report.level).toBe(EXPECTED_SETTING_SOURCES[provider][value]);
      expect(report.mechanism.length).toBeGreaterThan(0);
    }
  });

  it("honors every value on Claude", () => {
    for (const value of HOST_SETTING_SOURCES_VALUES) {
      expect(resolveSettingSourcesCapability("claude", value).level).toBe("applied");
    }
  });

  // Codex always reads AGENTS.md from the thread cwd and has no switch, so the
  // two values that ask it to stop are not honorable and the two that describe
  // what it already does are not an ADE enforcement either.
  it.each([
    ["none", "ignored"],
    ["user", "ignored"],
    ["project", "best-effort"],
    ["all", "best-effort"],
  ] as const)("reports Codex %s as %s", (value, level) => {
    expect(resolveSettingSourcesCapability("codex", value).level).toBe(level);
  });

  it("omits the detail when the value was actually applied", () => {
    expect(resolveSettingSourcesCapability("claude", "project").detail).toBeNull();
  });

  it("keeps the detail when the value was not applied", () => {
    expect(resolveSettingSourcesCapability("codex", "none").detail).not.toBeNull();
  });

  it("reports an unknown provider as ignored and names it", () => {
    const report = resolveSettingSourcesCapability("qwen", "project");
    expect(report.level).toBe("ignored");
    expect(report.value).toBe("project");
    expect(report.mechanism).toContain("qwen");
  });

  it("reports an unknown value as ignored rather than reading a prototype key", () => {
    const report = resolveSettingSourcesCapability(
      "claude",
      "constructor" as unknown as AgentChatSettingSources,
    );
    expect(report.level).toBe("ignored");
  });
});

describe("resolvePermissionCapability", () => {
  const askPolicy: AgentChatPermissionPolicy = { fallback: "ask" };
  const denyPolicy: AgentChatPermissionPolicy = { fallback: "deny" };

  // Claude is excluded: its level depends on the policy's fallback rather than
  // on the table row, which is what the four cases below are about.
  const TABLE_LEVEL_PROVIDERS = PROVIDERS.filter((provider) => provider !== "claude");

  // Stated here rather than read back out of the table under test.
  const EXPECTED_PERMISSION: Record<
    ShippedProvider,
    AgentChatPermissionCapability["level"]
  > = {
    claude: "best-effort",
    codex: "best-effort",
    cursor: "unsupported",
    droid: "unsupported",
    opencode: "unsupported",
    pi: "unsupported",
  };

  it.each(TABLE_LEVEL_PROVIDERS)(
    "reports %s at its table level when a policy is present",
    (provider) => {
      const report = resolvePermissionCapability(provider, askPolicy);
      expect(report.level).toBe(EXPECTED_PERMISSION[provider]);
      expect(report.mechanism.length).toBeGreaterThan(0);
      // Documented rule: a residual is stated exactly when something is not
      // applied, which for a table-level provider is exactly "best-effort".
      expect(report.residual != null).toBe(report.level === "best-effort");
    },
  );

  it.each(TABLE_LEVEL_PROVIDERS)("ignores the fallback for %s", (provider) => {
    expect(resolvePermissionCapability(provider, denyPolicy).level)
      .toBe(resolvePermissionCapability(provider, askPolicy).level);
  });

  // The Codex row has to say what the engine does, and what it does is mostly
  // decided by the sandbox rather than by the policy. A row that reads as if
  // every command reaches the fallback promises an embedder a gate that Codex
  // never raises.
  it("says Codex leaves cwd, $TMPDIR and /tmp ungated by its own sandbox", () => {
    const report = resolvePermissionCapability("codex", askPolicy);
    expect(report.mechanism).toContain("without raising an approval");
    expect(report.mechanism).toContain("$TMPDIR");
    expect(report.mechanism).toContain("/tmp");
    expect(report.residual).toContain("sandbox escapes only");
  });

  it("says a Codex sandbox escape goes to sandboxRoot containment and then to fallback", () => {
    const report = resolvePermissionCapability("codex", askPolicy);
    expect(report.mechanism).toContain("Only a sandbox escape raises an approval request");
    expect(report.mechanism).toContain("contained by sandboxRoot is auto-accepted");
    expect(report.mechanism).toContain("'ask' raises an approval request");
    expect(report.mechanism).toContain("'deny' declines it");
    expect(report.mechanism).toContain("no sandboxRoot contains nothing");
  });

  it("names legacy full auto as the one escape from Codex containment", () => {
    // `codexApprovalAutoAccepts` returns true unconditionally under full auto,
    // before the sandboxRoot test. Reachable from the CLI, not from the SDK.
    const report = resolvePermissionCapability("codex", askPolicy);
    expect(report.mechanism).toContain("Legacy full auto is the one exception");
    expect(report.mechanism).toContain("before containment is consulted");
  });

  it("says the Codex tool lists are Claude-only and gate nothing", () => {
    // Nothing on the Codex path reads allowedTools/deniedTools. A host that
    // reads the published precedence line as a shell blocklist gets no gate.
    const report = resolvePermissionCapability("codex", askPolicy);
    expect(report.residual).toContain("are Claude-only");
    expect(report.residual).toContain("sandboxRoot containment and then fallback are the whole decision");
    expect(report.residual).toContain("Do not read deniedTools as a shell or tool blocklist");
    expect(report.residual).toContain("does not route plain MCP tool calls");
  });

  // The two Claude rows. `deniedTools`/`allowedTools` are applied by the CLI
  // either way; only the ask verdict needs the Agent SDK prompt to fire, and
  // that is the part ADE does not control.
  it("reports Claude as enforced under a deny fallback", () => {
    const report = resolvePermissionCapability("claude", denyPolicy);
    expect(report.level).toBe("enforced");
    expect(report.mechanism).toContain("allowManagedMcpServersOnly");
    // "enforced" stays honest about the one clause it cannot apply.
    expect(report.residual).toContain("sandboxRoot");
  });

  it("downgrades Claude to best-effort when an allow entry names one MCP tool", () => {
    // `allowManagedMcpServersOnly` is per-server, so admitting `mcp:srv:search`
    // admits `mcp:srv:delete` too, and the per-tool refusal would have to come
    // from the hook that does not fire. Reporting "enforced" would be a lie.
    const report = resolvePermissionCapability("claude", {
      fallback: "deny",
      allowedTools: ["mcp:srv:search"],
    });
    expect(report.level).toBe("best-effort");
    expect(report.residual).toContain(CLAUDE_TOOL_LEVEL_MCP_RESIDUAL_PREFIX);
    expect(report.residual).toContain("srv");
  });

  it("stays enforced when every MCP allow entry names a whole server", () => {
    for (const allowed of [
      { fallback: "deny", allowedTools: ["mcp:srv:*"] } as AgentChatPermissionPolicy,
      { fallback: "deny", autoApproveMcpServers: ["srv"] } as AgentChatPermissionPolicy,
      { fallback: "deny", allowedTools: ["Bash"] } as AgentChatPermissionPolicy,
    ]) {
      const report = resolvePermissionCapability("claude", allowed);
      expect(report.level).toBe("enforced");
      expect(report.residual).not.toContain(CLAUDE_TOOL_LEVEL_MCP_RESIDUAL_PREFIX);
    }
  });

  it("does not flag a server that a whole-server entry already admits", () => {
    // Naming all of `srv` was the stated intent, so a tool entry alongside it
    // surprises nobody.
    const report = resolvePermissionCapability("claude", {
      fallback: "deny",
      allowedTools: ["mcp:srv:*", "mcp:srv:search"],
    });
    expect(report.level).toBe("enforced");
  });

  it("names caller MCP servers the deny policy blocks", () => {
    const report = resolvePermissionCapability(
      "claude",
      { fallback: "deny", allowedTools: ["mcp:srv:*"] },
      { callerMcpServerNames: ["srv", "other", "third"] },
    );
    expect(report.level).toBe("enforced");
    expect(report.residual).toContain(`${CLAUDE_BLOCKED_CALLER_SERVERS_PREFIX}other, third`);
    // `srv` is allowed, so it is not named as blocked.
    expect(report.residual).not.toContain(`${CLAUDE_BLOCKED_CALLER_SERVERS_PREFIX}srv`);
  });

  it("says nothing about caller servers when the policy admits them all", () => {
    const report = resolvePermissionCapability(
      "claude",
      { fallback: "deny", autoApproveMcpServers: ["srv"] },
      { callerMcpServerNames: ["srv"] },
    );
    expect(report.residual).not.toContain(CLAUDE_BLOCKED_CALLER_SERVERS_PREFIX);
  });

  it("keeps the sandboxRoot residual whatever the MCP verdict is", () => {
    for (const policy of [
      { fallback: "deny" } as AgentChatPermissionPolicy,
      { fallback: "deny", allowedTools: ["mcp:srv:search"] } as AgentChatPermissionPolicy,
    ]) {
      expect(resolvePermissionCapability("claude", policy).residual)
        .toContain(CLAUDE_DENY_SANDBOX_ROOT_RESIDUAL);
    }
  });

  it("reports Claude as best-effort under an ask fallback, and says why", () => {
    const report = resolvePermissionCapability("claude", askPolicy);
    expect(report.level).toBe("best-effort");
    expect(report.residual).toContain("permissions.defaultMode: auto");
    expect(report.residual).toContain("enforced either way");
  });

  // Claiming "enforced" for a caller who sent a preset would describe an
  // enforcement of rules that do not exist.
  it.each(PROVIDERS)("reports %s as unsupported when no policy survived", (provider) => {
    for (const absent of [null, undefined]) {
      const report = resolvePermissionCapability(provider, absent);
      expect(report.level).toBe("unsupported");
      expect(report.residual).toBeNull();
    }
  });

  it("reports an unknown provider as unsupported and names it", () => {
    const report = resolvePermissionCapability("qwen", askPolicy);
    expect(report.level).toBe("unsupported");
    expect(report.mechanism).toContain("qwen");
  });
});

describe("rehydrating persisted capability reports", () => {
  it("round-trips a report it wrote", () => {
    const report = resolveInstructionsCapability("cursor", { mode: "replace" });
    expect(normalizeInstructionsCapability(JSON.parse(JSON.stringify(report)))).toEqual(report);

    const settings = resolveSettingSourcesCapability("codex", "project");
    expect(normalizeSettingSourcesCapability(JSON.parse(JSON.stringify(settings)))).toEqual(settings);

    const permission = resolvePermissionCapability("codex", { fallback: "ask" });
    expect(normalizePermissionCapability(JSON.parse(JSON.stringify(permission)))).toEqual(permission);
  });

  it.each([
    ["null", null],
    ["a string", "applied"],
    ["an array", []],
    ["an unknown level", { level: "partial", mechanism: "x" }],
    ["a missing mechanism", { level: "applied" }],
  ])("returns null for %s", (_label, value) => {
    expect(normalizeInstructionsCapability(value)).toBeNull();
    expect(normalizeSettingSourcesCapability(value)).toBeNull();
    expect(normalizePermissionCapability(value)).toBeNull();
  });

  it("rejects a settingSources report whose value this build does not know", () => {
    expect(normalizeSettingSourcesCapability({
      level: "applied",
      value: "everything",
      mechanism: "x",
      detail: null,
    })).toBeNull();
  });

  it("coerces a missing detail to null rather than leaving it undefined", () => {
    expect(normalizeInstructionsCapability({ level: "ignored", mechanism: "x" }))
      .toEqual({ level: "ignored", mode: "append", mechanism: "x", detail: null });
  });
});
