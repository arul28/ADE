import { describe, expect, it } from "vitest";

import type { AgentChatPermissionPolicy } from "./types/chat";
import { CLAUDE_READ_ONLY_TOOLS } from "../main/services/chat/claudeToolGate";
import { HOST_TOOL_APPROVAL_NAMES } from "./__fixtures__/hostToolApprovalNames";
import {
  CLAUDE_MUTATING_BUILTIN_TOOLS,
  claudeToolNameToNeutral,
  evaluatePermissionPolicy,
  policyAllowedMcpServers,
  policyToolLevelMcpServers,
  neutralToolNameToClaude,
  normalizePermissionPolicy,
  policyToClaudeToolLists,
  toolNameMatchesPattern,
} from "./permissionPolicy";
import { pathIsWithinRoot } from "./pathContainment";

const ask: AgentChatPermissionPolicy = { fallback: "ask" };

describe("normalizePermissionPolicy", () => {
  it("requires a fallback", () => {
    expect(normalizePermissionPolicy({ allowedTools: ["Bash"] })).toBeNull();
    expect(normalizePermissionPolicy({ fallback: "maybe" })).toBeNull();
    expect(normalizePermissionPolicy(null)).toBeNull();
    expect(normalizePermissionPolicy([{ fallback: "ask" }])).toBeNull();
  });

  it("keeps only non-empty strings and drops duplicates", () => {
    expect(normalizePermissionPolicy({
      fallback: "deny",
      allowedTools: ["  Bash  ", "", 7, "Bash", "Edit"],
      deniedTools: [],
    })).toEqual({ fallback: "deny", allowedTools: ["Bash", "Edit"] });
  });

  it("drops a sandboxRoot that is not absolute", () => {
    expect(normalizePermissionPolicy(
      { fallback: "ask", sandboxRoot: "relative/dir" },
      { platform: "posix" },
    )).toEqual({ fallback: "ask" });
    expect(normalizePermissionPolicy(
      { fallback: "ask", sandboxRoot: "~/work" },
      { platform: "posix" },
    )).toEqual({ fallback: "ask" });
  });

  it("keeps an absolute sandboxRoot on each platform", () => {
    expect(normalizePermissionPolicy(
      { fallback: "ask", sandboxRoot: "/srv/data/" },
      { platform: "posix" },
    )).toEqual({ fallback: "ask", sandboxRoot: "/srv/data/" });
    expect(normalizePermissionPolicy(
      { fallback: "ask", sandboxRoot: "C:\\work\\proj" },
      { platform: "win32" },
    )).toEqual({ fallback: "ask", sandboxRoot: "C:\\work\\proj" });
  });
});

describe("tool name translation", () => {
  const rows: Array<[string, string]> = [
    ["mcp:srv:edit_clip", "mcp__srv__edit_clip"],
    ["mcp:srv:*", "mcp__srv__*"],
    ["mcp:srv:deep__tool", "mcp__srv__deep__tool"],
    ["Bash", "Bash"],
    ["Edit*", "Edit*"],
  ];
  for (const [neutral, claude] of rows) {
    it(`maps ${neutral} to ${claude}`, () => {
      expect(neutralToolNameToClaude(neutral)).toBe(claude);
    });
  }

  it("reverses the MCP form, splitting the server at the first separator", () => {
    expect(claudeToolNameToNeutral("mcp__srv__deep__tool")).toBe("mcp:srv:deep__tool");
    expect(claudeToolNameToNeutral("Bash")).toBe("Bash");
    expect(claudeToolNameToNeutral("mcp__srv__")).toBe("mcp__srv__");
  });
});

describe("toolNameMatchesPattern", () => {
  const rows: Array<[string, string, boolean]> = [
    ["Bash", "Bash", true],
    ["bash", "BASH", true],
    ["BashOutput", "Bash", false],
    ["BashOutput", "Bash*", true],
    ["Edit", "Edit*", true],
    ["Read", "*", true],
    ["Read", "", false],
    ["mcp__srv__edit_clip", "mcp__srv__*", true],
  ];
  for (const [name, pattern, expected] of rows) {
    it(`${name} vs ${pattern || "<empty>"} is ${expected}`, () => {
      expect(toolNameMatchesPattern(name, pattern)).toBe(expected);
    });
  }
});

describe("evaluatePermissionPolicy precedence", () => {
  it("lets deniedTools beat allowedTools", () => {
    const policy: AgentChatPermissionPolicy = {
      fallback: "ask",
      allowedTools: ["Bash"],
      deniedTools: ["Bash"],
    };
    expect(evaluatePermissionPolicy(policy, { toolName: "Bash", provider: "claude" })).toBe("deny");
  });

  it("lets deniedTools beat autoApproveMcpServers", () => {
    const policy: AgentChatPermissionPolicy = {
      fallback: "ask",
      autoApproveMcpServers: ["srv"],
      deniedTools: ["mcp:srv:delete_project"],
    };
    expect(evaluatePermissionPolicy(policy, {
      toolName: "mcp__srv__delete_project",
      provider: "claude",
    })).toBe("deny");
    expect(evaluatePermissionPolicy(policy, {
      toolName: "mcp__srv__list_agents",
      provider: "claude",
    })).toBe("allow");
  });

  it("lets an allow rule beat sandboxRoot containment", () => {
    const policy: AgentChatPermissionPolicy = {
      fallback: "deny",
      allowedTools: ["Write"],
      sandboxRoot: "/srv/data",
    };
    expect(evaluatePermissionPolicy(policy, {
      toolName: "Write",
      provider: "claude",
      paths: ["/etc/hosts"],
      platform: "posix",
    })).toBe("allow");
  });

  it("falls through to the fallback when nothing matches", () => {
    expect(evaluatePermissionPolicy(ask, { toolName: "Bash", provider: "claude" })).toBe("ask");
    expect(evaluatePermissionPolicy({ fallback: "deny" }, {
      toolName: "Bash",
      provider: "claude",
    })).toBe("deny");
  });

  it("matches a policy written in either spelling", () => {
    const neutral: AgentChatPermissionPolicy = { fallback: "deny", allowedTools: ["mcp:srv:*"] };
    const claude: AgentChatPermissionPolicy = { fallback: "deny", allowedTools: ["mcp__srv__*"] };
    for (const policy of [neutral, claude]) {
      expect(evaluatePermissionPolicy(policy, {
        toolName: "mcp__srv__edit_clip",
        provider: "claude",
      })).toBe("allow");
    }
  });
});

describe("evaluatePermissionPolicy names host tools, never infers risk", () => {
  // The five rows of issue 1208 part C, shared with the end-to-end assertions
  // in `agentChatService.test.ts` so both layers see the same cases.
  for (const toolName of HOST_TOOL_APPROVAL_NAMES) {
    it(`${toolName} is allowed by an mcp:srv:* rule`, () => {
      const policy: AgentChatPermissionPolicy = { fallback: "ask", allowedTools: ["mcp:srv:*"] };
      expect(evaluatePermissionPolicy(policy, { toolName, provider: "claude" })).toBe("allow");
    });

    it(`${toolName} follows the fallback with no rule naming it`, () => {
      expect(evaluatePermissionPolicy(ask, { toolName, provider: "claude" })).toBe("ask");
      expect(evaluatePermissionPolicy({ fallback: "deny" }, { toolName, provider: "claude" }))
        .toBe("deny");
    });
  }

  it("gates exactly the host tool the policy names", () => {
    const policy: AgentChatPermissionPolicy = {
      fallback: "ask",
      autoApproveMcpServers: ["srv"],
      deniedTools: ["mcp:srv:edit_clip"],
    };
    expect(evaluatePermissionPolicy(policy, {
      toolName: "mcp__srv__edit_clip",
      provider: "claude",
    })).toBe("deny");
    expect(evaluatePermissionPolicy(policy, {
      toolName: "mcp__srv__write_note",
      provider: "claude",
    })).toBe("allow");
  });
});

describe("sandboxRoot containment", () => {
  const policy: AgentChatPermissionPolicy = { fallback: "ask", sandboxRoot: "/srv/data" };

  it("allows a path inside the root", () => {
    expect(evaluatePermissionPolicy(policy, {
      toolName: "Write",
      provider: "claude",
      paths: ["/srv/data/song.txt"],
      platform: "posix",
    })).toBe("allow");
  });

  it("allows the root itself", () => {
    expect(evaluatePermissionPolicy(policy, {
      toolName: "Bash",
      provider: "claude",
      cwd: "/srv/data",
      platform: "posix",
    })).toBe("allow");
  });

  it("falls back for a path outside the root", () => {
    expect(evaluatePermissionPolicy(policy, {
      toolName: "Write",
      provider: "claude",
      paths: ["/etc/hosts"],
      platform: "posix",
    })).toBe("ask");
    expect(evaluatePermissionPolicy({ ...policy, fallback: "deny" }, {
      toolName: "Write",
      provider: "claude",
      paths: ["/etc/hosts"],
      platform: "posix",
    })).toBe("deny");
  });

  it("requires every named path to be inside", () => {
    expect(evaluatePermissionPolicy(policy, {
      toolName: "Write",
      provider: "claude",
      paths: ["/srv/data/a.txt", "/etc/hosts"],
      platform: "posix",
    })).toBe("ask");
  });

  it("does not apply to a request that names no path", () => {
    expect(evaluatePermissionPolicy(policy, {
      toolName: "mcp__srv__edit_clip",
      provider: "claude",
      platform: "posix",
    })).toBe("ask");
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(pathIsWithinRoot("/srv/data", "/srv/data-old/x", "posix")).toBe(false);
    expect(pathIsWithinRoot("/srv/data", "/srv/data/x", "posix")).toBe(true);
  });

  it("resolves a relative path against the request cwd, not against the root", () => {
    // Joining a relative path to the root made it inside the root by
    // construction, while the provider resolved it against its own working
    // directory somewhere else entirely.
    expect(pathIsWithinRoot("/srv/data", "sub/file.txt", "posix", "/srv/data")).toBe(true);
    expect(pathIsWithinRoot("/srv/data", "../escape.txt", "posix", "/srv/data")).toBe(false);
    expect(pathIsWithinRoot("/srv/data", "sub/file.txt", "posix", "/Users/u/project")).toBe(false);
  });

  it("does not contain a relative path when the request names no cwd", () => {
    expect(pathIsWithinRoot("/srv/data", "sub/file.txt", "posix")).toBe(false);
    expect(pathIsWithinRoot("/srv/data", "sub/file.txt", "posix", "relative/base")).toBe(false);
  });

  it("asks about a relative write that the provider would resolve outside the root", () => {
    // sandboxRoot /srv/sandbox, session cwd /Users/u/project, fallback ask: a
    // `Write` of "config.json" used to be judged as /srv/sandbox/config.json
    // and allowed, while Claude wrote /Users/u/project/config.json.
    expect(evaluatePermissionPolicy({ fallback: "ask", sandboxRoot: "/srv/sandbox" }, {
      toolName: "Write",
      provider: "claude",
      cwd: "/Users/u/project",
      paths: ["config.json"],
      platform: "posix",
    })).toBe("ask");
  });

  it("allows a relative write the request cwd puts inside the root", () => {
    expect(evaluatePermissionPolicy({ fallback: "ask", sandboxRoot: "/srv/sandbox" }, {
      toolName: "Write",
      provider: "claude",
      cwd: "/srv/sandbox/app",
      paths: ["config.json"],
      platform: "posix",
    })).toBe("allow");
    expect(evaluatePermissionPolicy({ fallback: "ask", sandboxRoot: "/srv/sandbox" }, {
      toolName: "Write",
      provider: "claude",
      cwd: "/srv/sandbox/app",
      paths: ["/srv/sandbox/app/config.json"],
      platform: "posix",
    })).toBe("allow");
  });

  it("asks about a relative write when the request carries no cwd at all", () => {
    expect(evaluatePermissionPolicy({ fallback: "ask", sandboxRoot: "/srv/sandbox" }, {
      toolName: "Write",
      provider: "claude",
      paths: ["config.json"],
      platform: "posix",
    })).toBe("ask");
  });

  it("contains Windows paths case-insensitively and across separators", () => {
    expect(pathIsWithinRoot("C:\\work\\proj", "C:\\Work\\Proj\\src\\a.ts", "win32")).toBe(true);
    expect(pathIsWithinRoot("C:\\work\\proj", "C:/work/proj/src/a.ts", "win32")).toBe(true);
    expect(pathIsWithinRoot("C:\\work\\proj", "C:\\work\\proj-old\\a.ts", "win32")).toBe(false);
    expect(pathIsWithinRoot("C:\\work\\proj", "D:\\work\\proj\\a.ts", "win32")).toBe(false);
  });

  it("evaluates a Windows sandboxRoot", () => {
    const windowsPolicy: AgentChatPermissionPolicy = {
      fallback: "deny",
      sandboxRoot: "C:\\work\\proj",
    };
    expect(evaluatePermissionPolicy(windowsPolicy, {
      toolName: "Write",
      provider: "claude",
      paths: ["C:\\work\\proj\\src\\a.ts"],
      platform: "win32",
    })).toBe("allow");
    expect(evaluatePermissionPolicy(windowsPolicy, {
      toolName: "Write",
      provider: "claude",
      paths: ["C:\\Windows\\system32\\drivers\\etc\\hosts"],
      platform: "win32",
    })).toBe("deny");
  });

  it("treats a Windows extended-length spelling as inside the sandbox", () => {
    // `\\?\C:\work\proj\src` is the same directory as `C:\work\proj\src`.
    // Leaving the prefix in place made sandboxRoot miss on Windows the same
    // way a missed case-fold would. posix flavor still does not strip.
    expect(evaluatePermissionPolicy({ fallback: "ask", sandboxRoot: "C:\\work\\proj" }, {
      toolName: "Write",
      provider: "claude",
      paths: ["\\\\?\\C:\\work\\proj\\src\\a.ts"],
      platform: "win32",
    })).toBe("allow");
    expect(evaluatePermissionPolicy({ fallback: "ask", sandboxRoot: "C:\\work\\proj" }, {
      toolName: "Write",
      provider: "claude",
      paths: ["\\\\?\\C:\\work\\proj\\src\\a.ts"],
      platform: "posix",
    })).toBe("ask");
  });
});

describe("policyToClaudeToolLists", () => {
  it("translates both lists into Claude spelling", () => {
    expect(policyToClaudeToolLists({
      fallback: "ask",
      allowedTools: ["mcp:srv:search_projects", "Read"],
      deniedTools: ["Bash", "mcp:srv:delete_project"],
    })).toEqual({
      allowedTools: ["mcp__srv__search_projects", "Read"],
      disallowedTools: ["Bash", "mcp__srv__delete_project"],
    });
  });

  it("spells a whole-server wildcard as the bare server name", () => {
    expect(policyToClaudeToolLists({ fallback: "ask", allowedTools: ["mcp:srv:*"] }))
      .toEqual({ allowedTools: ["mcp__srv"], disallowedTools: [] });
  });

  it("expands autoApproveMcpServers into the allow list", () => {
    expect(policyToClaudeToolLists({ fallback: "ask", autoApproveMcpServers: ["srv", "other"] }))
      .toEqual({ allowedTools: ["mcp__srv", "mcp__other"], disallowedTools: [] });
  });

  it("leaves a built-in prefix pattern out of both lists", () => {
    // Claude's lists have no wildcard for a built-in name. `canUseTool`
    // evaluates the full policy, so leaving it out is correct; truncating it to
    // `Edit` would gate one exact tool nobody named.
    expect(policyToClaudeToolLists({
      fallback: "ask",
      allowedTools: ["Edit*"],
      deniedTools: ["Bash*"],
    })).toEqual({ allowedTools: [], disallowedTools: [] });
  });

  it("does not repeat an entry named twice", () => {
    expect(policyToClaudeToolLists({
      fallback: "ask",
      allowedTools: ["mcp:srv:*"],
      autoApproveMcpServers: ["srv"],
    })).toEqual({ allowedTools: ["mcp__srv"], disallowedTools: [] });
  });
});

describe("CLAUDE_MUTATING_BUILTIN_TOOLS", () => {
  it("is the exact roster the deny fallback removes", () => {
    // Pinned deliberately. This list is the whole of what `fallback: "deny"`
    // enforces on Claude, so a silent addition or removal changes what a host
    // is promised. Adding a tool here is a decision, not a refactor.
    expect([...CLAUDE_MUTATING_BUILTIN_TOOLS]).toEqual([
      "Bash",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Agent",
      "Task",
      "KillShell",
    ]);
  });

  it("holds no read-only tool", () => {
    // A deny fallback stops the agent changing things; it does not blind it.
    // The implementation's own read-only set, so the two rosters cannot drift
    // into overlapping.
    for (const readOnly of CLAUDE_READ_ONLY_TOOLS) {
      expect([...CLAUDE_MUTATING_BUILTIN_TOOLS].map((tool) => tool.toLowerCase()))
        .not.toContain(readOnly);
    }
  });
});

describe("policyToClaudeToolLists under fallback deny", () => {
  it("denies every mutating built-in the policy did not name", () => {
    const { disallowedTools } = policyToClaudeToolLists({
      fallback: "deny",
      allowedTools: ["mcp:srv:*"],
    });
    for (const tool of CLAUDE_MUTATING_BUILTIN_TOOLS) {
      expect(disallowedTools).toContain(tool);
    }
    expect(disallowedTools).not.toContain("Read");
  });

  it("leaves a mutating built-in alone when the policy allows it explicitly", () => {
    const { allowedTools, disallowedTools } = policyToClaudeToolLists({
      fallback: "deny",
      allowedTools: ["Write"],
    });
    expect(allowedTools).toContain("Write");
    expect(disallowedTools).not.toContain("Write");
    expect(disallowedTools).toContain("Bash");
  });

  it("honors a prefix pattern as an explicit allow", () => {
    const { disallowedTools } = policyToClaudeToolLists({
      fallback: "deny",
      allowedTools: ["Edit*"],
    });
    expect(disallowedTools).not.toContain("Edit");
    expect(disallowedTools).toContain("Bash");
  });

  it("keeps an explicit denial even when the same tool is allowed", () => {
    // Precedence is unchanged: denied wins, and the tool appears once.
    const { disallowedTools } = policyToClaudeToolLists({
      fallback: "deny",
      allowedTools: ["Bash"],
      deniedTools: ["Bash"],
    });
    expect(disallowedTools.filter((tool) => tool === "Bash")).toEqual(["Bash"]);
  });

  it("adds nothing under fallback ask", () => {
    // "ask" still routes through the prompt path, so removing tools from the
    // catalog up front would refuse work the host wanted to be asked about.
    const { disallowedTools } = policyToClaudeToolLists({
      fallback: "ask",
      allowedTools: ["mcp:srv:*"],
    });
    expect(disallowedTools).toEqual([]);
  });
});

describe("policyAllowedMcpServers", () => {
  const rows: Array<[string, AgentChatPermissionPolicy, string[]]> = [
    ["autoApproveMcpServers", { fallback: "deny", autoApproveMcpServers: ["srv"] }, ["srv"]],
    ["a wildcard allow entry", { fallback: "deny", allowedTools: ["mcp:srv:*"] }, ["srv"]],
    ["an exact allow entry", { fallback: "deny", allowedTools: ["mcp:srv:edit_clip"] }, ["srv"]],
    ["the Claude spelling", { fallback: "deny", allowedTools: ["mcp__srv__edit_clip"] }, ["srv"]],
    ["built-in names only", { fallback: "deny", allowedTools: ["Bash", "Read"] }, []],
    ["no MCP clause at all", { fallback: "deny" }, []],
  ];
  for (const [label, policy, expected] of rows) {
    it(`reads ${label}`, () => {
      expect(policyAllowedMcpServers(policy)).toEqual(expected);
    });
  }

  it("de-duplicates case-insensitively and keeps first-named order", () => {
    expect(policyAllowedMcpServers({
      fallback: "deny",
      autoApproveMcpServers: ["Srv"],
      allowedTools: ["mcp:srv:*", "mcp:other:list"],
    })).toEqual(["Srv", "other"]);
  });
});

describe("policyToolLevelMcpServers", () => {
  const rows: Array<[string, AgentChatPermissionPolicy, string[]]> = [
    ["a tool entry", { fallback: "deny", allowedTools: ["mcp:srv:search"] }, ["srv"]],
    ["the Claude spelling", { fallback: "deny", allowedTools: ["mcp__srv__search"] }, ["srv"]],
    ["a wildcard entry", { fallback: "deny", allowedTools: ["mcp:srv:*"] }, []],
    ["autoApproveMcpServers", { fallback: "deny", autoApproveMcpServers: ["srv"] }, []],
    ["a built-in name", { fallback: "deny", allowedTools: ["Bash"] }, []],
    [
      "a tool entry the wildcard already covers",
      { fallback: "deny", allowedTools: ["mcp:srv:*", "mcp:srv:search"] },
      [],
    ],
    [
      "a tool entry autoApproveMcpServers already covers",
      { fallback: "deny", autoApproveMcpServers: ["srv"], allowedTools: ["mcp:srv:search"] },
      [],
    ],
    [
      "two servers, one whole and one partial",
      { fallback: "deny", allowedTools: ["mcp:whole:*", "mcp:partial:search"] },
      ["partial"],
    ],
  ];
  for (const [label, policy, expected] of rows) {
    it(`reports ${label}`, () => {
      expect(policyToolLevelMcpServers(policy)).toEqual(expected);
    });
  }

  it("de-duplicates a server named by several tool entries", () => {
    expect(policyToolLevelMcpServers({
      fallback: "deny",
      allowedTools: ["mcp:srv:search", "mcp:srv:read", "mcp__srv__list"],
    })).toEqual(["srv"]);
  });
});
