import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_LANE_BRANCH_METADATA, CLOUD_LANE_ID_METADATA, CLOUD_LANE_NAME_METADATA } from "../../../shared/cloudLaneLaunch";
import type { CloudLaneWorkLane } from "../../../shared/cloudLaneLife";
import { createCloudLaneLife, type CloudLaneLifeDeps } from "./cloudLaneLife";
import { CLOUD_MACHINE_KEY_METADATA } from "./cloudMachines";
import type { CloudInstance, CloudProvider } from "./cloudProvider";

/**
 * Freeing and deleting a lane's computer: the work check decides whether its
 * work is safe. The cloud client, `machines.runPushWork` and `machines.run` are
 * the process boundaries; everything in the service is the real code.
 */

type PushTally = { pushed: number; failed: number; skipped: number; lanes: CloudLaneWorkLane[] | null };
type PushAnswer = { tally: PushTally | null; error: string | null };

const INSTANCE = "inst_1";
const LANE_METADATA = {
  [CLOUD_LANE_ID_METADATA]: "lane_1",
  [CLOUD_LANE_NAME_METADATA]: "Lane one",
  [CLOUD_LANE_BRANCH_METADATA]: "feature/one",
  [CLOUD_MACHINE_KEY_METADATA]: "mk_1",
};

function unpushedLane(): CloudLaneWorkLane {
  return { laneId: "lane_1", laneName: "Lane one", branchRef: "feature/one", primary: false, dirty: true, ahead: 1, state: "unpushed" };
}

function cleanLane(): CloudLaneWorkLane {
  return { laneId: "lane_1", laneName: "Lane one", branchRef: "feature/one", primary: false, dirty: false, ahead: 0, state: "pushed" };
}

const IDLE_STATE = { exitCode: 0, stdout: JSON.stringify({ busy: false, reasons: [] }), stderr: "" };

describe("cloud lane life: the work check", () => {
  let recordsDir: string;
  let pushWork: (args: { check: boolean }) => Promise<PushAnswer>;
  let exec: ReturnType<typeof vi.fn>;
  let run: ReturnType<typeof vi.fn>;
  let forgetMachineConnections: ReturnType<typeof vi.fn>;
  let changed: ReturnType<typeof vi.fn>;

  function instance(): CloudInstance {
    return { id: INSTANCE, status: "running", type: "default", resources: { cpu: 2, memory: 4 }, metadata: { ...LANE_METADATA } } as unknown as CloudInstance;
  }

  function build() {
    const client = {
      getInstance: vi.fn(async () => instance()),
      exec,
      listLanesWithoutComputer: vi.fn(async () => []),
    } as unknown as CloudProvider;
    const deps = {
      recordsDir,
      machines: {
        run,
        runPushWork: vi.fn((_id: string, options: { check: boolean }) => pushWork(options)),
        account: vi.fn(async () => ({})),
      },
      client: async () => client,
      copyDeps: {} as CloudLaneLifeDeps["copyDeps"],
      forgetMachineConnections,
      connectMachine: vi.fn(async () => ({ targetId: "t" })),
      listProjects: vi.fn(async () => []),
      emit: vi.fn(),
      changed,
      logger: {},
      now: () => 0,
      sleep: async () => undefined,
    } as unknown as CloudLaneLifeDeps;
    return { lane: createCloudLaneLife(deps), machines: deps.machines };
  }

  beforeEach(() => {
    recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-lane-life-"));
    pushWork = async () => ({ tally: { pushed: 0, failed: 0, skipped: 0, lanes: [] }, error: null });
    exec = vi.fn(async () => IDLE_STATE);
    run = vi.fn(async () => ({ ok: true, message: null }));
    forgetMachineConnections = vi.fn();
    changed = vi.fn();
  });

  afterEach(() => {
    fs.rmSync(recordsDir, { recursive: true, force: true });
  });

  // A work read that didn't see every project, or an old computer that sends no lane list, is unknown, never "all pushed".
  it.each<[string, PushTally]>([
    ["a project ADE couldn't open", { pushed: 0, failed: 1, skipped: 0, lanes: [] }],
    ["a computer whose ADE sends no lane list", { pushed: 0, failed: 0, skipped: 0, lanes: null }],
  ])("the work is unknown, not saved, when %s", async (_label, tally) => {
    pushWork = async () => ({ tally, error: null });
    const { lane, machines } = build();

    const result = await lane.workState({ instanceId: INSTANCE });

    expect(result.unpushed).toBeNull();
    expect(result.unpushedLanes).toEqual([]);
    expect(result.message).not.toBeNull();
    expect(machines.runPushWork).toHaveBeenCalledWith(INSTANCE, { check: true });
  });

  // Freeing a lane keeps its computer unless every check says the work is on GitHub.
  it.each<[string, () => void]>([
    ["the agent is busy", () => { exec.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ busy: true, reasons: ["agent_turn"] }), stderr: "" }); }],
    ["the busy state can't be read", () => { exec.mockRejectedValue(new Error("exec timed out")); }],
    ["the push leaves work unpushed", () => {
      pushWork = async ({ check }) => check ? { tally: { pushed: 0, failed: 0, skipped: 0, lanes: [] }, error: null }
        : { tally: { pushed: 0, failed: 0, skipped: 0, lanes: [unpushedLane()] }, error: null };
    }],
    ["work appears after the push", () => {
      pushWork = async ({ check }) => check ? { tally: { pushed: 1, failed: 0, skipped: 0, lanes: [unpushedLane()] }, error: null }
        : { tally: { pushed: 1, failed: 0, skipped: 0, lanes: [cleanLane()] }, error: null };
    }],
    ["the read after the push is unknown", () => {
      pushWork = async ({ check }) => check ? { tally: null, error: "ADE couldn't read this computer's work." }
        : { tally: { pushed: 1, failed: 0, skipped: 0, lanes: [cleanLane()] }, error: null };
    }],
  ])("a lane is not freed when %s, and its computer stays", async (_label, arrange) => {
    arrange();
    const { lane } = build();

    const result = await lane.freeLane({ instanceId: INSTANCE });

    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(forgetMachineConnections).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
