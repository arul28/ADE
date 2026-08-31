import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parsePluginManifest, type PluginManifest } from "../../../shared/plugins/manifest";
import { assertPluginSecretName, PluginSdkError } from "../../../shared/plugins/sdk";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import type { Logger } from "../logging/logger";
import type { PluginSecretStore } from "./pluginSecretStore";
import {
  BUILTIN_CREDENTIAL_DESCRIPTORS,
  buildCredentialHandoffBody,
  buildCredentialHandoffTitle,
  createPluginCredentialHandoffService,
} from "./pluginCredentialHandoff";

/** The one value the whole leak test hunts for. Distinctive on purpose. */
const LINEAR_TOKEN = "lin_oauth_ZZTOPSECRET_9f3a1c";
const LINEAR_REFRESH = "lin_refresh_QQHIDDEN_44b2";
const LINEAR_CLIENT_SECRET = "ade_client_secret_MUST_NOT_MOVE";

const tempDirs: string[] = [];

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-handoff-"));
  tempDirs.push(dir);
  return path.join(dir, "credential-handoff.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

type CapturedLog = { level: string; event: string; meta: Record<string, unknown> | undefined };

function capturingLogger(lines: CapturedLog[]): Logger {
  const push = (level: string) => (event: string, meta?: Record<string, unknown>) => {
    lines.push({ level, event, meta });
  };
  return { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

/** In-memory `SyncCredentialStore`: the machine store ADE's Linear keys live in. */
function fakeCredentialStore(seed: Record<string, string> = {}): SyncCredentialStore {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    getSync(key) {
      return values.get(key) ?? null;
    },
    setSync(key, value) {
      values.set(key, value);
    },
    deleteSync(key) {
      values.delete(key);
    },
  };
}

function fakeSecretStore(): PluginSecretStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async get(pluginId, name) {
      return entries.get(`${pluginId}:${assertPluginSecretName(name)}`) ?? null;
    },
    async set(pluginId, name, value) {
      entries.set(`${pluginId}:${assertPluginSecretName(name)}`, value);
    },
    async delete(pluginId, name) {
      entries.delete(`${pluginId}:${assertPluginSecretName(name)}`);
    },
    async removeAll(pluginId) {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(`${pluginId}:`)) entries.delete(key);
      }
    },
  };
}

/** A connected machine, exactly as `linearCredentialService` writes it. */
function connectedLinearStore(): SyncCredentialStore {
  return fakeCredentialStore({
    "linear.token.v1": LINEAR_TOKEN,
    "linear.authMode.v1": "oauth",
    "linear.tokenExpiresAt.v1": "2027-01-01T00:00:00.000Z",
    "linear.refreshToken.v1": LINEAR_REFRESH,
    "linear.oauthClient.v1": JSON.stringify({
      clientId: "ade-public-client-id",
      clientSecret: LINEAR_CLIENT_SECRET,
    }),
  });
}

function manifestFor(overrides: {
  name: string;
  displayName?: string;
  credentialHandoff?: string[];
}): PluginManifest {
  const parsed = parsePluginManifest({
    name: overrides.name,
    version: "1.0.0",
    displayName: overrides.displayName ?? "Linear",
    description: "Linear issues, boards and sign-in.",
    vocabVersion: 1,
    official: true,
    ...(overrides.credentialHandoff ? { credentialHandoff: overrides.credentialHandoff } : {}),
  });
  if (!parsed.manifest) throw new Error(`fixture manifest did not parse: ${parsed.errors.join("; ")}`);
  return parsed.manifest;
}

const LINEAR_MANIFEST = () => manifestFor({ name: "ade-linear", credentialHandoff: ["linear"] });

function createService(options?: {
  credentials?: SyncCredentialStore;
  consent?: ((args: { title: string; body: string }) => Promise<boolean>) | null;
  logs?: CapturedLog[];
  statePath?: string;
}) {
  const logs = options?.logs ?? [];
  const secrets = fakeSecretStore();
  const statePath = options?.statePath ?? tempStatePath();
  const cards: { title: string; body: string; displayName: string }[] = [];
  const consent = options?.consent === undefined
    ? async () => true
    : options.consent;
  const service = createPluginCredentialHandoffService({
    logger: capturingLogger(logs),
    credentials: options?.credentials ?? connectedLinearStore(),
    secrets,
    statePath,
    ...(consent
      ? {
        requestConsent: async (args) => {
          cards.push({ title: args.title, body: args.body, displayName: args.displayName });
          return await consent(args);
        },
      }
      : {}),
    now: () => Date.parse("2026-09-01T10:00:00.000Z"),
  });
  return { service, secrets, statePath, cards, logs };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof PluginSdkError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-error";
}

describe("descriptor table", () => {
  it("declares only secret names the plugin secret store can hold", () => {
    for (const descriptor of Object.values(BUILTIN_CREDENTIAL_DESCRIPTORS)) {
      expect(descriptor).toBeTruthy();
      for (const field of descriptor!.fields) {
        expect(() => assertPluginSecretName(field.secretName)).not.toThrow();
      }
    }
  });

  it("never names the OAuth client secret's store field as something that moves", () => {
    const linear = BUILTIN_CREDENTIAL_DESCRIPTORS.linear!;
    expect(linear.fields.map((field) => field.secretName)).toEqual([
      "LINEAR_ACCESS_TOKEN",
      "LINEAR_REFRESH_TOKEN",
      "LINEAR_TOKEN_EXPIRES_AT",
      "LINEAR_AUTH_MODE",
      "LINEAR_OAUTH_CLIENT_ID",
    ]);
    expect(linear.withheld.join(" ")).toContain("client secret");
  });
});

describe("card copy", () => {
  it("does not ask whether to give Linear your Linear connection", () => {
    const title = buildCredentialHandoffTitle({
      displayName: "Linear",
      label: "your Linear connection",
    });
    expect(title).toBe("Give the Linear plugin your Linear connection?");
  });

  it("keeps the plugin's own name when it is not the service's name", () => {
    const title = buildCredentialHandoffTitle({
      displayName: "Tracker Pro",
      label: "your Linear connection",
    });
    expect(title).toBe("Give Tracker Pro your Linear connection?");
  });

  it("names every field that moves, what is withheld, and both answers", () => {
    const body = buildCredentialHandoffBody({
      displayName: "Linear",
      descriptor: BUILTIN_CREDENTIAL_DESCRIPTORS.linear!,
    });
    for (const field of BUILTIN_CREDENTIAL_DESCRIPTORS.linear!.fields) {
      expect(body).toContain(field.describe);
    }
    expect(body).toContain("Does not copy: ADE's own OAuth client secret");
    expect(body).toContain("If you say no, nothing is copied and the Linear plugin will ask you to sign in.");
  });
});

describe("permission", () => {
  it("refuses a built-in the manifest does not declare", async () => {
    const { service, cards } = createService();
    const code = await codeOf(() => service.request({
      pluginId: "ade-linear",
      manifest: manifestFor({ name: "ade-linear" }),
      builtin: "linear",
    }));
    expect(code).toBe("not_permitted");
    expect(cards).toHaveLength(0);
  });

  it("refuses a plugin that is not the built-in's owner", async () => {
    const { service, secrets, cards } = createService();
    const code = await codeOf(() => service.request({
      pluginId: "ade-graph",
      manifest: manifestFor({ name: "ade-graph", displayName: "Graph", credentialHandoff: ["linear"] }),
      builtin: "linear",
    }));
    expect(code).toBe("not_permitted");
    expect(cards).toHaveLength(0);
    expect(secrets.entries.size).toBe(0);
  });

  it("rejects auth_unavailable when nothing on this machine can ask", async () => {
    const { service, secrets, statePath } = createService({ consent: null });
    const code = await codeOf(() => service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    }));
    expect(code).toBe("auth_unavailable");
    expect(secrets.entries.size).toBe(0);
    expect(fs.existsSync(statePath)).toBe(false);
  });
});

describe("request", () => {
  it("copies exactly the declared secret names on accept", async () => {
    const { service, secrets, cards } = createService();
    const result = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    expect(result.status).toBe("accepted");
    expect(cards).toHaveLength(1);
    expect([...secrets.entries.keys()].sort()).toEqual([
      "ade-linear:LINEAR_ACCESS_TOKEN",
      "ade-linear:LINEAR_AUTH_MODE",
      "ade-linear:LINEAR_OAUTH_CLIENT_ID",
      "ade-linear:LINEAR_REFRESH_TOKEN",
      "ade-linear:LINEAR_TOKEN_EXPIRES_AT",
    ]);
    expect(secrets.entries.get("ade-linear:LINEAR_ACCESS_TOKEN")).toBe(LINEAR_TOKEN);
    // The client ID moves; the secret beside it in the same stored blob does not.
    expect(secrets.entries.get("ade-linear:LINEAR_OAUTH_CLIENT_ID")).toBe("ade-public-client-id");
    expect([...secrets.entries.values()].join("\u0000")).not.toContain(LINEAR_CLIENT_SECRET);
  });

  it("copies nothing on decline and does not throw", async () => {
    const { service, secrets } = createService({ consent: async () => false });
    const result = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    expect(result.status).toBe("declined");
    expect(result.secretNames).toContain("LINEAR_ACCESS_TOKEN");
    expect(secrets.entries.size).toBe(0);
  });

  it("answers empty when ADE holds no credential, and records nothing", async () => {
    const { service, cards, statePath } = createService({ credentials: fakeCredentialStore() });
    const result = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    expect(result).toEqual({ builtin: "linear", status: "empty", secretNames: [] });
    expect(cards).toHaveLength(0);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("answers empty when the leftovers of a removed connection remain but the token is gone", async () => {
    const { service, cards } = createService({
      credentials: fakeCredentialStore({ "linear.authMode.v1": "oauth" }),
    });
    const result = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    expect(result.status).toBe("empty");
    expect(cards).toHaveLength(0);
  });
});

describe("asked once", () => {
  it("does not show a second card after an accept", async () => {
    const { service, cards } = createService();
    const first = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    const second = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(cards).toHaveLength(1);
  });

  it("does not show a second card after a decline", async () => {
    const { service, cards, secrets } = createService({ consent: async () => false });
    await service.request({ pluginId: "ade-linear", manifest: LINEAR_MANIFEST(), builtin: "linear" });
    const second = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    expect(second.status).toBe("declined");
    expect(cards).toHaveLength(1);
    expect(secrets.entries.size).toBe(0);
  });

  it("joins the card already up instead of stacking a second one", async () => {
    let release: (value: boolean) => void = () => {};
    const answered = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const { service, cards } = createService({ consent: () => answered });
    const first = service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    const second = service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    release(true);
    expect((await first).status).toBe("accepted");
    expect((await second).status).toBe("accepted");
    expect(cards).toHaveLength(1);
  });

  it("asks again after forget, which is what an uninstall calls", async () => {
    const { service, cards, statePath } = createService({ consent: async () => false });
    await service.request({ pluginId: "ade-linear", manifest: LINEAR_MANIFEST(), builtin: "linear" });
    service.forget("ade-linear");
    expect(fs.readFileSync(statePath, "utf8")).not.toContain("ade-linear");
    await service.request({ pluginId: "ade-linear", manifest: LINEAR_MANIFEST(), builtin: "linear" });
    expect(cards).toHaveLength(2);
  });

  it("treats an unreadable state file as no answer rather than a dead end", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, "{ this is not json", "utf8");
    const { service, cards } = createService({ statePath });
    const result = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    expect(result.status).toBe("accepted");
    expect(cards).toHaveLength(1);
  });
});

describe("no credential value escapes", () => {
  it("keeps values out of every log line, the state file and the result", async () => {
    const logs: CapturedLog[] = [];
    const { service, statePath } = createService({ logs });
    const result = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    expect(result.status).toBe("accepted");

    const secretValues = [LINEAR_TOKEN, LINEAR_REFRESH, LINEAR_CLIENT_SECRET];
    const rendered = logs.map((line) => `${line.level} ${line.event} ${JSON.stringify(line.meta ?? {})}`);
    expect(rendered.length).toBeGreaterThan(0);
    for (const value of secretValues) {
      for (const line of rendered) expect(line).not.toContain(value);
      expect(fs.readFileSync(statePath, "utf8")).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(value);
    }
    // Keys only — the plugin's documentation of what to read back.
    expect(result.secretNames).toContain("LINEAR_ACCESS_TOKEN");
    expect(JSON.stringify(result)).toContain("LINEAR_ACCESS_TOKEN");
  });
});

describe("a handoff copies and never moves", () => {
  it("leaves ADE's own credential exactly as it found it", async () => {
    // The built-in Linear pane keeps running until a later wave deletes the
    // compiled code, so BOTH need the credential during the transition. A move
    // would disconnect the pane the user can still see, on the strength of a
    // card that said nothing about disconnecting it.
    const credentials = connectedLinearStore();
    const before = await Promise.all(
      ["linear.token.v1", "linear.authMode.v1", "linear.tokenExpiresAt.v1", "linear.refreshToken.v1", "linear.oauthClient.v1"]
        .map(async (key) => [key, await credentials.get(key)] as const),
    );

    const { service, secrets } = createService({ credentials });
    const result = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });

    expect(result.status).toBe("accepted");
    expect(await secrets.get("ade-linear", "LINEAR_ACCESS_TOKEN")).toBe(LINEAR_TOKEN);
    for (const [key, value] of before) {
      expect(await credentials.get(key)).toBe(value);
    }
  });

  it("leaves ADE's own credential alone on a decline too", async () => {
    const credentials = connectedLinearStore();
    const { service, secrets } = createService({ credentials, consent: async () => false });
    const result = await service.request({
      pluginId: "ade-linear",
      manifest: LINEAR_MANIFEST(),
      builtin: "linear",
    });
    expect(result.status).toBe("declined");
    expect(secrets.entries.size).toBe(0);
    expect(await credentials.get("linear.token.v1")).toBe(LINEAR_TOKEN);
  });

  it("tells the reader in plain words what moves, and that ADE keeps its copy", () => {
    const descriptor = BUILTIN_CREDENTIAL_DESCRIPTORS.linear!;
    const body = buildCredentialHandoffBody({ displayName: "Linear", descriptor });
    // Descriptions a person can act on, never the store keys or the secret
    // names: "LINEAR_TOKEN_EXPIRES_AT" tells a reader nothing they can decide
    // with, and this card is the decision.
    expect(body).toContain("Your Linear access token");
    expect(body).toContain("The refresh token that keeps it working");
    expect(body).toContain("When the access token expires");
    expect(body).toContain("The public OAuth client id the token was issued to");
    for (const field of descriptor.fields) {
      expect(body).not.toContain(field.secretName);
      expect(body).not.toContain(field.storeKey);
    }
    expect(body).toContain("nothing is taken away from ADE");
    expect(buildCredentialHandoffTitle({ displayName: "Linear", label: descriptor.label }))
      .toBe("Give the Linear plugin your Linear connection?");
  });
});

describe("re-asking, but only when the copy is gone", () => {
  it("asks again after the plugin deleted the copy it was given", async () => {
    // A plugin with a disconnect button, or a bug, can lose its own secrets. A
    // record saying "already answered" over an empty store is a dead end the
    // user cannot get out of, so the accept is only honoured while its copy
    // exists.
    const { service, secrets, cards } = createService();
    const args = { pluginId: "ade-linear", manifest: LINEAR_MANIFEST(), builtin: "linear" as const };

    expect((await service.request(args)).status).toBe("accepted");
    expect(cards).toHaveLength(1);

    await secrets.removeAll("ade-linear");

    expect((await service.request(args)).status).toBe("accepted");
    expect(cards).toHaveLength(2);
    expect(await secrets.get("ade-linear", "LINEAR_ACCESS_TOKEN")).toBe(LINEAR_TOKEN);
  });

  it("does not ask again while the copy is still there", async () => {
    const { service, cards } = createService();
    const args = { pluginId: "ade-linear", manifest: LINEAR_MANIFEST(), builtin: "linear" as const };
    await service.request(args);
    await service.request(args);
    await service.request(args);
    expect(cards).toHaveLength(1);
  });

  it("never asks again after a decline, whatever the plugin's store holds", async () => {
    // A decline copied nothing, so there is no copy whose absence could mean
    // anything. Re-asking on an empty store would turn every declined handoff
    // into a card on every call, which is the nag the "once" rule exists to
    // prevent.
    const { service, cards } = createService({ consent: async () => false });
    const args = { pluginId: "ade-linear", manifest: LINEAR_MANIFEST(), builtin: "linear" as const };
    expect((await service.request(args)).status).toBe("declined");
    expect((await service.request(args)).status).toBe("declined");
    expect(cards).toHaveLength(1);
  });
});
