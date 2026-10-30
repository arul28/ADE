import type {
  RuntimeActivitySummary,
  RuntimeUpdateImpact,
  UpdateImpact,
  UpdateInstallImpact,
  UpdateInstallImpactPhone,
  UpdateInterruptedChat,
} from "../../../shared/types";
import { parseRuntimeUpdateImpact, UNKNOWN_UPDATE_IMPACT } from "../../../shared/updateImpact";
import type { Logger } from "../logging/logger";

/** The phone probe's own budget; it never spends the running-work probe's. */
const CONNECTED_PHONES_TIMEOUT_MS = 1_500;

export type UpdateImpactProbeDeps = {
  logger: Pick<Logger, "info" | "warn">;
  /**
   * The brain's machine-wide `runtime.updateImpact` reply. Null when project
   * runtimes run inside this process, which has no brain to ask.
   */
  readMachineImpact: (() => Promise<unknown>) | null;
  /**
   * Whether anything at all is running on this machine, for a brain too old to
   * answer the above. Null with in-process runtimes.
   */
  readMachineActivity: (() => Promise<RuntimeActivitySummary>) | null;
  /**
   * Chats mid-turn in the projects open in a window. With `strict`, rejects
   * when any project could not answer; without it, that project adds nothing.
   */
  listOpenProjectChats: (strict: boolean) => Promise<UpdateInterruptedChat[]>;
  listConnectedPhones: () => Promise<UpdateInstallImpactPhone[]>;
  /**
   * This machine's "Continue chats after restarts", for an answer that did
   * not carry it (in-process runtimes, an older brain).
   */
  readContinueAfterRestart?: () => boolean;
};

export type UpdateImpactProbe = {
  /**
   * Chats with a live turn on this machine right now. With `strict`, rejects
   * rather than return a list that may be missing a project.
   */
  liveChats: (options?: { strict?: boolean }) => Promise<UpdateInterruptedChat[]>;
  /**
   * What restarting ADE stops, for the update and quit dialogs. They wait on
   * it, so it is capped: past `timeoutMs` the running work comes back unknown
   * (`checked: false`), never as "nothing is running". Never rejects.
   */
  collect: (timeoutMs: number) => Promise<UpdateInstallImpact>;
};

/** `task`, or `fallback` when it has not settled in time or it failed. */
export async function settledWithin<T>(task: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task.catch((): T => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Answers "what would restarting ADE on this computer stop?".
 *
 * The brain answers for every project it has open, whether or not a window
 * shows it, and for personal chats. A brain from before `runtime.updateImpact`
 * is asked the older way: chats per open project, plus whether anything else
 * is running, since that answer cannot name CLI sessions or terminals.
 */
export function createUpdateImpactProbe(deps: UpdateImpactProbeDeps): UpdateImpactProbe {
  const readMachineWide = async (): Promise<RuntimeUpdateImpact | null> => {
    if (!deps.readMachineImpact) return null;
    try {
      const impact = parseRuntimeUpdateImpact(await deps.readMachineImpact());
      if (impact) return impact;
      deps.logger.info("autoUpdate.impact_probe_fallback", { error: "runtime.updateImpact returned no chat list." });
    } catch (error) {
      deps.logger.info("autoUpdate.impact_probe_fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  };

  const readRunningWork = async (): Promise<UpdateImpact> => {
    const machineWide = await readMachineWide();
    if (machineWide) return { ...machineWide, checked: true };
    const chats = await deps.listOpenProjectChats(true);
    const answer: UpdateImpact = { checked: true, chats, cliSessions: 0, terminals: 0 };
    if (!deps.readMachineActivity) return answer;
    const activity = await deps.readMachineActivity();
    // `activeAgentTurns` counts runtimes with an agent busy, not turns. More
    // busy runtimes than the open projects that named a chat means chats in
    // projects with no tab, which this older brain cannot list. Its session
    // count includes the listed chats' own rows, so it only says something
    // when no chat was found; a terminal beside a listed chat goes unnamed.
    const projectsWithChats = new Set(chats.map((chat) => chat.projectRoot ?? chat.projectName)).size;
    const moreIsRunning = (activity.activeWorkSessions > 0 && chats.length === 0)
      || activity.activeAgentTurns > projectsWithChats;
    return moreIsRunning ? { ...answer, busyWithoutDetail: true } : answer;
  };

  return {
    async liveChats(options = {}) {
      const machineWide = await readMachineWide();
      return machineWide?.chats ?? await deps.listOpenProjectChats(options.strict === true);
    },

    async collect(timeoutMs) {
      const startedAt = Date.now();
      const [connectedPhones, work] = await Promise.all([
        settledWithin(deps.listConnectedPhones(), CONNECTED_PHONES_TIMEOUT_MS, []),
        settledWithin<UpdateImpact & { failure?: string }>(
          readRunningWork().catch((error: unknown) => ({
            ...UNKNOWN_UPDATE_IMPACT,
            failure: error instanceof Error ? error.message : String(error),
          })),
          timeoutMs,
          { ...UNKNOWN_UPDATE_IMPACT, failure: "timeout" },
        ),
      ]);
      const { failure, ...impact } = work;
      if (impact.checked) {
        deps.logger.info("autoUpdate.impact_probe", {
          chats: impact.chats.length,
          cliSessions: impact.cliSessions,
          terminals: impact.terminals,
          busyWithoutDetail: impact.busyWithoutDetail === true,
          ms: Date.now() - startedAt,
        });
      } else {
        deps.logger.warn("autoUpdate.impact_probe_unknown", {
          reason: failure ?? "unknown",
          timeoutMs,
          ms: Date.now() - startedAt,
        });
      }
      let continueAfterRestart = impact.continueAfterRestart;
      if (continueAfterRestart === undefined && deps.readContinueAfterRestart) {
        try {
          continueAfterRestart = deps.readContinueAfterRestart();
        } catch {
          continueAfterRestart = undefined;
        }
      }
      return {
        ...impact,
        ...(continueAfterRestart !== undefined ? { continueAfterRestart } : {}),
        connectedPhones,
      };
    },
  };
}
