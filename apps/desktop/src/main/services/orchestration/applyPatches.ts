import type { ManifestPatchOp, OrchestrationManifest } from "../../../shared/types/orchestration";

/**
 * Apply a list of RFC-6902 subset patches to a manifest. Returns a fresh
 * (deep-cloned) manifest. Throws on invalid paths. Arrays are addressed by
 * id-predicate segments -- `/tasks/{id:T-1}/...`.
 */
export function applyPatches(
  manifest: OrchestrationManifest,
  patches: readonly ManifestPatchOp[],
): OrchestrationManifest {
  const next = structuredClone(manifest) as OrchestrationManifest;
  for (const op of patches) {
    applyPatch(next, op);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Internal patch application
// ---------------------------------------------------------------------------

const PREDICATE_RE = /^\{([a-zA-Z][a-zA-Z0-9]*):([^}]+)\}$/;

function applyPatch(root: unknown, op: ManifestPatchOp): void {
  const segments = op.path
    .slice(1)
    .split("/")
    .filter((s) => s.length > 0);
  if (!segments.length) throw new Error("patch path empty");
  let parent: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    parent = navigate(parent, segments[i]!);
  }
  const last = segments[segments.length - 1]!;
  setOrRemove(parent, last, op);
}

function navigate(parent: unknown, segment: string): unknown {
  if (parent == null) throw new Error("cannot navigate into null/undefined");
  const match = PREDICATE_RE.exec(segment);
  if (match) {
    const [, field, value] = match;
    if (!Array.isArray(parent)) {
      throw new Error(`predicate segment {${field}:${value}} requires array parent`);
    }
    const found = (parent as Array<Record<string, unknown>>).find(
      (entry) => entry?.[field!] === value,
    );
    if (!found) throw new Error(`predicate ${field}=${value} matched no entry`);
    return found;
  }
  if (segment === "-") {
    throw new Error("'-' append segment only valid in trailing position");
  }
  if (Array.isArray(parent)) {
    throw new Error(`numeric/string index segments not allowed on arrays (got "${segment}")`);
  }
  const obj = parent as Record<string, unknown>;
  if (!(segment in obj)) {
    throw new Error(`path segment "${segment}" does not exist`);
  }
  return obj[segment];
}

function setOrRemove(parent: unknown, last: string, op: ManifestPatchOp): void {
  const match = PREDICATE_RE.exec(last);
  if (match) {
    const [, field, value] = match;
    if (!Array.isArray(parent)) {
      throw new Error(`predicate segment {${field}:${value}} requires array parent`);
    }
    const arr = parent as Array<Record<string, unknown>>;
    const idx = arr.findIndex((e) => e?.[field!] === value);
    if (op.op === "remove") {
      if (idx === -1) return;
      arr.splice(idx, 1);
      return;
    }
    if (idx === -1) {
      if (op.op === "add") {
        arr.push(op.value as Record<string, unknown>);
      } else {
        throw new Error(`predicate ${field}=${value} matched no entry to replace`);
      }
      return;
    }
    if (op.op === "add") {
      throw new Error(
        `add op against existing entry ${field}=${value} -- use replace instead`,
      );
    }
    arr[idx] = op.value as Record<string, unknown>;
    return;
  }
  if (last === "-") {
    if (!Array.isArray(parent)) {
      throw new Error("'-' append segment requires array parent");
    }
    if (op.op !== "add") {
      throw new Error("'-' append segment only valid with add");
    }
    (parent as unknown[]).push(op.value);
    return;
  }
  if (Array.isArray(parent)) {
    throw new Error(`literal segment "${last}" not allowed on array`);
  }
  const obj = parent as Record<string, unknown>;
  if (op.op === "remove") {
    delete obj[last];
    return;
  }
  obj[last] = op.value;
}
