import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudLaneLaunchService, type CloudLaneLaunchDeps, type CloudLaneLaunchService } from "./cloudLaneLaunchService";
import { COMPUTER_DELETED_SENTENCE } from "./cloudLaneLaunchSteps";
import HANDED_OFF_RECORD from "./__fixtures__/handedOffCloudLaunch.json";
import { getDefaultModelDescriptor } from "../../../shared/modelRegistry";
import { encodeRoutePresetId } from "../../../shared/harnessRoutes";

const LAUNCH_ID = HANDED_OFF_RECORD.snapshot.launchId;
const INSTANCE_ID = HANDED_OFF_RECORD.snapshot.cloud.instanceId;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const services: CloudLaneLaunchService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

/**
 * A launch already handed to its computer's brain, mid-setup (a real record:
 * the environment stage was running when that computer was deleted), with the
 * brain unreachable from here and ADE Cloud's list as given.
 */
function handedOffLaunch(listInstances: () => Promise<Array<{ id: string; status: string }>>, getLaunch: () => Promise<unknown>) {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-lane-launch-"));
  fs.writeFileSync(path.join(recordsDir, `${LAUNCH_ID}.json`), JSON.stringify(HANDED_OFF_RECORD));
  const callChatAction = vi.fn(async (_binding: unknown, action: string) => {
    if (action === "getLaunch") return await getLaunch();
    throw new Error(`the computer is gone (${action})`);
  });
  const service = createCloudLaneLaunchService({
    recordsDir,
    logger: quiet,
    emit: () => undefined,
    creator: { client: async () => ({ listInstances }), directoryBaseUrl: () => null },
    removeAccountMachine: async () => undefined,
    pairMachine: async (machineKey: string) => ({ targetId: machineKey }),
    connect: async () => true,
    listProjects: async () => [],
    resolveBinding: async () => HANDED_OFF_RECORD.snapshot.cloud.binding,
    callChatAction,
    subscribeChatLaunchEvents: async () => () => undefined,
    // Nothing resumes on its own here: each read below is the test's.
    resumeDelayMs: 60 * 60_000,
  } as unknown as CloudLaneLaunchDeps);
  services.push(service);
  return { service, callChatAction };
}

const unreachable = async () => {
  throw new Error("connect ECONNREFUSED");
};

describe("a cloud lane launch whose computer is gone", () => {
  it.each([
    ["ADE Cloud no longer lists the computer", async () => [], "failed"],
    ["ADE Cloud lists it deleted", async () => [{ id: INSTANCE_ID, status: "deleted" }], "failed"],
    // Unreachable but still there (restarting, a network blip): it keeps going.
    ["ADE Cloud still lists it", async () => [{ id: INSTANCE_ID, status: "running" }], "running"],
    // A list that fails (the account lost ADE Cloud, the service is down) proves nothing.
    ["ADE Cloud's list fails", async () => { throw new Error("404 not_found"); }, "running"],
  ] as const)("%s → %s", async (_label, listInstances, phase) => {
    const { service } = handedOffLaunch(listInstances, unreachable);

    const snapshot = await service.get({ launchId: LAUNCH_ID });

    expect(snapshot?.phase).toBe(phase);
    expect(snapshot?.error ?? null).toBe(phase === "failed" ? COMPUTER_DELETED_SENTENCE : null);
  });

  it("stays ended when a read already out comes back, and Delete closes it without the computer", async () => {
    let answerLateRead: (value: unknown) => void = () => undefined;
    const lateRead = new Promise((resolve) => { answerLateRead = resolve; });
    let reads = 0;
    const { service, callChatAction } = handedOffLaunch(async () => [], async () => (++reads === 1 ? await lateRead : await unreachable()));

    const first = service.get({ launchId: LAUNCH_ID });
    expect((await service.get({ launchId: LAUNCH_ID }))?.phase).toBe("failed");
    // The read that was out before the computer was found gone says "running".
    answerLateRead({ ...HANDED_OFF_RECORD.snapshot, sequence: HANDED_OFF_RECORD.snapshot.sequence + 10_000 });
    await first;
    expect((await service.get({ launchId: LAUNCH_ID }))?.phase).toBe("failed");

    await expect(service.retry({ launchId: LAUNCH_ID })).rejects.toThrow(COMPUTER_DELETED_SENTENCE);
    const cancelled = await service.cancel({ launchId: LAUNCH_ID });
    expect(cancelled?.phase).toBe("cancelled");
    expect(callChatAction.mock.calls.map(([, action]) => action)).not.toContain("cancelLaunch");
  });
});

describe("a cloud chat launch's model", () => {
  const CODEX_DEFAULT = getDefaultModelDescriptor("codex")?.id;

  /** Starts a chat launch with these create fields and returns the model its saved record carries to the server and the computer. */
  async function savedModel(create: Record<string, unknown>) {
    const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-lane-launch-"));
    const service = createCloudLaneLaunchService({
      recordsDir,
      logger: quiet,
      emit: () => undefined,
      // No account service: the pipeline stops at its first step, after the record is saved.
      creator: { client: async () => null, directoryBaseUrl: () => null, getAccountToken: async () => null },
      removeAccountMachine: async () => undefined,
      resumeDelayMs: 60 * 60_000,
    } as unknown as CloudLaneLaunchDeps);
    services.push(service);
    const launchId = "22222222-3333-4444-8555-666666666666";
    await service.start({
      originUrl: "https://github.com/arul28/ADE.git",
      args: {
        launchId,
        kind: "chat",
        mode: "background",
        prompt: "Reply with only: ok",
        cloud: { sizeId: "small" },
        chat: { create: { provider: "codex", surface: "work", ...create }, message: { text: "Reply with only: ok" } },
      },
    } as never);
    const saved = JSON.parse(fs.readFileSync(path.join(recordsDir, `${launchId}.json`), "utf8"));
    const chatCreate = saved.launch.chat.create;
    return { model: chatCreate.model ?? null, modelId: chatCreate.modelId ?? null };
  }

  it.each([
    // ADE Cloud refuses a chat launch with no model: one named nothing takes the provider's default.
    ["no model", { model: "" }, { model: CODEX_DEFAULT, modelId: CODEX_DEFAULT }],
    ["a blank model", { model: "  ", modelId: " " }, { model: CODEX_DEFAULT, modelId: CODEX_DEFAULT }],
    ["a model", { model: "gpt-6-luna" }, { model: "gpt-6-luna", modelId: null }],
    ["a model id", { model: "", modelId: "openai/gpt-6-luna" }, { model: "", modelId: "openai/gpt-6-luna" }],
  ])("%s", async (_label, create, expected) => {
    expect(CODEX_DEFAULT).toBeTruthy();
    expect(await savedModel(create)).toEqual(expected);
  });

  it("a preset with no model runs the preset's model, and one this computer doesn't know is refused", async () => {
    const presetId = encodeRoutePresetId({ harness: "codex", source: { kind: "subscription", provider: "codex" }, model: "openai/gpt-6-luna" });
    const { model } = await savedModel({ model: "", presetId });
    expect(model).toBeTruthy();
    expect(model).not.toBe(CODEX_DEFAULT);
    expect(model).toContain("gpt-6-luna");

    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-home-"));
    vi.stubEnv("ADE_HOME", emptyHome);
    try {
      await expect(savedModel({ model: "", presetId: "no-such-preset" })).rejects.toThrow("can't find the preset");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
