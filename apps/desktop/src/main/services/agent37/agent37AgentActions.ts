/**
 * The `agent37` action domain's machine verbs, behind `ade agent37 …`: list,
 * create, sleep, wake, resize, copy, move, delete, the sleep setting, the
 * monthly cap, and "keep a cloud machine ready" on, off or retry.
 *
 * Account-level like the rest of the integration: each acts on the Agent 37
 * workspace with the account's key, from whichever brain is asked, and takes
 * no pin. Making a machine (create, copy, move) signs the new machine in
 * through a desktop's approval window, so those go to the desktop attached to
 * this brain over the desktop bridge; a brain with none says so.
 *
 * Money and deletes ask first. A person's own client (the desktop, the CTO)
 * already decided. An agent's call raises an approval card in its own chat,
 * which gives up after five minutes. A full-auto chat or an automation run has
 * nobody watching, so ADE answers for it, never stalling the agent: yes to
 * spending within the monthly cap, no to deleting a machine that chat didn't
 * make. Plan mode says no to all of it. Every answer ADE gives itself leaves
 * a line in the chat.
 */

import {
  AGENT37_MADE_BY_CHAT_METADATA,
  AGENT37_SHAPES,
  agent37CapReachedMessage,
  agent37HourlyUsd,
  agent37Shape,
  describeAgent37MachineSize,
  formatAgent37HourlyPrice,
  formatAgent37Usd,
  isAgent37MachineKind,
  type Agent37Budget,
  type Agent37CreateMachineArgs,
  type Agent37CreateMachineResult,
  type Agent37Machine,
  type Agent37MachineActionResult,
  type Agent37MachineKind,
  type Agent37MachinesResult,
  type Agent37ReadyProjectSettings,
  type Agent37ShapeId,
  type Agent37Spending,
} from "../../../shared/agent37";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { PermissionLevel } from "../../../shared/permissionLadder";
import { getErrorMessage } from "../shared/utils";
import type { Agent37Logger } from "./agent37Client";
import type { Agent37MoveResult } from "./agent37MachineCopy";
import type { createAgent37Machines } from "./agent37Machines";
import { normalizeAgent37ReadySettings, type Agent37ReadySettingsStore } from "./agent37ReadySettings";
import type { Agent37BudgetStore } from "./agent37Sleep";

/** Who is asking, stamped by the RPC server from the caller's session; never taken from the arguments. */
export type Agent37Approval =
  | { by: "person" }
  | { by: "agent"; chatSessionId: string | null };

/** What a desktop does for the brain over the bridge (agent37DesktopActions.ts). */
export type Agent37DesktopBridge = {
  create(args: Agent37CreateMachineArgs & { madeByChat?: string | null }): Promise<Agent37CreateMachineResult>;
  copy(args: { instanceId: string; name?: string | null; shape?: Agent37ShapeId | null; madeByChat?: string | null }): Promise<Agent37CreateMachineResult & { copiedFrom: string; forkMs: number }>;
  move(args: { instanceId: string; machineKey?: string | null; to: Agent37MachineKind; shape?: Agent37ShapeId | null; madeByChat?: string | null }): Promise<Agent37MoveResult>;
  readyRefresh(): Promise<unknown>;
};

export type Agent37ChatApprovals = {
  requestChatInput(args: {
    chatSessionId: string;
    title: string;
    body: string;
    timeoutMs?: number;
    allowsFreeform?: boolean;
    questions?: Array<{
      id?: string;
      header?: string;
      question: string;
      options?: Array<{ label: string; value?: string; description?: string; recommended?: boolean }>;
      allowsFreeform?: boolean;
    }>;
  }): Promise<{ decision: string; answers: Record<string, string[]>; timedOut?: boolean }>;
  /** The chat's permission level, or null when this brain doesn't know the chat. */
  permissionLevel(chatSessionId: string): PermissionLevel | null;
  isAutomationRun(chatSessionId: string): Promise<boolean>;
  notice(chatSessionId: string, message: string): void;
};

export type Agent37AgentActionDeps = {
  machines: ReturnType<typeof createAgent37Machines>;
  budget: Agent37BudgetStore;
  readySettings: Agent37ReadySettingsStore;
  /** The desktop attached to this brain, or null. */
  desktop: () => Agent37DesktopBridge | null;
  approvals: Agent37ChatApprovals | null;
  logger?: Agent37Logger;
};

/** An approval card that gives up: nobody watching must never hold an agent. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** The chat to credit a machine to: an agent's own chat, never a person's. */
function madeByChat(approval: Agent37Approval): string | null {
  return approval.by === "agent" ? approval.chatSessionId : null;
}

export class Agent37Declined extends Error {
  readonly code = "agent37_declined";
  constructor(message: string) {
    super(message);
    this.name = "Agent37Declined";
  }
}

function record(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function text(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readApproval(args: Record<string, unknown>): Agent37Approval {
  const raw = record(args.approval);
  if (raw.by === "person") return { by: "person" };
  return { by: "agent", chatSessionId: typeof raw.chatSessionId === "string" && raw.chatSessionId.trim() ? raw.chatSessionId.trim() : null };
}

const NO_DESKTOP = "Making a machine signs it in through the ADE desktop app, and none is open on this computer. Open ADE here, or run the command on a computer where it is open (--machine).";

export function buildAgent37AgentActions(deps: Agent37AgentActionDeps) {
  const logger = deps.logger ?? {};

  const readMachines = async (): Promise<Agent37MachinesResult> => {
    const result = await deps.machines.list();
    if (result.state === "not_connected") throw new Error("Connect Agent 37 first: Settings › Integrations › Agent 37.");
    if (result.state !== "ok") throw new Error(result.message ?? "ADE couldn't read your Agent 37 machines.");
    return result;
  };

  /** A box by its Agent 37 id, ADE machine key, or name. */
  const resolveMachine = async (selector: string | null): Promise<{ box: Agent37Machine; all: Agent37MachinesResult }> => {
    if (!selector) throw new Error("Name the machine: its name or Agent 37 id (ade agent37 list).");
    const all = await readMachines();
    const wanted = selector.toLowerCase();
    const matches = all.machines.filter((box) =>
      box.instanceId === selector || box.machineKey === selector || (box.name ?? "").toLowerCase() === wanted);
    if (!matches.length) throw new Error(`No Agent 37 machine is called "${selector}". ade agent37 list shows them.`);
    if (matches.length > 1) {
      throw new Error(`"${selector}" names ${matches.length} machines: ${matches.map((box) => box.instanceId).join(", ")}. Pass the id.`);
    }
    return { box: matches[0]!, all };
  };

  const capCheck = async (): Promise<Agent37Spending | null> => {
    const month = await deps.machines.spending().catch(() => null);
    if (month?.capReached) throw new Error(agent37CapReachedMessage(month));
    return month;
  };

  /**
   * Asks before spending or deleting. Resolves when it may go ahead; throws
   * `Agent37Declined` (with why) when not.
   */
  const approve = async (
    approval: Agent37Approval,
    card: {
      /** `cap`: raising or removing the cap, the one limit on unattended spending; only a person answers it. */
      action: "spend" | "delete" | "cap";
      title: string;
      body: string;
      confirm: string;
      madeByThisChat?: boolean;
    },
  ): Promise<void> => {
    if (approval.by === "person") return;
    const chatSessionId = approval.chatSessionId;
    if (!chatSessionId || !deps.approvals) {
      throw new Agent37Declined(`${card.title} costs money or deletes something, so it needs your yes, and ADE has no chat to ask you in. Run it from an ADE chat, or use the machine's card in ADE (Your computers).`);
    }
    const approvals = deps.approvals;
    const level = approvals.permissionLevel(chatSessionId);
    const automation = await approvals.isAutomationRun(chatSessionId).catch(() => false);
    if (level === "plan") {
      approvals.notice(chatSessionId, `ADE said no to "${card.title}" for this chat: plan mode changes nothing.`);
      throw new Agent37Declined(`${card.title}: declined, because this chat is in plan mode.`);
    }
    if (automation || level === "full-auto") {
      const where = automation ? "this automation run" : "this full-auto chat";
      if (card.action === "cap") {
        approvals.notice(chatSessionId, `ADE said no to "${card.title}" in ${where}: the cap is what bounds unattended spending, so only you can raise it.`);
        throw new Agent37Declined(`${card.title}: declined. The cap bounds what ${where} may spend, so only the person can raise it (Settings › Integrations › Agent 37).`);
      }
      if (card.action === "delete" && !card.madeByThisChat) {
        approvals.notice(chatSessionId, `ADE said no to "${card.title}" in ${where}: nobody is here to approve deleting a machine this chat didn't make.`);
        throw new Agent37Declined(`${card.title}: declined. Nobody is watching ${where} to approve deleting a machine it didn't make; ask the person to delete it from its card.`);
      }
      approvals.notice(chatSessionId, `ADE approved "${card.title}" for ${where}, within your monthly Agent 37 cap.`);
      return;
    }
    let response: Awaited<ReturnType<Agent37ChatApprovals["requestChatInput"]>>;
    try {
      response = await approvals.requestChatInput({
      chatSessionId,
      title: card.title,
      body: card.body,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      allowsFreeform: false,
      questions: [{
        id: "decision",
        header: "Agent 37",
        question: `${card.title}? ${card.body}`,
        allowsFreeform: false,
        options: [
          { label: card.confirm, value: "yes" },
          { label: "No", value: "no" },
        ],
      }],
      });
    } catch (error) {
      // The chat lives on another ADE on this computer, or is gone: there is no card to show.
      throw new Agent37Declined(`${card.title}: ADE couldn't ask in this chat (${getErrorMessage(error)}), so nothing was done.`);
    }
    const answer = response.answers.decision?.[0] ?? "";
    if (response.decision === "accept" && answer === "yes") return;
    throw new Agent37Declined(response.timedOut
      ? `${card.title}: nobody answered in 5 minutes, so nothing was done.`
      : `${card.title}: the person said no, so nothing was done.`);
  };

  const requireDesktop = (): Agent37DesktopBridge => {
    const desktop = deps.desktop();
    if (!desktop) throw new Error(NO_DESKTOP);
    return desktop;
  };

  const runAction = async (box: Agent37Machine, action: Parameters<typeof deps.machines.run>[0]): Promise<Agent37MachineActionResult> => {
    const result = await deps.machines.run(action);
    if (!result.ok) throw new Error(result.message);
    return result;
  };

  const summary = (box: Agent37Machine) => ({
    instanceId: box.instanceId,
    name: box.name,
    machineKey: box.machineKey,
    state: box.state,
    type: box.type,
    size: describeAgent37MachineSize(box),
    shape: box.shapeId,
    runningHourlyUsd: box.runningHourlyUsd,
    idleHourlyUsd: box.idleHourlyUsd,
    spentUsd: box.spentUsd,
    savedUsd: box.savedUsd,
    sleep: box.sleep,
    madeByAde: box.madeByAde,
    ready: box.ready,
    pastDue: box.pastDue,
  });

  const shapeArg = (args: Record<string, unknown>): Agent37ShapeId | null => {
    const raw = text(args, "shape");
    if (!raw) return null;
    const shape = agent37Shape(raw.replace(/\s+/g, "").replace("/", "x"));
    if (!shape) throw new Error(`Pick a size: ${AGENT37_SHAPES.map((candidate) => candidate.id).join(", ")} (vCPU x GB).`);
    return shape.id;
  };

  return {
    async list() {
      const all = await readMachines();
      return {
        machines: all.machines.map(summary),
        balanceUsd: all.balanceUsd,
        instanceLimit: all.instanceLimit,
        runningCount: all.runningCount,
        spending: all.spending,
      };
    },

    async create(rawArgs?: unknown) {
      const args = record(rawArgs);
      const kind = (text(args, "kind") ?? "box") as Agent37MachineKind;
      if (!isAgent37MachineKind(kind)) throw new Error("Make a box or a VM (--kind box|vm).");
      const shapeId = shapeArg(args) ?? (kind === "vm" ? "4x8" : "2x4");
      const shape = agent37Shape(shapeId)!;
      const name = text(args, "name") ?? (kind === "vm" ? "Agent 37 VM" : "Agent 37 box");
      await capCheck();
      const desktop = requireDesktop();
      const approval = readApproval(args);
      await approve(approval, {
        action: "spend",
        title: `Make "${name}" on Agent 37`,
        body: `A ${kind === "vm" ? "VM" : "box"} with ${shape.cpu} vCPU and ${shape.memoryGb} GB, about ${formatAgent37HourlyPrice(agent37HourlyUsd(kind, shape))} while awake. It sleeps when idle and then bills only its disk.`,
        confirm: "Make it",
      });
      return await desktop.create({ kind, shape: shapeId, name, madeByChat: madeByChat(approval) });
    },

    async sleep(rawArgs?: unknown) {
      const { box } = await resolveMachine(text(record(rawArgs), "machine"));
      return await runAction(box, { instanceId: box.instanceId, action: "sleep" });
    },

    /** Wake costs what a running box costs, like opening one of its lanes; the monthly cap bounds it. */
    async wake(rawArgs?: unknown) {
      const { box } = await resolveMachine(text(record(rawArgs), "machine"));
      return await runAction(box, { instanceId: box.instanceId, action: "wake" });
    },

    async resize(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const shapeId = shapeArg(args);
      if (!shapeId) throw new Error("Pass the new size (--shape 4x8).");
      const shape = agent37Shape(shapeId)!;
      await capCheck();
      await approve(readApproval(args), {
        action: "spend",
        title: `Resize "${box.name ?? box.instanceId}" to ${shape.cpu} vCPU · ${shape.memoryGb} GB`,
        body: `It restarts to change size: files stay, running chats, terminals and processes stop. Awake it then costs about ${formatAgent37HourlyPrice(agent37HourlyUsd(box.type === "vm" ? "vm" : "box", shape))}.`,
        confirm: "Resize",
      });
      return await runAction(box, { instanceId: box.instanceId, action: "resize", shape: shapeId });
    },

    async copy(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const name = text(args, "name") ?? `${box.name ?? box.instanceId} copy`;
      const shapeId = shapeArg(args);
      await capCheck();
      const desktop = requireDesktop();
      const rate = box.runningHourlyUsd != null ? formatAgent37HourlyPrice(box.runningHourlyUsd) : null;
      const approval = readApproval(args);
      await approve(approval, {
        action: "spend",
        title: `Copy "${box.name ?? box.instanceId}" into a new machine`,
        body: `"${name}" gets the same files (repos, lanes, installed dependencies) and signs in as a new machine${rate ? `, about ${rate} while awake` : ""}. A big disk takes a few minutes to copy.`,
        confirm: "Copy it",
      });
      return await desktop.copy({ instanceId: box.instanceId, name, shape: shapeId, madeByChat: madeByChat(approval) });
    },

    async move(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const to = text(args, "to") as Agent37MachineKind | null;
      if (!to || !isAgent37MachineKind(to)) throw new Error("Move it to a box or a VM (--to box|vm).");
      const shapeId = shapeArg(args);
      await capCheck();
      const desktop = requireDesktop();
      const name = box.name ?? box.instanceId;
      const approval = readApproval(args);
      await approve(approval, {
        action: "delete",
        title: `Move "${name}" to a ${to === "vm" ? "VM" : "box"}`,
        body: `ADE makes a new ${to === "vm" ? "VM" : "box"}, copies every repo, lane and chat on "${name}" into it, then deletes "${name}". Running processes stop${box.type === "vm" ? ", and Docker images and volumes stay behind" : ""}.`,
        confirm: "Move it",
        madeByThisChat: approval.by === "agent" && approval.chatSessionId != null
          && (await deps.machines.instanceMetadata(box.instanceId).catch(() => null))?.[AGENT37_MADE_BY_CHAT_METADATA] === approval.chatSessionId,
      });
      return await desktop.move({ instanceId: box.instanceId, machineKey: box.machineKey, to, shape: shapeId, madeByChat: madeByChat(approval) });
    },

    async delete(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const approval = readApproval(args);
      const instance = approval.by === "agent" && approval.chatSessionId
        ? await deps.machines.instanceMetadata(box.instanceId).catch(() => null)
        : null;
      await approve(approval, {
        action: "delete",
        title: `Delete "${box.name ?? box.instanceId}"`,
        body: `ADE deletes it on Agent 37 and removes it from your computers. Everything on its disk is gone for good: repos, lanes, and any work not pushed.`,
        confirm: "Delete it",
        madeByThisChat: approval.by === "agent" && approval.chatSessionId != null
          && instance?.[AGENT37_MADE_BY_CHAT_METADATA] === approval.chatSessionId,
      });
      return await runAction(box, { instanceId: box.instanceId, action: "delete", machineKey: box.machineKey });
    },

    async set_sleep(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { box } = await resolveMachine(text(args, "machine"));
      const raw = args.minutes;
      const minutes = raw === null || raw === "never" ? null : typeof raw === "number" ? raw : Number(raw);
      if (minutes !== null && !Number.isFinite(minutes)) throw new Error("Pass minutes (5 to 1440) or never.");
      // Never sleeping bills around the clock: that asks first.
      if (minutes === null) {
        await approve(readApproval(args), {
          action: "spend",
          title: `Keep "${box.name ?? box.instanceId}" awake`,
          body: `It won't sleep on its own, so it bills ${box.runningHourlyUsd != null ? formatAgent37HourlyPrice(box.runningHourlyUsd) : "its full rate"} around the clock until someone sleeps it.`,
          confirm: "Keep it awake",
        });
      }
      return await runAction(box, { instanceId: box.instanceId, action: "set_sleep", sleepAfterMinutes: minutes });
    },

    async spending() {
      const all = await readMachines();
      const saved = all.machines.reduce<number | null>((total, box) => (total == null || box.savedUsd == null ? null : total + box.savedUsd), 0);
      return { ...all.spending, balanceUsd: all.balanceUsd, savedUsd: saved };
    },

    async set_cap(rawArgs?: unknown) {
      const args = record(rawArgs);
      const raw = args.monthlyCapUsd;
      const cap = raw === null || raw === "off" ? null : typeof raw === "number" ? raw : Number(raw);
      if (cap !== null && !(Number.isFinite(cap) && cap > 0)) throw new Error("Pass a dollar amount above zero, or off.");
      const current: Agent37Budget = await deps.budget.read();
      // Raising the cap (or removing it) lets more money be spent: that asks. Lowering never does.
      const raising = cap === null || (current.monthlyCapUsd != null && cap > current.monthlyCapUsd);
      if (raising) {
        await approve(readApproval(args), {
          action: "cap",
          title: cap === null ? "Turn off the Agent 37 monthly cap" : `Raise the Agent 37 monthly cap to ${formatAgent37Usd(cap)}`,
          body: cap === null
            ? "With no cap, agents can keep making and waking machines for as long as the wallet pays."
            : `Machines may then spend up to ${formatAgent37Usd(cap)} this month (now ${current.monthlyCapUsd != null ? formatAgent37Usd(current.monthlyCapUsd) : "no cap"}).`,
          confirm: cap === null ? "Turn it off" : "Raise it",
        });
      }
      return await deps.budget.write({ monthlyCapUsd: cap });
    },

    async ready_set(rawArgs?: unknown) {
      const args = record(rawArgs);
      const identity = normalizeGitRemoteIdentity(text(args, "originUrl") ?? text(args, "identity"));
      if (!identity) throw new Error("Run it in a project with a git origin, or pass --origin <url>.");
      const { projects } = await deps.readySettings.read();
      const existing = projects.find((entry) => entry.identity === identity) ?? null;
      const kind = text(args, "kind") as Agent37MachineKind | null;
      const shape = shapeArg(args);
      const next = normalizeAgent37ReadySettings({
        ...(existing ?? {}),
        identity,
        projectName: text(args, "projectName") ?? existing?.projectName ?? undefined,
        ...(kind ? { kind } : {}),
        ...(shape ? { shape } : {}),
        ...(typeof args.setup === "string" ? { setup: args.setup } : {}),
        failure: null,
      } as Partial<Agent37ReadyProjectSettings>);
      if (!next) throw new Error("That isn't a project ADE can keep a machine ready for.");
      if (!existing) {
        await capCheck();
        const shape = agent37Shape(next.shape)!;
        await approve(readApproval(args), {
          action: "spend",
          title: `Keep a cloud machine ready for ${next.projectName}`,
          body: `ADE prepares a ${next.kind === "vm" ? "VM" : "box"} (${shape.cpu} vCPU · ${shape.memoryGb} GB) with the repository cloned and setup run, then keeps it asleep (about ${formatAgent37Usd(shape.diskGb * 0.09)} a month for its disk). A chat on it bills ${formatAgent37HourlyPrice(agent37HourlyUsd(next.kind, shape))} while awake.`,
          confirm: "Keep one ready",
        });
      }
      await deps.readySettings.write([...projects.filter((entry) => entry.identity !== identity), next]);
      await deps.desktop()?.readyRefresh().catch((error: unknown) => logger.warn?.("agent37.ready_refresh_failed", { error: getErrorMessage(error) }));
      return { identity, settings: next, preparedBy: deps.desktop() ? "this computer" : "the next ADE desktop that opens" };
    },

    async ready_off(rawArgs?: unknown) {
      const args = record(rawArgs);
      const identity = normalizeGitRemoteIdentity(text(args, "originUrl") ?? text(args, "identity"));
      if (!identity) throw new Error("Run it in a project with a git origin, or pass --origin <url>.");
      const { projects } = await deps.readySettings.read();
      if (!projects.some((entry) => entry.identity === identity)) return { identity, wasOn: false };
      await deps.readySettings.write(projects.filter((entry) => entry.identity !== identity));
      await deps.desktop()?.readyRefresh().catch(() => null);
      return { identity, wasOn: true };
    },

    async ready_retry(rawArgs?: unknown) {
      const args = record(rawArgs);
      const identity = normalizeGitRemoteIdentity(text(args, "originUrl") ?? text(args, "identity"));
      if (!identity) throw new Error("Run it in a project with a git origin, or pass --origin <url>.");
      const { projects } = await deps.readySettings.read();
      const entry = projects.find((candidate) => candidate.identity === identity);
      if (!entry) throw new Error("This project doesn't keep a machine ready. ade agent37 ready on turns it on.");
      await capCheck();
      await deps.readySettings.write(projects.map((candidate) => (candidate.identity === identity ? { ...candidate, failure: null } : candidate)));
      await deps.desktop()?.readyRefresh().catch(() => null);
      return { identity, retrying: true };
    },
  };
}

