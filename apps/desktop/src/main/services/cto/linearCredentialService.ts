import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { safeStorage } from "electron";
import type { Logger } from "../logging/logger";
import { isRecord, getErrorMessage } from "../shared/utils";

const TOKEN_FILE = "linear-token.v1.bin";
const IMPORT_SENTINEL = "linear-token.imported.v1";

type LinearCredentialServiceArgs = {
  adeDir: string;
  logger?: Logger | null;
};

function extractLegacyToken(raw: string): string | null {
  try {
    const parsed = YAML.parse(raw);
    if (!isRecord(parsed)) return null;
    const linear = isRecord(parsed.linear) ? parsed.linear : null;
    if (!linear) return null;
    let token = "";
    if (typeof linear.token === "string") {
      token = linear.token.trim();
    } else if (typeof linear.apiKey === "string") {
      token = linear.apiKey.trim();
    }
    return token.length ? token : null;
  } catch {
    return null;
  }
}

export function createLinearCredentialService(args: LinearCredentialServiceArgs) {
  const secretsDir = path.join(args.adeDir, "secrets");
  const tokenPath = path.join(secretsDir, TOKEN_FILE);
  const importSentinelPath = path.join(secretsDir, IMPORT_SENTINEL);

  const readEncryptedToken = (): string | null => {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        args.logger?.warn("linear_sync.token_store_unavailable", {
          message: "OS secure storage unavailable; cannot decrypt Linear token."
        });
        return null;
      }
      const encrypted = fs.readFileSync(tokenPath);
      const decrypted = safeStorage.decryptString(encrypted);
      const parsed = JSON.parse(decrypted) as { token?: unknown };
      const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
      return token.length ? token : null;
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      args.logger?.warn("linear_sync.token_store_read_failed", {
        error: getErrorMessage(error)
      });
      return null;
    }
  };

  const persistToken = (token: string | null): void => {
    const clean = (token ?? "").trim();
    if (!clean.length) {
      try {
        fs.unlinkSync(tokenPath);
      } catch {
        // best effort — file may not exist
      }
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable. Cannot store Linear token.");
    }

    fs.mkdirSync(secretsDir, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify({ token: clean }));
    fs.writeFileSync(tokenPath, encrypted);
    try {
      fs.chmodSync(tokenPath, 0o600);
    } catch {
      // best effort
    }
  };

  let legacyImportDone = false;

  const importLegacyTokenIfNeeded = (): void => {
    if (legacyImportDone) return;
    legacyImportDone = true;
    const legacyPath = path.join(args.adeDir, "local.secret.yaml");
    try {
      // If token already exists or import sentinel is present, skip
      fs.accessSync(tokenPath);
      return;
    } catch {
      // token file doesn't exist — continue
    }
    try {
      fs.accessSync(importSentinelPath);
      return;
    } catch {
      // sentinel doesn't exist — continue
    }
    try {
      const raw = fs.readFileSync(legacyPath, "utf8");
      const token = extractLegacyToken(raw);
      if (!token) {
        fs.mkdirSync(secretsDir, { recursive: true });
        fs.writeFileSync(importSentinelPath, "no_token", "utf8");
        return;
      }
      persistToken(token);
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.writeFileSync(importSentinelPath, "imported", "utf8");
      args.logger?.info("linear_sync.token_imported_legacy", { legacyPath });
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      args.logger?.warn("linear_sync.token_import_failed", {
        legacyPath,
        error: getErrorMessage(error)
      });
    }
  };

  let cachedToken: string | null | undefined;

  const getToken = (): string | null => {
    if (cachedToken !== undefined) return cachedToken;
    importLegacyTokenIfNeeded();
    cachedToken = readEncryptedToken();
    return cachedToken;
  };

  const invalidateCache = (): void => {
    cachedToken = undefined;
  };

  return {
    getToken,

    getTokenOrThrow(): string {
      const token = getToken();
      if (!token) throw new Error("Linear token missing. Set it in CTO > Linear Sync.");
      return token;
    },

    setToken(token: string): void {
      persistToken(token);
      invalidateCache();
    },

    clearToken(): void {
      persistToken(null);
      invalidateCache();
    },

    getStatus(): { tokenStored: boolean } {
      return { tokenStored: getToken() != null };
    }
  };
}

export type LinearCredentialService = ReturnType<typeof createLinearCredentialService>;
