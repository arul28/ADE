import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import {
  CURSOR_CLOUD_METADATA_LANE_ID,
  CURSOR_CLOUD_METADATA_LINEAR_ISSUE_ID,
  CURSOR_CLOUD_METADATA_PROJECT_ID,
  CURSOR_CLOUD_METADATA_SESSION_ID,
  CURSOR_CLOUD_WEBHOOK_SECRET_KEY,
  buildCursorCloudCreateCloudExtras,
  buildCursorCloudEnvVars,
  buildCursorCloudMetadata,
  buildCursorCloudWebhookUrl,
  ensureCursorCloudWebhookSecret,
  isInjectableCloudSecretName,
  parseRememberedSecretNames,
  readCursorCloudLaneSecretNames,
  resolveCursorCloudCreateCloudExtras,
  signCursorCloudWebhookBody,
  writeCursorCloudLaneSecretNames,
  type CursorCloudLaunchResolveInput,
} from "./cursorCloudCreateOptions";

class MemoryCredentialStore implements SyncCredentialStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.getSync(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.setSync(key, value);
  }
  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }
  getSync(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setSync(key: string, value: string): void {
    this.values.set(key, value);
  }
  deleteSync(key: string): void {
    this.values.delete(key);
  }
}

describe("cursorCloudCreateOptions", () => {
  it("stamps ADE metadata keys and omits a missing linear issue", () => {
    expect(buildCursorCloudMetadata({
      sessionId: "sess-1",
      laneId: "lane-1",
      projectId: "proj-1",
    })).toEqual({
      [CURSOR_CLOUD_METADATA_SESSION_ID]: "sess-1",
      [CURSOR_CLOUD_METADATA_LANE_ID]: "lane-1",
      [CURSOR_CLOUD_METADATA_PROJECT_ID]: "proj-1",
    });
    expect(buildCursorCloudMetadata({
      sessionId: "sess-1",
      laneId: "lane-1",
      projectId: "proj-1",
      linearIssueId: "ADE-12",
    })[CURSOR_CLOUD_METADATA_LINEAR_ISSUE_ID]).toBe("ADE-12");
  });

  it("never invents a project id", () => {
    expect(buildCursorCloudMetadata({
      sessionId: "sess-1",
      laneId: "lane-1",
    })[CURSOR_CLOUD_METADATA_PROJECT_ID]).toBeUndefined();
  });

  it("rejects CURSOR_ secret names and empty values", () => {
    expect(isInjectableCloudSecretName("CURSOR_API_KEY")).toBe(false);
    expect(isInjectableCloudSecretName("cursor_token")).toBe(false);
    expect(isInjectableCloudSecretName("NPM_TOKEN")).toBe(true);
    expect(buildCursorCloudEnvVars([
      { name: "NPM_TOKEN", value: "abc" },
      { name: "CURSOR_API_KEY", value: "nope" },
      { name: "EMPTY", value: "" },
    ])).toEqual({ NPM_TOKEN: "abc" });
  });

  it("joins the relay webhook path and signs bodies as sha256=", () => {
    expect(buildCursorCloudWebhookUrl("https://relay.example/")).toBe(
      "https://relay.example/cursor/webhook",
    );
    const secret = "a".repeat(32);
    const body = "{\"ok\":true}";
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(signCursorCloudWebhookBody(secret, body)).toBe(expected);
  });

  it("omits metadata and webhook from create extras even when ADE ids are present", () => {
    const extras = buildCursorCloudCreateCloudExtras({
      envVars: { NPM_TOKEN: "abc" },
    });
    expect(extras).toEqual({ envVars: { NPM_TOKEN: "abc" } });
    expect(extras).not.toHaveProperty("metadata");
    expect(extras).not.toHaveProperty("webhook");
  });

  it("resolves selected secrets and canonical project id without stamping create metadata or webhook", () => {
    const store = new MemoryCredentialStore();
    const secrets = new Map([
      ["NPM_TOKEN", "npm-secret"],
      ["CURSOR_API_KEY", "cursor-secret"],
    ]);
    const result = resolveCursorCloudCreateCloudExtras({
      projectRoot: "/tmp/project",
      db: {
        get: () => ({ id: "canonical-project" }),
      } as CursorCloudLaunchResolveInput["db"],
      projectConfigService: {
        get: () => ({ effective: { ui: { webhookGatewayPublicUrl: "https://relay.example" } } }),
      },
      sessionId: "sess-1",
      laneId: "lane-1",
      linearIssueId: "ADE-9",
      secretNames: ["NPM_TOKEN", "CURSOR_API_KEY", "MISSING"],
      rememberSecretNames: true,
      credentialStore: store,
      getSecretValue: (name) => secrets.get(name) ?? null,
    });

    expect(result.projectId).toBe("canonical-project");
    expect(result.extras).toEqual({ envVars: { NPM_TOKEN: "npm-secret" } });
    expect(result.extras).not.toHaveProperty("metadata");
    expect(result.extras).not.toHaveProperty("webhook");
    expect(store.getSync(CURSOR_CLOUD_WEBHOOK_SECRET_KEY)).toBeNull();
    expect(readCursorCloudLaneSecretNames(store, "lane-1")).toEqual(["NPM_TOKEN", "MISSING"]);
  });

  it("does not dump the secret store when nothing is selected", () => {
    const secrets = new Map([["NPM_TOKEN", "npm-secret"], ["GH_TOKEN", "gh-secret"]]);
    const result = resolveCursorCloudCreateCloudExtras({
      projectRoot: "/tmp/project",
      sessionId: "sess-1",
      laneId: "lane-1",
      credentialStore: new MemoryCredentialStore(),
      getSecretValue: (name) => secrets.get(name) ?? null,
    });
    expect(result.extras.envVars).toBeUndefined();
    expect(result.extras).not.toHaveProperty("metadata");
    expect(result.extras).not.toHaveProperty("webhook");
  });

  it("round-trips remembered lane secret names", () => {
    const store = new MemoryCredentialStore();
    writeCursorCloudLaneSecretNames(store, "lane-1", ["NPM_TOKEN", "CURSOR_API_KEY"]);
    expect(readCursorCloudLaneSecretNames(store, "lane-1")).toEqual(["NPM_TOKEN"]);
    expect(parseRememberedSecretNames("not-json")).toEqual([]);
    writeCursorCloudLaneSecretNames(store, "lane-1", []);
    expect(readCursorCloudLaneSecretNames(store, "lane-1")).toEqual([]);
  });

  it("reuses a stored webhook secret of at least 32 characters", () => {
    const store = new MemoryCredentialStore();
    store.setSync(CURSOR_CLOUD_WEBHOOK_SECRET_KEY, "stored-webhook-secret-value-32ch");
    expect(ensureCursorCloudWebhookSecret(store)).toBe("stored-webhook-secret-value-32ch");
  });
});
