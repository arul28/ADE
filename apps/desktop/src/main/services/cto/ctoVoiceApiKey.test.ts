import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { getAdeActionDomainServices } from "../adeActions/registry";
import { initApiKeyStore } from "../ai/apiKeyStore";
import type { CtoVoiceSocket } from "./ctoVoiceCallService";
import { createCtoVoiceRuntimeService } from "./ctoVoiceRuntimeService";
import { createVoiceRuntimeHost } from "./ctoVoiceTestDoubles";

/**
 * One store, end to end inside ONE process.
 *
 * `ai.storeMachineApiKey` and `cto_voice.hasKey` are two actions on the same
 * runtime, and they have to read the same credential store: desktop main writes
 * through Electron `safeStorage` and the runtime reads through
 * `EncryptedFileCredentialStore`, so a key that lands in the wrong one leaves
 * Settings reporting `configured: true` while Talk answers "no OpenAI key on
 * this machine".
 */
describe("a key stored on the runtime is a key the voice call can use", () => {
  const originalEnv = { ...process.env };
  let machineHome: string;
  let projectRoot: string;

  beforeEach(() => {
    machineHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-voice-key-machine-"));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-voice-key-project-"));
    process.env = {
      ...originalEnv,
      ADE_HOME: machineHome,
      // The Keychain tier would answer for the real machine, not this fixture.
      ADE_API_KEY_STORE_DISABLE_KEYCHAIN: "1",
    };
    delete process.env.OPENAI_API_KEY;
    initApiKeyStore(projectRoot, {
      credentialStore: new EncryptedFileCredentialStore({
        secretsDir: resolveMachineAdeLayout().secretsDir,
      }),
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(machineHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    // Leave no fixture store bound to the next test in this process.
    initApiKeyStore(process.cwd());
  });

  function createStubSocket(): CtoVoiceSocket {
    return { send: () => {}, close: () => {}, on: () => {} };
  }

  it("goes from missing-key to a live call once ai.storeMachineApiKey has run", async () => {
    const ai = getAdeActionDomainServices({
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      aiIntegrationService: {
        listApiKeys: () => [],
        invalidateProviderReadinessCaches: () => {},
      },
      projectConfigService: {},
    } as never).ai as unknown as {
      getMachineApiKeyStatus: (args: { provider: string }) => { configured: boolean; source: string | null };
      storeMachineApiKey: (args: { provider: string; key: string }) => { configured: boolean; source: string | null };
      deleteMachineApiKey: (args: { provider: string }) => { configured: boolean; source: string | null };
    };
    expect(ai).toBeTruthy();

    const voice = createCtoVoiceRuntimeService(
      createVoiceRuntimeHost({ projectRoot, ctoMemoryService: null }).host,
      {
        createWebSocket: () => createStubSocket(),
      },
    );

    // Before: the honest refusal, in the words the user sees.
    expect(await voice.hasKey()).toBe(false);
    expect(await voice.start({ ownerToken: "owner-1" })).toEqual({
      ok: false,
      error: "missing-key",
      detail: "no OpenAI key on this machine",
    });

    // The write the renderer now makes: the SAME runtime, not desktop main.
    expect(ai.storeMachineApiKey({ provider: "openai", key: "sk-stored-here" }))
      .toMatchObject({ configured: true, source: "store" });

    // After: no re-init, no restart. The voice service's own `getMachineApiKey`
    // sees it, which is the whole point of putting the write on the runtime.
    expect(await voice.hasKey()).toBe(true);
    expect(await voice.start({ ownerToken: "owner-1" })).toEqual({ ok: true });
    await voice.end({ ownerToken: "owner-1" });

    // And the reverse state: deleting takes the call away again.
    expect(ai.deleteMachineApiKey({ provider: "openai" })).toMatchObject({ configured: false });
    expect(await voice.hasKey()).toBe(false);
    voice.dispose();
  });
});