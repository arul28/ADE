import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  flushAdeCodeStateWrites,
  loadAdeCodeState,
  normalizeAdeCodeState,
  saveAdeCodeModelMemoryAsync,
  saveAdeCodeProjectState,
  saveAdeCodeProjectStateAsync,
  scopedAdeCodeModelMemory,
  scopedAdeCodeProviderSettings,
  scopedAdeCodeState,
} from "../state";

const MODEL_MEMORY = {
  provider: "codex",
  modelId: "gpt-5.6-sol",
  model: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  reasoningEffort: "xhigh",
  fastMode: false,
  interfaceMode: "chat" as const,
  permissionMode: "default",
  interactionMode: "default",
  claudePermissionMode: "default",
  codexApprovalPolicy: "on-request",
  codexSandbox: "workspace-write",
  codexConfigSource: "flags",
  opencodePermissionMode: "edit",
  droidPermissionMode: "auto-low",
  cursorModeId: null,
};

afterEach(() => {
  delete process.env.ADE_CODE_STATE_DIR;
});

describe("ade code persisted state", () => {
  it("prefers project-scoped lane and chat state over legacy global fallback", () => {
    const repoA = path.resolve("/repo-a");
    const repoB = path.resolve("/repo-b");
    const state = normalizeAdeCodeState({
      lastChatByLane: { main: "legacy-chat" },
      lastLaneId: "legacy-lane",
      lastChatByProjectLane: {
        [repoA]: { main: "repo-a-chat" },
        [repoB]: { main: "repo-b-chat" },
      },
      lastLaneByProject: {
        [repoA]: "repo-a-lane",
        [repoB]: "repo-b-lane",
      },
      draftKind: "chat",
      draftKindByProject: {
        [repoA]: "chat",
        [repoB]: "cli",
      },
    });

    expect(scopedAdeCodeState(state, repoB)).toEqual({
      lastChatByLane: { main: "repo-b-chat" },
      lastLaneId: "repo-b-lane",
      draftKind: "cli",
    });
  });

  it("uses legacy state as a migration fallback for projects without scoped entries", () => {
    const state = normalizeAdeCodeState({
      lastChatByLane: { main: "legacy-chat" },
      lastLaneId: "legacy-lane",
      draftKind: "cli",
      lastChatByProjectLane: {
        "/repo-a": { main: "repo-a-chat" },
      },
      lastLaneByProject: {
        "/repo-a": "repo-a-lane",
      },
    });

    expect(scopedAdeCodeState(state, "/repo-b")).toEqual({
      lastChatByLane: { main: "legacy-chat" },
      lastLaneId: "legacy-lane",
      draftKind: "cli",
    });
  });

  it("ignores malformed persisted records", () => {
    const state = normalizeAdeCodeState({
      lastChatByLane: { main: "legacy-chat", bad: 1 },
      lastLaneId: 7,
      lastChatByProjectLane: {
        "/repo-a": { main: "repo-a-chat", bad: false },
        "/empty": { bad: false },
      },
      lastLaneByProject: {
        "/repo-a": "repo-a-lane",
        "/repo-b": null,
      },
      draftKind: "terminal",
      draftKindByProject: {
        "/repo-a": "cli",
        "/repo-b": "terminal",
        "/repo-c": "chat",
      },
    });

    expect(state).toEqual({
      lastChatByLane: { main: "legacy-chat" },
      lastChatByProjectLane: { "/repo-a": { main: "repo-a-chat" } },
      lastLaneId: null,
      lastLaneByProject: { "/repo-a": "repo-a-lane" },
      draftKind: "chat",
      draftKindByProject: { "/repo-a": "cli", "/repo-c": "chat" },
      lastModelByProject: {},
      providerSettingsByProject: {},
    });
  });

  it("merges project-scoped saves with existing state under the shared state file", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-state-"));
    process.env.ADE_CODE_STATE_DIR = stateDir;

    await saveAdeCodeProjectStateAsync("/repo-a", {
      lastChatByLane: { main: "repo-a-chat" },
      lastLaneId: "repo-a-lane",
      draftKind: "chat",
    });
    await saveAdeCodeProjectStateAsync("/repo-b", {
      lastChatByLane: { main: "repo-b-chat" },
      lastLaneId: "repo-b-lane",
      draftKind: "cli",
    });

    const persisted = loadAdeCodeState();
    expect(persisted.lastChatByProjectLane).toEqual({
      [path.resolve("/repo-a")]: { main: "repo-a-chat" },
      [path.resolve("/repo-b")]: { main: "repo-b-chat" },
    });
    expect(persisted.lastLaneByProject).toEqual({
      [path.resolve("/repo-a")]: "repo-a-lane",
      [path.resolve("/repo-b")]: "repo-b-lane",
    });
    expect(persisted.draftKindByProject).toEqual({
      [path.resolve("/repo-a")]: "chat",
      [path.resolve("/repo-b")]: "cli",
    });
    expect(persisted.draftKind).toBe("cli");
    expect(fs.existsSync(path.join(stateDir, "ade-code-state.json.lock"))).toBe(false);
  });

  it("retries async saves behind an existing lock without blocking the caller", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-state-"));
    process.env.ADE_CODE_STATE_DIR = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "ade-code-state.json.lock");
    fs.writeFileSync(lockPath, "other writer");

    const savePromise = saveAdeCodeProjectStateAsync("/repo-a", {
      lastChatByLane: { main: "repo-a-chat" },
      lastLaneId: "repo-a-lane",
      draftKind: "cli",
    });
    let settled = false;
    savePromise.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);

    fs.unlinkSync(lockPath);
    await savePromise;

    const persisted = loadAdeCodeState();
    expect(persisted.lastChatByProjectLane).toEqual({
      [path.resolve("/repo-a")]: { main: "repo-a-chat" },
    });
    expect(persisted.draftKindByProject).toEqual({
      [path.resolve("/repo-a")]: "cli",
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("flushes fire-and-forget project state saves before shutdown", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-state-"));
    process.env.ADE_CODE_STATE_DIR = stateDir;

    saveAdeCodeProjectState("/repo-a", {
      lastChatByLane: { main: "repo-a-chat" },
      lastLaneId: "repo-a-lane",
      draftKind: "cli",
    });
    await flushAdeCodeStateWrites();

    const persisted = loadAdeCodeState();
    expect(persisted.lastChatByProjectLane[path.resolve("/repo-a")]).toEqual({ main: "repo-a-chat" });
    expect(persisted.lastLaneByProject[path.resolve("/repo-a")]).toBe("repo-a-lane");
    expect(persisted.draftKindByProject[path.resolve("/repo-a")]).toBe("cli");
  });
});

describe("ade code model memory", () => {
  it("keeps the last model and the per-provider settings project-scoped", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tui-model-memory-"));
    process.env.ADE_CODE_STATE_DIR = home;
    const repoA = path.resolve("/repo-a");
    const repoB = path.resolve("/repo-b");

    await saveAdeCodeModelMemoryAsync(repoA, MODEL_MEMORY);
    await saveAdeCodeModelMemoryAsync(repoA, {
      ...MODEL_MEMORY,
      provider: "claude",
      modelId: "claude-opus-5",
      model: "claude-opus-5",
      displayName: "Opus 5",
      reasoningEffort: "high",
      claudePermissionMode: "plan",
      interfaceMode: "cli",
    });

    const state = loadAdeCodeState();
    // The project's "next chat" default is the LAST model used there…
    expect(scopedAdeCodeModelMemory(state, repoA)).toMatchObject({ provider: "claude", modelId: "claude-opus-5" });
    // …while each provider keeps the settings it was last used with.
    expect(scopedAdeCodeProviderSettings(state, repoA, "codex")).toMatchObject({
      reasoningEffort: "xhigh",
      interfaceMode: "chat",
    });
    expect(scopedAdeCodeProviderSettings(state, repoA, "claude")).toMatchObject({
      reasoningEffort: "high",
      claudePermissionMode: "plan",
      interfaceMode: "cli",
    });
    // Another project inherits nothing.
    expect(scopedAdeCodeModelMemory(state, repoB)).toBeNull();
    expect(scopedAdeCodeProviderSettings(state, repoB, "codex")).toBeNull();

    fs.rmSync(home, { recursive: true, force: true });
  });

  it("does not lose model memory when lane/chat state is written", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tui-model-memory-"));
    process.env.ADE_CODE_STATE_DIR = home;
    const repo = path.resolve("/repo-c");

    await saveAdeCodeModelMemoryAsync(repo, MODEL_MEMORY);
    await saveAdeCodeProjectStateAsync(repo, {
      lastChatByLane: { main: "chat-1" },
      lastLaneId: "main",
      draftKind: "chat",
    });

    expect(scopedAdeCodeModelMemory(loadAdeCodeState(), repo)).toMatchObject({ modelId: "gpt-5.6-sol" });

    fs.rmSync(home, { recursive: true, force: true });
  });

  it("drops a malformed memory entry instead of failing the whole load", () => {
    const state = normalizeAdeCodeState({
      lastModelByProject: { "/repo-x": { modelId: "no-provider" }, "/repo-y": MODEL_MEMORY },
      providerSettingsByProject: { "/repo-y": { codex: { reasoningEffort: "high" } } },
    });
    expect(Object.keys(state.lastModelByProject)).toEqual(["/repo-y"]);
    expect(state.providerSettingsByProject["/repo-y"]?.codex).toMatchObject({
      reasoningEffort: "high",
      // Missing fields fall back rather than landing as undefined.
      permissionMode: "default",
      fastMode: false,
    });
  });
});
