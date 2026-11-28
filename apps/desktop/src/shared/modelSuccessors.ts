import { MODEL_REGISTRY, getModelById, type ModelDescriptor } from "./modelRegistry";

/**
 * Newer versions of a model (ADE-300). A registry row names the provider's
 * next version of the same model in `successorId` (Fable 5.1 -> Fable 5.2).
 * A row reached through another harness (OpenCode's
 * `opencode/anthropic/claude-fable-5-1`, Cursor's
 * `claude-fable-5-1-thinking-high`) is a "twin": the same wire id inside a
 * longer one, so its newer version is the same id with the wire id swapped.
 *
 * The answer is always a model the caller can run: `available` is the
 * composer's own list for the chat's machine, and nothing outside it is
 * offered.
 */

export type ModelUpgrade = {
  /** The model the chat or draft is on now. */
  fromModelId: string;
  /** The newest successor `available` lists. */
  toModelId: string;
};

const MAX_CHAIN = 8;

/** The successor chain of a registry row, oldest first. */
function successorChain(descriptor: ModelDescriptor): ModelDescriptor[] {
  const chain: ModelDescriptor[] = [];
  const seen = new Set<string>([descriptor.id]);
  let next = descriptor.successorId ? getModelById(descriptor.successorId) : undefined;
  while (next && !seen.has(next.id) && chain.length < MAX_CHAIN) {
    chain.push(next);
    seen.add(next.id);
    next = next.successorId ? getModelById(next.successorId) : undefined;
  }
  return chain;
}

/**
 * Rows with a successor, retired ones too (a saved chat can still be on one),
 * longest wire id first so `claude-opus-5-5` is tried before `claude-opus-5`.
 */
let predecessorRows: ModelDescriptor[] | null = null;
function rowsWithSuccessor(): ModelDescriptor[] {
  predecessorRows ??= MODEL_REGISTRY
    .filter((row) => row.successorId)
    .sort((a, b) => b.providerModelId.length - a.providerModelId.length);
  return predecessorRows;
}

/**
 * Where `token` sits in `id` as a whole wire id: after the start, `/` or
 * `:`, and not followed by more version digits (`claude-opus-5` is not
 * inside `claude-opus-5-5`). -1 when it does not.
 */
function wireIdIndex(id: string, token: string): number {
  let from = 0;
  for (;;) {
    const at = id.indexOf(token, from);
    if (at < 0) return -1;
    const before = at === 0 ? "" : id[at - 1]!;
    const after = id.slice(at + token.length);
    const startsClean = before === "" || before === "/" || before === ":";
    const endsClean = !/^[-.]\d/.test(after);
    if (startsClean && endsClean) return at;
    from = at + 1;
  }
}

/**
 * The newer version of `modelId` the caller can run, or null. Follows the
 * successor chain and returns its newest member in `available`, so a chat on
 * GPT-6 Sol moves straight to GPT-6.2 Sol.
 */
export function findModelUpgrade(modelId: string, available: readonly string[]): ModelUpgrade | null {
  const id = modelId.trim();
  if (!id || available.length === 0) return null;
  const listed = new Set(available);

  const row = getModelById(id);
  if (row?.successorId) {
    const chain = successorChain(row);
    for (let index = chain.length - 1; index >= 0; index--) {
      if (listed.has(chain[index]!.id)) return { fromModelId: id, toModelId: chain[index]!.id };
    }
    return null;
  }
  // A curated row without a successor is the newest of its line.
  // (`getModelById` also builds rows for harness ids, which are twins.)
  if (row && MODEL_REGISTRY.some((entry) => entry.id === row.id)) return null;

  // A twin through another harness: swap the wire id inside the longer id.
  for (const predecessor of rowsWithSuccessor()) {
    const token = predecessor.providerModelId;
    const at = wireIdIndex(id, token);
    if (at < 0) continue;
    const chain = successorChain(predecessor);
    for (let index = chain.length - 1; index >= 0; index--) {
      const candidate = `${id.slice(0, at)}${chain[index]!.providerModelId}${id.slice(at + token.length)}`;
      if (candidate !== id && listed.has(candidate)) return { fromModelId: id, toModelId: candidate };
    }
    return null;
  }
  return null;
}
