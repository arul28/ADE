import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiWorkerEnvironment } from "./piSdkEnvironment";

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

  it("does not treat escaped dollar references as environment requirements", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-env-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({
      providers: { custom: { apiKey: "$$NOT_AN_ENV" } },
    }));

    const env = buildPiWorkerEnvironment({ NOT_AN_ENV: "secret" }, root);

    expect(env).not.toHaveProperty("NOT_AN_ENV");
  });
});
