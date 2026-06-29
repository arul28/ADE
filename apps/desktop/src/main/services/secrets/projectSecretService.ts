import fs from "node:fs";
import path from "node:path";
import { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type {
  ProjectSecretDeleteArgs,
  ProjectSecretGetArgs,
  ProjectSecretsListResult,
  ProjectSecretSetArgs,
  ProjectSecretSummary,
  ProjectSecretValueResult,
} from "../../../shared/types/projectSecrets";
import { nowIso } from "../shared/utils";

type ProjectSecretIndexEntry = {
  createdAt: string;
  updatedAt: string;
  valueLength: number;
};

type ProjectSecretIndex = {
  version: 1;
  entries: Record<string, ProjectSecretIndexEntry>;
};

const STORE_FILE = "project-secrets.v1.enc";
const KEY_FILE = ".project-secrets-key";
const INDEX_KEY = "__ade_project_secrets_index_v1";
const VALUE_PREFIX = "secret:";
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function normalizeSecretName(name: string | undefined | null): string {
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized) throw new Error("Secret name is required.");
  if (!NAME_PATTERN.test(normalized)) {
    throw new Error("Secret names must start with a letter and contain only letters, numbers, '.', '_', or '-' (max 128 characters).");
  }
  return normalized;
}

function parseIndex(raw: string | null): ProjectSecretIndex {
  if (!raw) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: 1, entries: {} };
    const record = parsed as Record<string, unknown>;
    const entries = record.entries;
    if (record.version !== 1 || !entries || typeof entries !== "object" || Array.isArray(entries)) {
      return { version: 1, entries: {} };
    }
    const normalizedEntries: Record<string, ProjectSecretIndexEntry> = {};
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (!NAME_PATTERN.test(name) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const candidate = entry as Record<string, unknown>;
      const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : nowIso();
      const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : createdAt;
      const valueLength = Number.isSafeInteger(candidate.valueLength) && Number(candidate.valueLength) >= 0
        ? Number(candidate.valueLength)
        : 0;
      normalizedEntries[name] = { createdAt, updatedAt, valueLength };
    }
    return { version: 1, entries: normalizedEntries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function serializeIndex(index: ProjectSecretIndex): string {
  return JSON.stringify(index);
}

function valueKey(name: string): string {
  return `${VALUE_PREFIX}${name}`;
}

function toSummary(name: string, entry: ProjectSecretIndexEntry): ProjectSecretSummary {
  return {
    name,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    valueLength: entry.valueLength,
  };
}

function sortSummaries(entries: Record<string, ProjectSecretIndexEntry>): ProjectSecretSummary[] {
  return Object.entries(entries)
    .map(([name, entry]) => toSummary(name, entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createProjectSecretService(projectRoot: string) {
  const layout = resolveAdeLayout(projectRoot);
  const credentialsPath = path.join(layout.secretsDir, STORE_FILE);
  const store = new EncryptedFileCredentialStore({
    credentialsPath,
    machineKeyPath: path.join(layout.secretsDir, KEY_FILE),
    lockPath: `${credentialsPath}.lock`,
  });

  const readIndex = (): ProjectSecretIndex => {
    if (!fs.existsSync(credentialsPath)) return { version: 1, entries: {} };
    return parseIndex(store.getSync(INDEX_KEY));
  };

  return {
    list(): ProjectSecretsListResult {
      return {
        secrets: sortSummaries(readIndex().entries),
        storage: {
          path: credentialsPath,
          encrypted: true,
          scope: "project",
        },
      };
    },

    get(args: ProjectSecretGetArgs): ProjectSecretValueResult {
      const name = normalizeSecretName(args?.name);
      const index = readIndex();
      const entry = index.entries[name];
      if (!entry) {
        throw new Error(`ADE secret '${name}' was not found.`);
      }
      const value = store.getSync(valueKey(name));
      if (value == null) {
        throw new Error(`ADE secret '${name}' was not found.`);
      }
      return {
        ...toSummary(name, entry),
        value,
      };
    },

    set(args: ProjectSecretSetArgs): ProjectSecretSummary {
      const name = normalizeSecretName(args?.name);
      const nextValue = typeof args?.value === "string" ? args.value : "";
      if (!nextValue.length) throw new Error("Secret value is required.");
      const now = nowIso();
      let entry: ProjectSecretIndexEntry | null = null;
      store.updateSync((values) => {
        const index = parseIndex(values[INDEX_KEY] ?? null);
        const previous = index.entries[name];
        entry = {
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          valueLength: nextValue.length,
        };
        values[valueKey(name)] = nextValue;
        index.entries[name] = entry;
        values[INDEX_KEY] = serializeIndex(index);
      });
      if (!entry) throw new Error("Failed to save ADE secret.");
      return toSummary(name, entry);
    },

    delete(args: ProjectSecretDeleteArgs): { deleted: boolean; name: string } {
      const name = normalizeSecretName(args?.name);
      const confirmName = typeof args?.confirmName === "string" ? args.confirmName.trim() : "";
      if (!confirmName) {
        throw new Error(`Deleting ADE secret '${name}' requires confirmName to match the secret name.`);
      }
      const normalizedConfirmName = normalizeSecretName(confirmName);
      if (normalizedConfirmName !== name) {
        throw new Error(`Deleting ADE secret '${name}' requires confirmName to match the secret name.`);
      }
      if (!fs.existsSync(credentialsPath)) {
        return { deleted: false, name };
      }
      let deleted = false;
      store.updateSync((values) => {
        const nextIndex = parseIndex(values[INDEX_KEY] ?? null);
        const key = valueKey(name);
        const hadEntry = Boolean(nextIndex.entries[name]);
        const hadValue = values[key] != null;
        deleted = hadEntry || hadValue;
        if (!deleted) return false;
        delete values[key];
        if (hadEntry) {
          delete nextIndex.entries[name];
          values[INDEX_KEY] = serializeIndex(nextIndex);
        }
      });
      return { deleted, name };
    },
  };
}

export type ProjectSecretService = ReturnType<typeof createProjectSecretService>;
