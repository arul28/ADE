import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import { DEFAULT_ADE_TUNNEL_RELAY_URL } from "../../../../desktop/src/shared/accountDirectory";

const DEFAULT_RELAY_URL = DEFAULT_ADE_TUNNEL_RELAY_URL;

export type SyncCloudRelayConfig = {
  /** Per-machine identifier phones dial through the relay (32 hex chars). */
  machineKey: string;
  /** HMAC secret shared with the relay for signed host/pipe upgrades. */
  secret: string;
  /** Optional override for the relay base URL (http/https). */
  relayUrl?: string;
};

type SyncCloudRelayFile = Partial<SyncCloudRelayConfig> & {
  /** Deprecated kill-switch fields are accepted only so old files are cleaned up. */
  enabled?: unknown;
  enabledSetByUser?: unknown;
};

/** Default relay base URL: env override wins, else the deployed worker. */
export function defaultRelayUrl(): string {
  return process.env.ADE_TUNNEL_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
}

/** Swaps an http(s) base URL to its ws(s) equivalent, preserving host/path. */
export function httpToWsUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) return trimmed;
  // Bare host → assume TLS (the deployed worker is always https).
  return `wss://${trimmed}`;
}

/**
 * The phone-facing tunnel URL. This is the single value the QR / candidate
 * integration consumes: a phone that dials it reaches this machine's brain
 * through the relay, where the normal ADE sync hello/pairing runs end-to-end.
 */
export function deriveRelayWssConnectUrl(relayUrl: string, machineKey: string): string {
  return `${httpToWsUrl(relayUrl)}/connect/${machineKey}`;
}

/** Canonical signing strings — identical to the worker's (apps/tunnel-relay). */
export function buildHostSignatureBase(machineKey: string, timestamp: string): string {
  return `host:${machineKey}:${timestamp}`;
}

export function buildPipeSignatureBase(machineKey: string, id: string, timestamp: string): string {
  return `pipe:${machineKey}:${id}:${timestamp}`;
}

export function signRelayHmacHex(secret: string, base: string): string {
  return createHmac("sha256", secret).update(base).digest("hex");
}

export type SyncCloudRelayStore = ReturnType<typeof createSyncCloudRelayStore>;

/**
 * Persists the tunnel-relay identity next to the other sync secrets.
 * machineKey/secret are minted lazily on first read (matching the push-relay
 * store's randomBytes sizing) and the file is chmod 600.
 */
export function createSyncCloudRelayStore(args: { filePath: string }) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });

  const read = (): SyncCloudRelayFile => {
    if (!fs.existsSync(args.filePath)) return {};
    return safeJsonParse<SyncCloudRelayFile>(fs.readFileSync(args.filePath, "utf8"), {});
  };

  const write = (value: SyncCloudRelayConfig): void => {
    const fileValue: SyncCloudRelayFile = {
      machineKey: value.machineKey,
      secret: value.secret,
      ...(value.relayUrl ? { relayUrl: value.relayUrl } : {}),
    };
    // 0o600 at temp-file creation so the identity secret is never world-readable.
    writeTextAtomic(args.filePath, `${JSON.stringify(fileValue, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(args.filePath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  // First-run identity mint via exclusive create (O_EXCL). If a concurrent
  // process already minted the identity, adopt the winner's rather than
  // overwriting it with a divergent machineKey/secret pair.
  const mintExclusive = (config: SyncCloudRelayConfig): SyncCloudRelayConfig => {
    try {
      fs.writeFileSync(args.filePath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const raw = read();
        if (
          typeof raw.machineKey === "string" && /^[a-f0-9]{32,64}$/i.test(raw.machineKey)
          && typeof raw.secret === "string" && raw.secret.length >= 32
        ) {
          return {
            machineKey: raw.machineKey,
            secret: raw.secret,
            relayUrl: typeof raw.relayUrl === "string" && raw.relayUrl.trim() ? raw.relayUrl.trim() : undefined,
          };
        }
      }
      write(config);
      return config;
    }
  };

  // Reads the file and fills in a freshly generated identity when absent,
  // persisting it so the machineKey stays stable across restarts.
  const load = (): SyncCloudRelayConfig => {
    const raw = read();
    const machineKey = typeof raw.machineKey === "string" && /^[a-f0-9]{32,64}$/i.test(raw.machineKey)
      ? raw.machineKey
      : randomBytes(16).toString("hex");
    const secret = typeof raw.secret === "string" && raw.secret.length >= 32
      ? raw.secret
      : randomBytes(24).toString("hex");
    const config: SyncCloudRelayConfig = {
      machineKey,
      secret,
      relayUrl: typeof raw.relayUrl === "string" && raw.relayUrl.trim() ? raw.relayUrl.trim() : undefined,
    };
    const hasDeprecatedKillSwitchFields = Object.prototype.hasOwnProperty.call(raw, "enabled")
      || Object.prototype.hasOwnProperty.call(raw, "enabledSetByUser");
    if (raw.machineKey !== machineKey || raw.secret !== secret || hasDeprecatedKillSwitchFields) {
      // Absent file → race-safe first mint; existing-but-repaired → plain write.
      if (!fs.existsSync(args.filePath)) return mintExclusive(config);
      write(config);
    }
    return config;
  };

  return {
    getConfig(): SyncCloudRelayConfig {
      return load();
    },

    getMachineIdentity(): { machineKey: string; secret: string } {
      const { machineKey, secret } = load();
      return { machineKey, secret };
    },

    getRelayUrl(): string {
      return load().relayUrl ?? defaultRelayUrl();
    },

    setRelayUrl(relayUrl: string | null): SyncCloudRelayConfig {
      const next = { ...load(), relayUrl: relayUrl?.trim() || undefined };
      write(next);
      return next;
    },

    /** `wss://<host>/connect/<machineKey>` — the value the QR integration reads. */
    getRelayWssUrl(): string {
      const { relayUrl, machineKey } = load();
      return deriveRelayWssConnectUrl(relayUrl ?? defaultRelayUrl(), machineKey);
    },
  };
}
