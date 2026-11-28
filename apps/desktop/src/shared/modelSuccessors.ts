import { MODEL_REGISTRY, getModelById, type ModelDescriptor } from "./modelRegistry";

/**
 * Newer versions of a model (ADE-300). A registry row names the provider's
 * next version of the same model in `successorId` (Fable 5.1 -> Fable 5.2).
 * A row reached through another harness (OpenCode's
 * `opencode/anthropic/claude-fable-5-1`, Cursor's
 * `claude-fable-5.1-thinking-high`) is a "twin": the same wire id inside a
 * longer one, dashed or dotted, so its newer version is the same id with the
 * wire id swapped in the same spelling.
 *
 * The answer is always a model the caller can run: `available` is the
 * composer's own list for the chat's machine, and nothing outside it is
 * offered.
 *
 * Covered: Claude, Codex, Muse and Grok rows, and their twins in Cursor,
 * OpenCode, Pi, Droid, Copilot and Antigravity (whose lists come from their
 * CLIs: a twin is offered only when that list has the newer one). Qwen, Kimi,
 * Devin and Copilot's own rows list no older version. iOS mirrors this file
 * (`WorkModelUpgrade.swift`).
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

/** The spellings a harness writes a wire id in: as is, dotted (`5.1`), dashed (`4-5`). */
const SPELLINGS: ReadonlyArray<(wireId: string) => string> = [
  (wireId) => wireId,
  (wireId) => wireId.replace(/(\d)-(?=\d)/g, "$1."),
  (wireId) => wireId.replace(/(\d)\.(?=\d)/g, "$1-"),
];

/**
 * Where `token` sits in `id` as a whole wire id, or -1. Only the last path
 * segment is the model (`pi/<profile>/<provider>/<model>`: a profile named
 * like a model is not one). It starts the segment or follows `:` or an
 * encoded `/` (OpenRouter's `anthropic%2Fclaude-opus-5`), and is not followed
 * by more version digits (`claude-opus-5` is not inside `claude-opus-5-5`).
 */
function wireIdIndex(id: string, token: string): number {
  const segmentStart = id.lastIndexOf("/") + 1;
  let from = segmentStart;
  for (;;) {
    const at = id.indexOf(token, from);
    if (at < 0) return -1;
    const startsClean = at === segmentStart
      || id[at - 1] === ":"
      || id.slice(at - 3, at).toUpperCase() === "%2F";
    const endsClean = !/^[-.]\d/.test(id.slice(at + token.length));
    if (startsClean && endsClean) return at;
    from = at + 1;
  }
}

type Twin = {
  predecessor: ModelDescriptor;
  /**
   * The id with the successor's wire id in place of the predecessor's, once
   * per spelling that matched: `claude-opus-5` reads the same dashed and
   * dotted, and its newer version may be listed as `-5-5` or `.5.5`.
   */
  swaps: Array<(successor: ModelDescriptor) => string>;
};

/** The registry row `id` is a twin of, through another harness, or null. */
function findTwin(id: string): Twin | null {
  for (const predecessor of rowsWithSuccessor()) {
    const swaps: Twin["swaps"] = [];
    for (const spell of SPELLINGS) {
      const token = spell(predecessor.providerModelId);
      const at = wireIdIndex(id, token);
      if (at < 0) continue;
      swaps.push((successor) => `${id.slice(0, at)}${spell(successor.providerModelId)}${id.slice(at + token.length)}`);
    }
    if (swaps.length) return { predecessor, swaps };
  }
  return null;
}

/** A curated row: `getModelById` also builds rows for harness ids, which are twins. */
function curatedRow(id: string): ModelDescriptor | null {
  const row = getModelById(id);
  return row && MODEL_REGISTRY.some((entry) => entry.id === row.id) ? row : null;
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

  const row = curatedRow(id);
  if (row) {
    const chain = successorChain(row);
    for (let index = chain.length - 1; index >= 0; index--) {
      if (listed.has(chain[index]!.id)) return { fromModelId: id, toModelId: chain[index]!.id };
    }
    return null;
  }

  const twin = findTwin(id);
  if (!twin) return null;
  const chain = successorChain(twin.predecessor);
  for (let index = chain.length - 1; index >= 0; index--) {
    for (const swap of twin.swaps) {
      const candidate = swap(chain[index]!);
      if (candidate !== id && listed.has(candidate)) return { fromModelId: id, toModelId: candidate };
    }
  }
  return null;
}

/**
 * The provider's next version of `modelId`, whatever this machine lists (the
 * picker's "Previous version"), or null for the newest of its line.
 */
export function newerVersionOf(modelId: string): ModelDescriptor | null {
  const id = modelId.trim();
  if (!id) return null;
  const row = curatedRow(id);
  const predecessor = row ?? findTwin(id)?.predecessor ?? null;
  return predecessor ? successorChain(predecessor)[0] ?? null : null;
}
