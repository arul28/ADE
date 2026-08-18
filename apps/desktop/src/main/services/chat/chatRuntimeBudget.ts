/**
 * The warm-runtime budget: how many agent runtimes a process may keep alive at
 * once, and which one it releases to make room.
 *
 * Its own module because it is cross-service policy with no dependency on any
 * runtime type: both composition roots import it directly, and the LRU choice
 * it makes across services is testable without standing up a chat service.
 *
 * Why it is shared at all: a host builds one `agentChatService` per open
 * project scope (`apps/ade-cli/src/bootstrap.ts`, `apps/desktop/src/main/main.ts`)
 * and each used to apply the cap to its own sessions alone, making the real
 * bound `MAX_CONCURRENT_ACTIVE_RUNTIMES × open projects` — five Claude SDK
 * processes and their MCP children per project, which bounds nothing the
 * operating system cares about. Memory is owned by the process.
 *
 * Scope note: process, not machine. Desktop main and the brain are separate
 * processes and each keeps its own budget; a machine-wide bound would have to
 * arbitrate through `processRegistryService` and is deliberately out of scope.
 */

/**
 * How many agent runtimes one process keeps warm.
 *
 * A warm runtime is a live provider SDK process plus, for Claude, its MCP
 * server children — hundreds of megabytes each. This is the only bound on that,
 * so it is deliberately small; the cost of getting it wrong upward is a machine
 * that swaps, and downward is a cold start on the next turn.
 */
export const MAX_CONCURRENT_ACTIVE_RUNTIMES = 5;

/** A runtime a chat service is willing to release to stay under the budget. */
export type EvictableRuntime = {
  lastActivityTimestamp: number;
  evict: () => void;
};

/** One chat service, as seen by the shared runtime budget. */
export type RuntimeBudgetParticipant = {
  /** Every live runtime, releasable or not — this is the number being bounded. */
  countActiveRuntimes: () => number;
  /** Only the runtimes this service would agree to release right now. */
  listEvictableRuntimes: (excludeSessionId: string) => EvictableRuntime[];
};

/**
 * The budget shared by every chat service that answers for the same process.
 *
 * Owned by the composition root rather than by a module global, so which
 * services share a budget is a decision written at the wiring site instead of
 * an invisible consequence of importing this file. A service constructed
 * without one gets a private budget — the old per-service behaviour, and the
 * right answer for a single-scope host and for tests.
 */
export type ChatRuntimeBudget = {
  register: (participant: RuntimeBudgetParticipant) => void;
  unregister: (participant: RuntimeBudgetParticipant) => void;
  /**
   * Make room for one more runtime by releasing the globally
   * least-recently-used releasable one.
   *
   * At most ONE per call, deliberately. Draining all the way back to the cap
   * would, the first time a multi-scope host came under a shared budget, run a
   * dozen synchronous teardowns — each persisting chat state, closing a query,
   * and signalling a process group — on the main thread. Enforcing
   * incrementally as runtimes are created is how the cap has always worked, and
   * the idle sweep collects the rest.
   *
   * Best-effort: when nothing is releasable the budget yields rather than
   * tearing down work. Being over budget beats killing a live turn.
   */
  enforce: (excludeSessionId: string) => void;
};

export function createChatRuntimeBudget(
  maxConcurrentRuntimes: number = MAX_CONCURRENT_ACTIVE_RUNTIMES,
): ChatRuntimeBudget {
  const participants = new Set<RuntimeBudgetParticipant>();
  return {
    register: (participant) => { participants.add(participant); },
    unregister: (participant) => { participants.delete(participant); },
    enforce: (excludeSessionId) => {
      let active = 0;
      for (const participant of participants) active += participant.countActiveRuntimes();
      if (active < maxConcurrentRuntimes) return;

      // Chosen across ALL participants, not per participant: the runtime that
      // has gone longest without use is the cheapest to lose, no matter which
      // project owns it.
      let oldest: EvictableRuntime | null = null;
      for (const participant of participants) {
        for (const candidate of participant.listEvictableRuntimes(excludeSessionId)) {
          if (!oldest || candidate.lastActivityTimestamp < oldest.lastActivityTimestamp) {
            oldest = candidate;
          }
        }
      }
      oldest?.evict();
    },
  };
}
