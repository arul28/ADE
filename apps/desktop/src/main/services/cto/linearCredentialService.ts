import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { safeStorage } from "electron";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";

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
    const token = typeof linear.token === "string"
      ? linear.token.trim()
      : typeof linear.apiKey === "string"
        ? linear.apiKey.trim()
        : "";
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
    if (!fs.existsSync(tokenPath)) return null;
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
    } catch (error) {
      args.logger?.warn("linear_sync.token_store_read_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const persistToken = (token: string | null): void => {
    const clean = (token ?? "").trim();
    if (!clean.length) {
      if (fs.existsSync(tokenPath)) {
        try {
          fs.unlinkSync(tokenPath);
        } catch {
          // best effort
        }
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

  const importLegacyTokenIfNeeded = (): void => {
    if (fs.existsSync(tokenPath) || fs.existsSync(importSentinelPath)) return;
    const legacyPath = path.join(args.adeDir, "local.secret.yaml");
    if (!fs.existsSync(legacyPath)) return;
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
    } catch (error) {
      args.logger?.warn("linear_sync.token_import_failed", {
        legacyPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const getToken = (): string | null => {
    importLegacyTokenIfNeeded();
    return readEncryptedToken();
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
    },

    clearToken(): void {
      persistToken(null);
    },

    getStatus(): { tokenStored: boolean } {
      return { tokenStored: getToken() != null };
    }
  };
}

export type LinearCredentialService = ReturnType<typeof createLinearCredentialService>;
