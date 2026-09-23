import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_PROVIDER_ENV_KEYS, buildPiWorkerEnvironment } from "./piSdkEnvironment";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("buildPiWorkerEnvironment", () => {
  it("passes declared custom provider variables without inheriting ADE control variables", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-env-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({
      providers: {
        custom: {
          apiKey: "$CUSTOM_PI_KEY",
          headers: {
            "X-Endpoint-Token": "${CUSTOM_PI_HEADER}",
            "X-ADE-Token": "$ADE_BROWSER_ACTOR_TOKEN",
          },
        },
      },
    }));

    const env = buildPiWorkerEnvironment({
      PATH: "/bin",
      CUSTOM_PI_KEY: "key",
      CUSTOM_PI_HEADER: "header",
      ADE_BROWSER_ACTOR_TOKEN: "must-not-cross",
      ADE_CHAT_SESSION_ID: "chat-1",
    }, root);

    expect(env).toMatchObject({ PATH: "/bin", CUSTOM_PI_KEY: "key", CUSTOM_PI_HEADER: "header" });
    expect(env).not.toHaveProperty("ADE_BROWSER_ACTOR_TOKEN");
    expect(env).not.toHaveProperty("ADE_CHAT_SESSION_ID");
  });

  it("classifies accounts only from keys the worker already receives", () => {
    const keys = [...new Set(Object.values(PI_PROVIDER_ENV_KEYS).flat())];
    const env = buildPiWorkerEnvironment(Object.fromEntries(keys.map((key) => [key, "set"])));
    for (const key of keys) expect(env[key], key).toBe("set");
  });

  it("does not widen the worker env for usage telemetry", () => {
    // These keys stay out of the Pi worker, as they were before usage
    // telemetry: telemetry must never change what Pi can authenticate with.
    const withheld = ["KIMI_API_KEY", "QWEN_API_KEY", "DASHSCOPE_API_KEY", "COPILOT_GITHUB_TOKEN", "OPENCODE_API_KEY", "ANTHROPIC_OAUTH_TOKEN"];
    const env = buildPiWorkerEnvironment(Object.fromEntries(withheld.map((key) => [key, "set"])));
    for (const key of withheld) expect(env).not.toHaveProperty(key);
  });

  it("does not treat escaped dollar references as environment requirements", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-env-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({
      providers: { custom: { apiKey: "$$NOT_AN_ENV" } },
    }));

    const env = buildPiWorkerEnvironment({ NOT_AN_ENV: "secret" }, root);

    expect(env).not.toHaveProperty("NOT_AN_ENV");
  });

  it("passes only the explicit per-chat activity scope through the ADE environment boundary", () => {
    const env = buildPiWorkerEnvironment({
      PATH: "/bin",
      ADE_CLI_PATH: "/inherited/ade",
      ADE_CHAT_SESSION_ID: "other-chat",
      ADE_DEFAULT_ROLE: "cto",
      ADE_RUNTIME_SOCKET_PATH: "/other/runtime.sock",
      ADE_RPC_SOCKET_PATH: "/other/rpc.sock",
      ADE_RPC_URL: "/other/url.sock",
      ADE_ACTIVITY_SESSION_ID: "terminal-row",
      ADE_BROWSER_ACTOR_TOKEN: "browser-token",
      ADE_PARENT_CHAT_SESSION_ID: "parent-chat",
      ADE_PROJECT_ROOT: "/project",
    }, undefined, {
      cliPath: "/resolved/ade",
      chatSessionId: "chat-1",
      runtimeSocketPath: "/runtime/ade.sock",
    });

    expect(env).toMatchObject({
      PATH: "/bin",
      ADE_CLI_PATH: "/resolved/ade",
      ADE_CHAT_SESSION_ID: "chat-1",
      ADE_DEFAULT_ROLE: "agent",
      ADE_RPC_URL: "/runtime/ade.sock",
      ADE_RPC_SOCKET_PATH: "/runtime/ade.sock",
      ADE_RUNTIME_SOCKET_PATH: "/runtime/ade.sock",
    });
    expect(env).not.toHaveProperty("ADE_ACTIVITY_SESSION_ID");
    expect(env).not.toHaveProperty("ADE_BROWSER_ACTOR_TOKEN");
    expect(env).not.toHaveProperty("ADE_PARENT_CHAT_SESSION_ID");
    expect(env).not.toHaveProperty("ADE_PROJECT_ROOT");
  });
});
