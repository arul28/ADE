import { describe, expect, it } from "vitest";
import { mcpPlainTextSecretFindings, parseMcpServerSnippet } from "./mcpServerImport";

describe("parseMcpServerSnippet", () => {
  it.each([
    {
      label: "a Claude-style mcpServers map",
      text: '{"mcpServers":{"fs":{"command":"npx","args":["-y","server-fs"],"env":{"ROOT":"/tmp"}}}}',
      expected: [{ name: "fs", transport: "stdio", command: "npx", args: ["-y", "server-fs"], env: { ROOT: "/tmp" }, headers: {} }],
    },
    {
      label: "an OpenCode local entry with a command list and environment",
      text: '{"mcp":{"git":{"type":"local","command":["uvx","mcp-git"],"environment":{"A":"1"}}}}',
      expected: [{ name: "git", transport: "stdio", command: "uvx", args: ["mcp-git"], env: { A: "1" }, headers: {} }],
    },
    {
      label: "a remote URL on a path ending in /sse is read as SSE",
      text: '{"remote":{"url":"https://mcp.example.test/sse"}}',
      expected: [{ name: "remote", transport: "sse", url: "https://mcp.example.test/sse", env: {}, headers: {} }],
    },
    {
      label: "a remote URL with no protocol hint is read as HTTP",
      text: '{"api":{"url":"https://mcp.example.test/mcp"}}',
      expected: [{ name: "api", transport: "http", url: "https://mcp.example.test/mcp", env: {}, headers: {} }],
    },
    {
      label: "a fragment copied from the middle of a file, with a trailing comma",
      text: '"git": {"command": "uvx"},',
      expected: [{ name: "git", transport: "stdio", command: "uvx", env: {}, headers: {} }],
    },
    {
      label: "text with no server in it",
      text: '{"theme":"dark"}',
      expected: [],
    },
  ])("reads $label", ({ text, expected }) => {
    expect(parseMcpServerSnippet(text)).toEqual(expected);
  });
});

describe("mcpPlainTextSecretFindings", () => {
  it.each([
    {
      label: "a token passed as the value of a secret flag",
      server: { args: ["--api-key", "placeholder"] },
      expected: [{ where: "args", kind: "value" }],
    },
    {
      label: "an environment placeholder in a flag is a reference, not a value",
      server: { args: ["--token=${GITHUB_TOKEN}"] },
      expected: [{ where: "args", kind: "reference", reference: "${GITHUB_TOKEN}" }],
    },
    {
      label: "a token in a query parameter of the URL",
      server: { url: "https://mcp.example.test/mcp?token=placeholder" },
      expected: [{ where: "url", kind: "value" }],
    },
    {
      label: "ordinary arguments and a plain URL",
      server: { args: ["server.js", "--port", "8080"], url: "https://mcp.example.test/mcp" },
      expected: [],
    },
  ])("finds nothing wrong with $label, or flags it", ({ server, expected }) => {
    expect(mcpPlainTextSecretFindings(server)).toEqual(expected);
  });

  it("does not throw on a malformed percent escape in the URL path", () => {
    expect(() => mcpPlainTextSecretFindings({ url: "https://mcp.example.test/a%E0%A4%A" })).not.toThrow();
    expect(mcpPlainTextSecretFindings({ url: "https://mcp.example.test/a%E0%A4%A" })).toEqual([]);
  });
});
