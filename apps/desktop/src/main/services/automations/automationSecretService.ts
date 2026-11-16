import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Logger } from "../logging/logger";
import { isRecord, nowIso } from "../shared/utils";
import { createFileVersionTracker } from "../state/durableFile";

type AutomationSecretServiceArgs = {
  adeDir: string;
  logger?: Logger | null;
};

type SecretSnapshot = {
  loadedAt: string | null;
  path: string;
  exists: boolean;
  error: string | null;
};

const ENV_TOKEN = /\$\{env:([A-Z0-9_]+)\}/g;

function resolveEnvTokens(value: string): string {
  return value.replace(ENV_TOKEN, (_full, envName: string) => {
    const resolved = process.env[envName];
    if (typeof resolved !== "string" || !resolved.length) {
      throw new Error(`Missing required environment variable '${envName}'.`);
    }
    return resolved;
  });
}

function readPathValue(root: unknown, ref: string): unknown {
  const parts = ref
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function createAutomationSecretService(args: AutomationSecretServiceArgs) {
  const secretPath = path.join(args.adeDir, "local.secret.yaml");
  let cachedDoc: unknown = null;
  let loadedAt: string | null = null;
  let lastError: string | null = null;
  // An editor can save twice in one timestamp tick with the same size.
  const fileVersion = createFileVersionTracker(secretPath);

  const ensureLoaded = (): void => {
    // A file that failed to load is read again on every call.
    if (cachedDoc !== null && lastError === null && !fileVersion.changed()) return;
    try {
      const raw = fileVersion.read();
      cachedDoc = YAML.parse(raw) ?? {};
      loadedAt = nowIso();
      lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        cachedDoc = {};
        loadedAt = null;
        lastError = null;
        return;
      }
      args.logger?.warn("automations.secret_load_failed", { error: message, path: secretPath });
      cachedDoc = {};
      loadedAt = null;
      lastError = message;
    }
  };

  return {
    getSnapshot(): SecretSnapshot {
      ensureLoaded();
      return {
        loadedAt,
        path: secretPath,
        exists: fs.existsSync(secretPath),
        error: lastError,
      };
    },

    getSecret(ref: string): string | null {
      const key = ref.trim();
      if (!key.length) return null;
      ensureLoaded();
      const raw = readPathValue(cachedDoc, key);
      if (typeof raw !== "string") return null;
      const trimmed = raw.trim();
      if (!trimmed.length) return null;
      return resolveEnvTokens(trimmed);
    },

    reload(): SecretSnapshot {
      cachedDoc = null;
      ensureLoaded();
      return this.getSnapshot();
    },
  };
}

export type AutomationSecretService = ReturnType<typeof createAutomationSecretService>;
