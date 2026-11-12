import fs from "node:fs";
import path from "node:path";
import YAML, { isMap, isScalar, type Document } from "yaml";
import type { PlaintextApiKeyOutcome } from "../ai/apiKeyStore";
import { writeFileAtomic } from "../state/durableFile";

/**
 * Provider API keys out of `.ade/local.yaml` (slice Y1 of the account
 * project plan).
 *
 * `ai.apiKeys` holds provider keys in plain text, and the dead top-level
 * `providers` block once held the same. Each key moves to this machine's API
 * key store (and from there to the account vault, `adoptPlaintextApiKey`).
 * A key leaves the file only after the store holds that exact value, and the
 * rest of the file stays as it was, comments included.
 *
 * A key stays in the file, and is logged by provider name only, when:
 * - the store's default key for that provider holds a different value. The
 *   file's key is the one this project uses today, so moving it would change
 *   which key the project spends;
 * - the store cannot be written or read back;
 * - the file is read-only, or cannot be replaced.
 *
 * Nothing here logs or returns a key value.
 */

export type PlaintextApiKeyAdopter = (provider: string, key: string) => PlaintextApiKeyOutcome;

/**
 * Whether a `providers.<id>` entry may hold a key for the store. The block is
 * an unvalidated passthrough, so only a provider the store knows by name
 * moves; anything else stays where it is.
 */
export type KnownProviderCheck = (provider: string) => boolean;

export type LocalYamlApiKeyMove = {
  /** Provider names found in the file, by block. */
  found: { apiKeys: string[]; providers: string[] };
  /** Provider names whose key left the file. */
  moved: string[];
  /** Provider names whose key stayed, with the reason. */
  kept: Array<{ provider: string; reason: PlaintextApiKeyOutcome | "read_only" | "write_failed" | "changed_during_move" }>;
  /** Names in `providers` that hold no recognizable key; left as they are. */
  untouchedProviderEntries: string[];
};

type Logger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

type Candidate = {
  block: "apiKeys" | "providers";
  provider: string;
  /** Path of the scalar holding the key inside the document. */
  path: Array<string>;
  value: string;
};

const KEY_FIELDS_IN_PROVIDER_ENTRY = ["apiKey", "api_key", "key"] as const;

function emptyMove(): LocalYamlApiKeyMove {
  return { found: { apiKeys: [], providers: [] }, moved: [], kept: [], untouchedProviderEntries: [] };
}

function scalarString(node: unknown): string | null {
  if (!isScalar(node) || typeof node.value !== "string") return null;
  const value = node.value.trim();
  return value.length ? value : null;
}

/** A string shaped like an API key: no whitespace, at least 8 characters. */
function looksLikeKey(value: string): boolean {
  return value.length >= 8 && !/\s/.test(value);
}

function collectCandidates(doc: Document, move: LocalYamlApiKeyMove, isKnownProvider: KnownProviderCheck): Candidate[] {
  const candidates: Candidate[] = [];
  const apiKeys = doc.getIn(["ai", "apiKeys"], true);
  if (isMap(apiKeys)) {
    for (const pair of apiKeys.items) {
      const provider = scalarString(pair.key);
      if (!provider) continue;
      move.found.apiKeys.push(provider);
      const value = scalarString(pair.value);
      if (value) candidates.push({ block: "apiKeys", provider, path: ["ai", "apiKeys", provider], value });
    }
  }
  const providers = doc.get("providers", true);
  if (isMap(providers)) {
    for (const pair of providers.items) {
      const provider = scalarString(pair.key);
      if (!provider) continue;
      move.found.providers.push(provider);
      if (!isKnownProvider(provider)) {
        move.untouchedProviderEntries.push(provider);
        continue;
      }
      const direct = scalarString(pair.value);
      if (direct && looksLikeKey(direct)) {
        candidates.push({ block: "providers", provider, path: ["providers", provider], value: direct });
        continue;
      }
      const entry = pair.value;
      let matched = false;
      if (isMap(entry)) {
        for (const field of KEY_FIELDS_IN_PROVIDER_ENTRY) {
          const value = scalarString(entry.get(field, true));
          if (!value || !looksLikeKey(value)) continue;
          candidates.push({ block: "providers", provider, path: ["providers", provider, field], value });
          matched = true;
          break;
        }
      }
      if (!matched) move.untouchedProviderEntries.push(provider);
    }
  }
  return candidates;
}

/** Removes `path`, then each parent map the removal left empty. */
function removeWithEmptyParents(doc: Document, keyPath: string[]): void {
  doc.deleteIn(keyPath);
  for (let depth = keyPath.length - 1; depth >= 1; depth -= 1) {
    const parentPath = keyPath.slice(0, depth);
    const parent = doc.getIn(parentPath, true);
    if (isMap(parent) && parent.items.length === 0) doc.deleteIn(parentPath);
    else break;
  }
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function isWritable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move the plain-text provider keys of one `local.yaml` into the key store.
 * Synchronous and quick: it runs once per file at runtime start.
 */
export function moveLocalYamlApiKeys(args: {
  localPath: string;
  adopt: PlaintextApiKeyAdopter;
  isKnownProvider: KnownProviderCheck;
  logger?: Logger;
}): LocalYamlApiKeyMove {
  const move = emptyMove();
  const text = readText(args.localPath);
  if (text === null || (!text.includes("apiKeys") && !text.includes("providers"))) return move;
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    args.logger?.warn("projectConfig.api_keys_move_skipped", { localPath: args.localPath, reason: "unparsable" });
    return move;
  }
  const candidates = collectCandidates(doc, move, args.isKnownProvider);
  if (candidates.length === 0) {
    if (move.found.providers.length > 0) {
      args.logger?.info("projectConfig.providers_block_found", { localPath: args.localPath, providers: move.found.providers });
    }
    return move;
  }

  const removable: Candidate[] = [];
  for (const candidate of candidates) {
    const outcome = args.adopt(candidate.provider, candidate.value);
    if (outcome === "stored" || outcome === "already_stored") removable.push(candidate);
    else move.kept.push({ provider: candidate.provider, reason: outcome });
  }

  const keepAll = (reason: LocalYamlApiKeyMove["kept"][number]["reason"]) => {
    for (const candidate of removable) move.kept.push({ provider: candidate.provider, reason });
  };
  if (removable.length > 0) {
    if (!isWritable(args.localPath)) {
      keepAll("read_only");
    } else if (readText(args.localPath) !== text) {
      // Someone saved the file while the keys were being stored. The keys are
      // in the store now; the next start removes them from the new content.
      keepAll("changed_during_move");
    } else {
      for (const candidate of removable) removeWithEmptyParents(doc, candidate.path);
      try {
        // Keep the file's line endings (a file edited on Windows uses CRLF).
        const body = text.includes("\r\n") ? doc.toString().replace(/\r?\n/g, "\r\n") : doc.toString();
        writeFileAtomic(args.localPath, body, { mode: 0o600, fsync: true });
        const after = YAML.parseDocument(readText(args.localPath) ?? "");
        const left = removable.filter((candidate) => after.getIn(candidate.path) !== undefined);
        if (left.length > 0) {
          for (const candidate of left) move.kept.push({ provider: candidate.provider, reason: "write_failed" });
        }
        move.moved = removable.filter((candidate) => !left.includes(candidate)).map((candidate) => candidate.provider);
      } catch (error) {
        args.logger?.warn("projectConfig.api_keys_move_write_failed", {
          localPath: args.localPath,
          code: (error as NodeJS.ErrnoException)?.code ?? null,
        });
        keepAll("write_failed");
      }
    }
  }

  const meta = {
    localPath: args.localPath,
    moved: move.moved,
    kept: move.kept,
    ...(move.untouchedProviderEntries.length ? { untouchedProviderEntries: move.untouchedProviderEntries } : {}),
  };
  if (move.kept.length > 0) args.logger?.warn("projectConfig.api_keys_kept_in_file", meta);
  else args.logger?.info("projectConfig.api_keys_moved", meta);
  return move;
}

/**
 * The project's own file, then the copy in each lane worktree (a lane created
 * with `.ade/local.yaml` in its copy paths, or a worktree opened as a project,
 * has one). Paths are compared after resolving, so the project root's own file
 * is moved once.
 */
export function moveLocalYamlApiKeysForProject(args: {
  projectRoot: string;
  worktreePaths: readonly string[];
  adopt: PlaintextApiKeyAdopter;
  isKnownProvider: KnownProviderCheck;
  logger?: Logger;
}): void {
  const seen = new Set<string>();
  for (const root of [args.projectRoot, ...args.worktreePaths]) {
    if (!root) continue;
    const localPath = path.resolve(root, ".ade", "local.yaml");
    const key = process.platform === "win32" ? localPath.toLowerCase() : localPath;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      moveLocalYamlApiKeys({ localPath, adopt: args.adopt, isKnownProvider: args.isKnownProvider, logger: args.logger });
    } catch (error) {
      args.logger?.warn("projectConfig.api_keys_move_failed", {
        localPath,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
