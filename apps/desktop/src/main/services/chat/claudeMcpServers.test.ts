import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAdeClaudeMcpServers,
  buildClaudeMcpServers,
  discoverProjectClaudeMcpServers,
} from "./claudeMcpServers";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-mcp-test-"));
  vi.stubEnv("ADE_CLI_PATH", "");
  vi.stubEnv("ADE_CLI_BIN_DIR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("discoverProjectClaudeMcpServers", () => {
  it("reads project .mcp.json into SDK-compatible server configs", () => {
    fs.writeFileSync(path.join(tmpRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        local: {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "secret", IGNORED: 123 },
          alwaysLoad: true,
        },
        remote: {
          type: "streamable-http",
          url: "https://mcp.example.test/mcp",
          headers: { authorization: "Bearer token" },
        },
        invalid: {
          type: "http",
        },
      },
    }));

    expect(discoverProjectClaudeMcpServers(tmpRoot)).toEqual({
      local: {
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "secret" },
        alwaysLoad: true,
      },
      remote: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { authorization: "Bearer token" },
      },
    });
  });
});

describe("buildClaudeMcpServers", () => {
  it("adds ADE's local stdio server and leaves project .mcp.json to SDK settingSources", () => {
    const cliPath = path.join(tmpRoot, "ade-cli.cjs");
    fs.writeFileSync(cliPath, "");
    vi.stubEnv("ADE_CLI_PATH", cliPath);
    fs.writeFileSync(path.join(tmpRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        custom: {
          type: "sse",
          url: "https://mcp.example.test/sse",
        },
      },
    }));

    const servers = buildClaudeMcpServers({
      projectRoot: tmpRoot,
      workspaceRoot: tmpRoot,
      sessionId: "chat-1",
      laneId: "lane-1",
    });

    expect(servers.ade).toEqual(expect.objectContaining({
      type: "stdio",
      command: process.execPath,
      args: expect.arrayContaining([cliPath, "--headless", "--project-root", tmpRoot, "--workspace-root", tmpRoot, "mcp"]),
      env: expect.objectContaining({
        ADE_CHAT_SESSION_ID: "chat-1",
        ADE_LANE_ID: "lane-1",
      }),
    }));
    expect(discoverProjectClaudeMcpServers(tmpRoot).custom).toEqual({
      type: "sse",
      url: "https://mcp.example.test/sse",
    });
    expect(servers.custom).toBeUndefined();
  });

  it("falls back to the ade executable when no local CLI path is discoverable", () => {
    const servers = buildAdeClaudeMcpServers({
      projectRoot: tmpRoot,
      workspaceRoot: tmpRoot,
      sessionId: "chat-1",
      laneId: "lane-1",
    });

    expect(servers.ade).toEqual(expect.objectContaining({
      type: "stdio",
      command: expect.any(String),
      args: expect.arrayContaining(["--headless", "--role", "agent", "mcp"]),
    }));
  });
});
