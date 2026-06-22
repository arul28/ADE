import { describe, expect, it } from "vitest";
import { classifyAgentCliError } from "./agentRegistry";

describe("classifyAgentCliError", () => {
  it("classifies missing agent CLIs with install/auth commands", () => {
    expect(classifyAgentCliError("spawn codex ENOENT")).toMatchObject({
      agent: "codex",
      displayName: "Codex CLI",
      category: "missing",
      installCommand: 'mkdir -p "$HOME/.npm-global" "$HOME/.local/bin" && NPM_CONFIG_PREFIX="$HOME/.npm-global" npm install -g @openai/codex',
      authCommand: "codex login",
    });
  });

  it("classifies unauthenticated agent CLIs with auth commands", () => {
    expect(classifyAgentCliError("codex failed: login required")).toMatchObject({
      agent: "codex",
      displayName: "Codex CLI",
      category: "unauthenticated",
      authCommand: "codex login",
    });
  });

  it("uses the preferred provider for generic auth failures", () => {
    expect(classifyAgentCliError("401 unauthorized", "claude")).toMatchObject({
      agent: "claude",
      displayName: "Claude Code",
      category: "unauthenticated",
      authCommand: "claude auth login",
    });
  });

  it("classifies legacy Claude login hints", () => {
    expect(classifyAgentCliError("Please run 'claude /login'", "claude")).toMatchObject({
      agent: "claude",
      category: "unauthenticated",
      authCommand: "claude auth login",
    });
    expect(classifyAgentCliError("Please run /login · API Error: 401 Invalid authentication credentials", "claude")).toMatchObject({
      agent: "claude",
      category: "unauthenticated",
      authCommand: "claude auth login",
    });
  });
});
