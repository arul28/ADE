/**
 * Making, copying and moving Agent 37 machines from a brain with no ADE
 * desktop window: a cloud machine, a Mac whose window is closed, the phone's
 * brain of choice. Everything runs here except the one step only the person
 * can do, approving the new machine joining their account. That goes out as a
 * sign-in link (the phone opens it natively, any signed-in browser works): to
 * the agent's chat as a notice, and to `status` for a caller (the phone) that
 * started the job in the background and shows the link itself.
 */

import { randomUUID } from "node:crypto";
import {
  AGENT37_MADE_BY_CHAT_METADATA,
  type Agent37CreateMachineArgs,
  type Agent37CreateProgress,
  type Agent37MachineKind,
  type Agent37ShapeId,
} from "../../../shared/agent37";
import { getErrorMessage } from "../shared/utils";
import { createAgent37Machine, type Agent37MachineCreatorDeps } from "./agent37MachineCreator";
import { copyAgent37Machine, moveAgent37Machine, type Agent37CopyDeps } from "./agent37MachineCopy";

export type Agent37MakeKind = "create" | "copy" | "move";

/** One make, as `status` reports it. */
export type Agent37MakeJob = {
  requestId: string;
  kind: Agent37MakeKind;
  stage: Agent37CreateProgress["stage"];
  message: string;
  instanceId: string | null;
  /** While the person must approve: the sign-in link to open. */
  approvalUrl: string | null;
  done: boolean;
  result: unknown;
  error: string | null;
  updatedAt: number;
};

export type Agent37MakeInput = (
  | { kind: "create"; machine: Agent37CreateMachineArgs; madeByChat?: string | null }
  | { kind: "copy"; instanceId: string; name?: string | null; shape?: Agent37ShapeId | null; madeByChat?: string | null }
  | { kind: "move"; instanceId: string; machineKey?: string | null; to: Agent37MachineKind; shape?: Agent37ShapeId | null; madeByChat?: string | null }
) & {
  /**
   * The yes came from what the person lets unattended agents do (a full-auto
   * chat or an automation, within the cap and the agent limits): this brain
   * may approve the new machine's sign-in itself, with no tap.
   */
  selfApprove?: boolean;
};

/** A finished job is kept this long for a caller to read its outcome. */
const FINISHED_JOB_TTL_MS = 30 * 60_000;
/** A self-approval comes this soon after its create started, or not at all. */
const SELF_APPROVAL_WINDOW_MS = 20 * 60_000;

export function createAgent37BrainMaker(deps: {
  /** The creator's deps without a window: the approval is handed off. */
  base: Omit<Agent37CopyDeps, "approveInWindow" | "handOffApproval" | "selfApproval">;
  logger?: {
    info?(event: string, meta?: Record<string, unknown>): void;
    warn?(event: string, meta?: Record<string, unknown>): void;
  };
}) {
  const jobs = new Map<string, Agent37MakeJob>();
  /** Requests whose sign-in this brain already approved itself: once each. */
  const selfApproved = new Set<string>();

  /**
   * Whether this brain may approve `instanceId`'s sign-in itself, with no
   * tap: the machine carries the request id of a make this brain started
   * with an unattended yes, the make is recent, it is the first ask for that
   * request, and the month is still under the cap. Every answer is logged.
   */
  const allowSelfApproval = async (
    input: { requestId: string; instanceId: string },
    make: { selfApprove: boolean; startedAt: number },
  ): Promise<boolean> => {
    const refuse = (reason: string) => {
      deps.logger?.info?.("agent37.self_approval_refused", { ...input, reason });
      return false;
    };
    if (!make.selfApprove) return refuse("not_unattended");
    if (Date.now() - make.startedAt > SELF_APPROVAL_WINDOW_MS) return refuse("too_late");
    if (selfApproved.has(input.requestId)) return refuse("already_used");
    const readFailed = (read: string) => (error: unknown) => {
      deps.logger?.warn?.("agent37.self_approval_read_failed", { ...input, read, error: error instanceof Error ? error.message : String(error) });
      return null;
    };
    const client = await deps.base.client().catch(readFailed("client"));
    const instance = client ? await client.getInstance(input.instanceId).catch(readFailed("instance")) : null;
    if (instance?.metadata?.ade_request_id !== input.requestId) return refuse("request_id_mismatch");
    // A month this brain can't read counts as over the cap: no tap needs a known spend.
    const month = await deps.base.spending?.().catch(readFailed("spending"));
    if (!month) return refuse("spend_unknown");
    if (month.capReached) return refuse("cap_reached");
    selfApproved.add(input.requestId);
    deps.logger?.info?.("agent37.self_approval_used", input);
    return true;
  };

  const prune = () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.done && now - job.updatedAt > FINISHED_JOB_TTL_MS) jobs.delete(id);
    }
  };

  /** Runs one make; resolves with its result. `onApproval` gets the sign-in link once. */
  const run = (input: Agent37MakeInput, onApproval?: (url: string, name: string) => void): { requestId: string; done: Promise<unknown> } => {
    prune();
    const requestId = randomUUID();
    const job: Agent37MakeJob = {
      requestId,
      kind: input.kind,
      stage: "creating",
      message: "Starting…",
      instanceId: null,
      approvalUrl: null,
      done: false,
      result: null,
      error: null,
      updatedAt: Date.now(),
    };
    jobs.set(requestId, job);
    const onProgress = (progress: Agent37CreateProgress) => {
      job.stage = progress.stage;
      job.message = progress.message;
      job.instanceId = progress.instanceId ?? job.instanceId;
      // The link is good only while the machine waits for the approval.
      job.approvalUrl = progress.stage === "approve_elsewhere" ? progress.approvalUrl ?? null : null;
      job.updatedAt = Date.now();
    };
    const startedAt = Date.now();
    const creatorDeps: Agent37CopyDeps = {
      ...deps.base,
      handOffApproval: ({ url, name }) => onApproval?.(url, name),
      selfApproval: (args) => allowSelfApproval(args, { selfApprove: input.selfApprove === true, startedAt }),
    };
    const madeBy = input.madeByChat ? { [AGENT37_MADE_BY_CHAT_METADATA]: input.madeByChat } : null;
    const work = (async (): Promise<unknown> => {
      if (input.kind === "create") {
        return await createAgent37Machine(creatorDeps as Agent37MachineCreatorDeps, requestId, input.machine, onProgress, madeBy ? { metadata: madeBy } : {});
      }
      if (input.kind === "copy") {
        return await copyAgent37Machine(creatorDeps, { instanceId: input.instanceId, requestId, name: input.name ?? null, shape: input.shape ?? null, madeByChat: input.madeByChat ?? null }, onProgress);
      }
      return await moveAgent37Machine(creatorDeps, {
        instanceId: input.instanceId,
        requestId,
        to: input.to,
        machineKey: input.machineKey ?? null,
        shape: input.shape ?? null,
        madeByChat: input.madeByChat ?? null,
      }, onProgress);
    })();
    const done = work.then(
      (result) => {
        Object.assign(job, { done: true, stage: "done", result, approvalUrl: null, message: "Done.", updatedAt: Date.now() });
        return result;
      },
      (error: unknown) => {
        const message = getErrorMessage(error);
        Object.assign(job, { done: true, stage: "failed", error: message, approvalUrl: null, message, updatedAt: Date.now() });
        deps.logger?.warn?.("agent37.brain_make_failed", { kind: input.kind, error: message });
        throw error;
      },
    );
    return { requestId, done };
  };

  return {
    /** Waits for the make; the approval link goes to `onApproval`. */
    async make(input: Agent37MakeInput, onApproval: (url: string, name: string) => void): Promise<unknown> {
      return await run(input, onApproval).done;
    },
    /** Starts the make and returns at once; read its progress and link with `status`. */
    start(input: Agent37MakeInput): string {
      const { requestId, done } = run(input);
      // Read through `status`; nobody awaits it here.
      done.catch(() => undefined);
      return requestId;
    },
    status(requestId: string): Agent37MakeJob | null {
      const job = jobs.get(requestId);
      return job ? { ...job } : null;
    },
  };
}

export type Agent37BrainMaker = ReturnType<typeof createAgent37BrainMaker>;
