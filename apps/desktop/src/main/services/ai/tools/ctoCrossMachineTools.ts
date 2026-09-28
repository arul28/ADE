/**
 * The CTO tools that reach the account's other machines, and the helpers the
 * typed tools in `ctoOperatorTools.ts` use for their `machine` branch.
 *
 * Everything here goes through `CtoCrossMachineDeps` (the brain's bridge). The
 * bridge owns the account, the toggle, pairing and the transport; this file
 * owns what the model sees: argument handling, confirmation, the secret
 * refusal, and the size clamp.
 */
import { z } from "zod";
import type { AgentChatSession, AgentChatSessionSummary, LaneSummary } from "../../../../shared/types";
import { isSecretBearingAdeAction } from "../../adeActions/actionPolicy";
import { getErrorMessage } from "../../shared/utils";
import {
  clampActionListForModel,
  clampMachineResultForModel,
  isReadOnlyAdeActionName,
  type CtoCrossMachineDeps,
  type CtoMachineTarget,
  type CtoRemoteActionCall,
} from "./ctoCrossMachine";
import { executableTool } from "./executableTool";

/** A lane row from another machine's `lane.list`: its `LaneSummary`, as JSON. */
export type CtoRemoteLane = Partial<LaneSummary> & { id: string };
/** A chat row from another machine's `chat.listSessions` / `getSessionSummary`. */
export type CtoRemoteChat = Partial<AgentChatSessionSummary> & { sessionId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asRemoteLanes(raw: unknown): CtoRemoteLane[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is CtoRemoteLane => isRecord(row) && typeof row.id === "string");
}

export function asRemoteChats(raw: unknown): CtoRemoteChat[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is CtoRemoteChat => isRecord(row) && typeof row.sessionId === "string");
}

export function asRemoteChat(raw: unknown): CtoRemoteChat | null {
  return isRecord(raw) && typeof raw.sessionId === "string" ? raw as CtoRemoteChat : null;
}

/** The lane fields `listLanes` reports, the same for this machine and another. */
export function summarizeLane(lane: CtoRemoteLane | LaneSummary) {
  return {
    id: lane.id,
    name: lane.name,
    branchRef: lane.branchRef,
    parentLaneId: lane.parentLaneId,
    worktreePath: lane.worktreePath,
    childCount: lane.childCount,
    status: lane.status,
  };
}

export type CtoCrossMachineToolDeps = {
  crossMachine?: CtoCrossMachineDeps | null;
  currentSessionId: string;
  laneService: { list: (args: { includeArchived?: boolean }) => Promise<LaneSummary[]> };
  listChats: (
    laneId?: string,
    options?: { includeIdentity?: boolean; includeAutomation?: boolean },
  ) => Promise<AgentChatSessionSummary[]>;
  scheduledWorkService?: {
    create: (args: {
      sessionId: string;
      prompt: string;
      delaySeconds?: number;
      recurring?: boolean;
      reason?: string;
    }) => Promise<unknown>;
  } | null;
  /** The CTO's destructive-action gate: an error result when the user declines, else null. */
  confirmDestructive: (args: {
    title: string;
    description: string;
    detail?: Record<string, unknown>;
  }) => Promise<{ success: false; error: string } | null>;
};

export type CtoRemoteChatSpawn = {
  laneId?: string;
  title?: string;
  initialPrompt?: string;
  provider: AgentChatSession["provider"];
  model: string;
  modelId: string | null;
  reasoningEffort: string | null;
  permissionMode?: AgentChatSession["permissionMode"];
  droidPermissionMode?: AgentChatSession["droidPermissionMode"];
  checkBackMinutes?: number;
};

const NOT_REACHABLE = "Other machines are not reachable from this runtime.";

export function createCtoCrossMachineToolKit(deps: CtoCrossMachineToolDeps) {
  /**
   * Resolves a typed tool's `machine` argument. `null` means run here, on the
   * home machine: the argument was omitted, or it names this machine. Throws a
   * message the model can act on for anything else that cannot be reached.
   */
  const remoteMachine = async (machine: string | undefined): Promise<CtoMachineTarget | null> => {
    const query = machine?.trim();
    if (!query) return null;
    if (!deps.crossMachine) throw new Error(`${NOT_REACHABLE} Omit machine to work on the home machine.`);
    const target = await deps.crossMachine.resolveMachine(query);
    return target.isThisMachine ? null : target;
  };

  const onMachine = (target: CtoMachineTarget) => ({ machineId: target.machineId, machineName: target.name });

  const runRemote = async (target: CtoMachineTarget, call: CtoRemoteActionCall): Promise<unknown> => {
    if (!deps.crossMachine) throw new Error(NOT_REACHABLE);
    return await deps.crossMachine.runAction(target, call);
  };

  /**
   * A chat on another machine cannot wake the CTO, so the CTO's own thread
   * wakes itself: one durable check-in through the same scheduled-work path
   * the `scheduleWork` tool uses.
   */
  const scheduleRemoteCheckIn = async (args: {
    target: CtoMachineTarget;
    sessionId: string;
    title: string;
    minutes: number;
  }): Promise<{ scheduled: boolean; minutes: number; scheduleId?: string | null; reason?: string }> => {
    if (args.minutes <= 0) return { scheduled: false, minutes: 0, reason: "checkBackMinutes was 0" };
    if (!deps.scheduledWorkService) return { scheduled: false, minutes: args.minutes, reason: "scheduled work is not available here" };
    try {
      const created = await deps.scheduledWorkService.create({
        sessionId: deps.currentSessionId,
        delaySeconds: args.minutes * 60,
        recurring: false,
        reason: `Check on "${args.title.slice(0, 60)}" on ${args.target.name}`,
        prompt: [
          `Scheduled check-in: the chat ${args.sessionId} you started on ${args.target.name} ("${args.title.slice(0, 80)}").`,
          `Call getChatStatus({ sessionId: "${args.sessionId}", machine: "${args.target.machineId}" }), and getChatTranscript with the same machine if you need detail.`,
          "If it finished, tell the user the result. If it is still working, schedule another check with scheduleWork. If it is blocked on input, say what it needs.",
        ].join(" "),
      });
      const record = isRecord(created) ? created : {};
      const scheduleId = record.scheduleId ?? record.id;
      return { scheduled: true, minutes: args.minutes, scheduleId: typeof scheduleId === "string" ? scheduleId : null };
    } catch (error) {
      return { scheduled: false, minutes: args.minutes, reason: getErrorMessage(error) };
    }
  };

  /**
   * `spawnChat` on another machine. Work runs on the machine that owns the
   * lane: the lane is created there when none is named, and a named lane must
   * already be there. No orchestration parent: lineage is a same-machine
   * relationship, and the child's host has no CTO session to report to.
   */
  const spawnRemoteChat = async (target: CtoMachineTarget, args: CtoRemoteChatSpawn) => {
    let remoteLaneId = args.laneId?.trim() || "";
    if (!remoteLaneId) {
      const lane = await runRemote(target, {
        domain: "lane",
        action: "create",
        args: {
          name: args.title?.trim() || "implementation chat",
          description: "Dedicated implementation lane launched from the CTO coordinator chat.",
        },
        timeoutMs: 120_000,
      });
      remoteLaneId = isRecord(lane) && typeof lane.id === "string" ? lane.id : "";
      if (!remoteLaneId) throw new Error(`${target.name} created a lane but did not return its id.`);
    }
    const createdRaw = await runRemote(target, {
      domain: "chat",
      action: "createSession",
      args: {
        laneId: remoteLaneId,
        provider: args.provider,
        model: args.model,
        ...(args.modelId ? { modelId: args.modelId } : {}),
        reasoningEffort: args.reasoningEffort,
        ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
        ...(args.droidPermissionMode !== undefined ? { droidPermissionMode: args.droidPermissionMode } : {}),
        surface: "work",
        sessionProfile: "workflow",
      },
      timeoutMs: 60_000,
    });
    const created: Partial<AgentChatSession> = isRecord(createdRaw) ? createdRaw : {};
    const remoteSessionId = typeof created.id === "string" ? created.id : "";
    if (!remoteSessionId) throw new Error(`${target.name} did not return the new chat's id.`);
    const warnings: string[] = [];
    const title = args.title?.trim() || "";
    const initialPrompt = args.initialPrompt?.trim() || "";
    if (title) {
      await runRemote(target, {
        domain: "chat",
        action: "updateSession",
        args: { sessionId: remoteSessionId, title },
      }).catch((error) => warnings.push(`Title not set: ${getErrorMessage(error)}`));
    }
    if (initialPrompt) {
      try {
        await runRemote(target, {
          domain: "chat",
          action: "sendMessage",
          args: { sessionId: remoteSessionId, text: initialPrompt },
        });
      } catch (error) {
        // The chat exists; say so, so the CTO sends the prompt again instead
        // of starting a second chat.
        return {
          success: false,
          ...onMachine(target),
          sessionId: remoteSessionId,
          laneId: remoteLaneId,
          error: `The chat was created on ${target.name}, but its first message failed: ${getErrorMessage(error)}`,
        };
      }
    }
    const followUp = await scheduleRemoteCheckIn({
      target,
      sessionId: remoteSessionId,
      title: title || initialPrompt || "remote chat",
      minutes: args.checkBackMinutes ?? 15,
    });
    return {
      success: true,
      ...onMachine(target),
      openInUi: false,
      sessionId: remoteSessionId,
      laneId: typeof created.laneId === "string" ? created.laneId : remoteLaneId,
      requestedTitle: title || null,
      provider: created.provider ?? args.provider,
      model: created.model ?? args.model,
      modelId: created.modelId ?? args.modelId ?? null,
      permissionMode: created.permissionMode ?? null,
      droidPermissionMode: created.droidPermissionMode ?? null,
      spawnKind: null,
      followUp,
      note: followUp.scheduled
        ? `Runs on ${target.name}. It cannot wake you; a check-in is scheduled on your thread in ${followUp.minutes} min. Check it sooner with getChatStatus({ sessionId, machine: "${target.machineId}" }).`
        : `Runs on ${target.name}. It cannot wake you and no check-in was scheduled${followUp.reason ? ` (${followUp.reason})` : ""}: use scheduleWork to check back, or getChatStatus({ sessionId, machine: "${target.machineId}" }).`,
      ...(warnings.length ? { warnings } : {}),
    };
  };

  /** The machine a generic action tool targets: the named one, or home. */
  const targetFor = async (crossMachine: CtoCrossMachineDeps, machine: string | undefined): Promise<CtoMachineTarget> =>
    machine?.trim() ? await crossMachine.resolveMachine(machine) : crossMachine.homeMachine();

  const machineArg = z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Machine id or name from listMachines (case-insensitive). Omit for your home machine.");

  const listMachines = executableTool({
    description:
      "List the machines on this ADE account: which one is your home machine, which are online, and which have this "
      + "project's repository. Call it before passing `machine` to any other tool. Set includeWork to also read each "
      + "machine's lane count and running chats for this project (slower: it asks every online machine).",
    inputSchema: z.object({
      includeWork: z.boolean().optional().default(false),
    }),
    execute: async ({ includeWork }) => {
      if (!deps.crossMachine) return { success: false, error: NOT_REACHABLE };
      try {
        const listed = await deps.crossMachine.listMachines({ includeWork });
        if (listed.state !== "ok") return { success: false, state: listed.state, error: listed.message };
        const machines = await Promise.all(listed.machines.map(async (machine) => {
          if (!machine.isThisMachine || !includeWork) return machine;
          // The home machine answers from its own services, not over the wire.
          const [lanes, chats] = await Promise.all([
            deps.laneService.list({ includeArchived: false }).catch(() => null),
            deps.listChats(undefined, { includeIdentity: false, includeAutomation: false }).catch(() => null),
          ]);
          return {
            ...machine,
            laneCount: lanes ? lanes.length : null,
            runningChatCount: chats ? chats.filter((chat) => chat.status === "active").length : null,
          };
        }));
        return { success: true, projectOrigin: listed.projectOrigin, count: machines.length, machines };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  const listMachineActions = executableTool({
    description:
      "List the ADE actions a machine will run for you — the same surface as `ade actions run <domain>.<action>`, "
      + "filtered by THAT machine's policy for your role. Pass domain (e.g. 'lane', 'chat', 'git', 'pr', 'files') to also get "
      + "each action's input contract. Omit machine for your home machine. Use it before runMachineAction instead of guessing names.",
    inputSchema: z.object({
      machine: machineArg,
      domain: z.string().trim().min(1).optional().describe("One ADE action domain. Omit to list every domain's action names."),
    }),
    execute: async ({ machine, domain }) => {
      if (!deps.crossMachine) return { success: false, error: NOT_REACHABLE };
      try {
        const target = await targetFor(deps.crossMachine, machine);
        const listed = await deps.crossMachine.listActions(target, domain ?? null);
        const clamped = clampActionListForModel(listed.actions);
        const truncated = clamped.truncated || listed.actions.length < listed.count;
        return {
          success: true,
          machineId: target.machineId,
          machineName: target.name,
          isThisMachine: target.isThisMachine,
          count: listed.count,
          actions: clamped.actions,
          ...(truncated
            ? { truncated: true, note: "More actions than fit. Pass domain to list one domain at a time." }
            : {}),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  const runMachineAction = executableTool({
    description:
      "Run one ADE action on any machine on the account (your full remote surface: everything `ade actions run` exposes), "
      + "in this project's checkout on that machine. The machine's own policy decides what is allowed and its refusal is "
      + "returned verbatim. Reads (get*/list*/read*/search*/preview*…) run straight away; anything else asks the user to "
      + "confirm first. Actions that return secrets or tokens are refused. Use it to answer questions about another machine "
      + "directly; prefer the typed tools (listLanes, spawnChat, …) when one fits. Call listMachineActions to find the action "
      + "and its input.",
    inputSchema: z.object({
      machine: machineArg,
      domain: z.string().trim().min(1).describe("ADE action domain, e.g. 'lane', 'chat', 'git', 'pr'."),
      action: z.string().trim().min(1).describe("Action name in that domain, e.g. 'list', 'getStatus'."),
      args: z.record(z.string(), z.unknown()).optional().describe("Object arguments (what --input-json would carry)."),
      arg: z.union([z.string(), z.number(), z.boolean()]).optional().describe("A single scalar argument, for actions that take one instead of args."),
      timeoutSeconds: z.number().int().positive().max(180).optional().describe("Wait this long for the answer. Default 30."),
    }),
    execute: async ({ machine, domain, action, args, arg, timeoutSeconds }) => {
      if (!deps.crossMachine) return { success: false, error: NOT_REACHABLE };
      // Before anything connects: the result would put a secret in the transcript.
      if (isSecretBearingAdeAction(domain, action)) {
        return {
          success: false,
          error: `${domain}.${action} returns secrets, so the CTO can't run it. Ask the user to read it in Settings.`,
        };
      }
      try {
        const target = await targetFor(deps.crossMachine, machine);
        const readOnly = isReadOnlyAdeActionName(action);
        if (!readOnly) {
          const declined = await deps.confirmDestructive({
            title: `Run ${domain}.${action} on ${target.name}`,
            description: `The CTO wants to run ${domain}.${action} on ${target.name}${target.isThisMachine ? " (this machine)" : ""}. This can change things there.`,
            detail: {
              machine: target.name,
              domain,
              action,
              ...(args ? { args } : {}),
              ...(arg !== undefined ? { arg } : {}),
            },
          });
          if (declined) return declined;
        }
        const result = await deps.crossMachine.runAction(target, {
          domain,
          action,
          ...(args ? { args } : {}),
          ...(arg !== undefined ? { arg } : {}),
          ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}),
        });
        return {
          success: true,
          machineId: target.machineId,
          machineName: target.name,
          isThisMachine: target.isThisMachine,
          readOnly,
          ...clampMachineResultForModel(result),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });

  return {
    remoteMachine,
    onMachine,
    runRemote,
    spawnRemoteChat,
    tools: { listMachines, listMachineActions, runMachineAction },
  };
}
