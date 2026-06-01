import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MacosVmGlobalLease, MacosVmRecord } from "../../../shared/types";
import { isRecord } from "../shared/utils";

export type VmStoreFile = {
  version: 1;
  records: MacosVmRecord[];
};

export type VmGlobalLeaseFile = {
  version: 1;
  lease: MacosVmGlobalLease | null;
};

export type VncCredentialStoreFile = {
  version: 1;
  credentials: Record<string, {
    laneId: string;
    vmName: string;
    password: string;
    updatedAt: string;
  }>;
};

type VncCredential = VncCredentialStoreFile["credentials"][string];

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readStoreFile(storePath: string): VmStoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<VmStoreFile>;
    return {
      version: 1,
      records: Array.isArray(parsed.records)
        ? parsed.records.filter((record): record is MacosVmRecord => isRecord(record) && typeof record.id === "string")
        : [],
    };
  } catch {
    return { version: 1, records: [] };
  }
}

export function writeStoreFile(storePath: string, store: VmStoreFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, storePath);
}

export function parseGlobalLease(value: unknown): MacosVmGlobalLease | null {
  if (!isRecord(value)) return null;
  const projectRoot = asString(value.projectRoot);
  const laneId = asString(value.laneId);
  const vmId = asString(value.vmId);
  const vmName = asString(value.vmName);
  if (!projectRoot || !laneId || !vmId || !vmName) return null;
  return {
    projectRoot,
    laneId,
    laneName: asString(value.laneName) ?? laneId,
    vmId,
    vmName,
    updatedAt: asString(value.updatedAt) ?? nowIso(),
  };
}

export function readGlobalLeaseFile(storePath: string): VmGlobalLeaseFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<VmGlobalLeaseFile>;
    return { version: 1, lease: parseGlobalLease(parsed.lease) };
  } catch {
    return { version: 1, lease: null };
  }
}

export function writeGlobalLeaseFile(storePath: string, store: VmGlobalLeaseFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, storePath);
}

export function readVncCredentialStore(storePath: string): VncCredentialStoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<VncCredentialStoreFile>;
    const credentials: VncCredentialStoreFile["credentials"] = {};
    if (isRecord(parsed.credentials)) {
      for (const value of Object.values(parsed.credentials)) {
        const credential = parseVncCredential(value);
        if (!credential) continue;
        credentials[vncCredentialKey(credential.laneId, credential.vmName)] = credential;
      }
    }
    return {
      version: 1,
      credentials,
    };
  } catch {
    return { version: 1, credentials: {} };
  }
}

export function writeVncCredentialStore(storePath: string, store: VncCredentialStoreFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, storePath);
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    // Best effort. The file lives under .ade/secrets and is excluded from VM shares.
  }
}

export function vncCredentialKey(laneId: string, vmName: string): string {
  return JSON.stringify([laneId, vmName]);
}

export function generateVncPassword(): string {
  return randomBytes(6).toString("base64url").slice(0, 8);
}

function parseVncCredential(value: unknown): VncCredential | null {
  if (!isRecord(value)) return null;
  const laneId = asString(value.laneId);
  const vmName = asString(value.vmName);
  const password = asString(value.password);
  const updatedAt = asString(value.updatedAt);
  if (!laneId || !vmName || !password || !updatedAt) return null;
  return { laneId, vmName, password, updatedAt };
}
