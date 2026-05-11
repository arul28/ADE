import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { RemoteRuntimeTarget, RemoteRuntimeTargetInput } from "../../../shared/types/remoteRuntime";

type RegistryFile = {
  version: 1;
  targets: RemoteRuntimeTarget[];
};

function registryPath(): string {
  return path.join(resolveMachineAdeLayout().secretsDir, "remote-machines.json");
}

function normalizePort(port: number | null | undefined): number | null {
  if (!port || !Number.isFinite(port)) return null;
  return Math.max(1, Math.min(65_535, Math.floor(port)));
}

function defaultName(input: RemoteRuntimeTargetInput): string {
  return input.name?.trim() || input.hostname.trim();
}

function stableTargetId(input: RemoteRuntimeTargetInput): string {
  const sshUser = input.sshUser?.trim() ?? "";
  const port = normalizePort(input.port) ?? "";
  return createHash("sha256")
    .update(`${sshUser}@${input.hostname.trim()}:${port}`)
    .digest("hex")
    .slice(0, 24);
}

function coerceTarget(value: unknown): RemoteRuntimeTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hostname = typeof record.hostname === "string" ? record.hostname.trim() : "";
  const sshUser = typeof record.sshUser === "string" && record.sshUser.trim() ? record.sshUser.trim() : null;
  if (!hostname) return null;
  const fallbackInput: RemoteRuntimeTargetInput = { hostname, sshUser, port: normalizePort(typeof record.port === "number" ? record.port : null) };
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : stableTargetId(fallbackInput),
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : hostname,
    hostname,
    sshUser,
    port: normalizePort(typeof record.port === "number" ? record.port : null),
    sshKeyPath: typeof record.sshKeyPath === "string" && record.sshKeyPath.trim() ? record.sshKeyPath.trim() : null,
    lastSeenArch: typeof record.lastSeenArch === "string" && record.lastSeenArch.trim() ? record.lastSeenArch.trim() : null,
    runtimeBinaryVersion: typeof record.runtimeBinaryVersion === "string" && record.runtimeBinaryVersion.trim() ? record.runtimeBinaryVersion.trim() : null,
    lastConnectedAt: typeof record.lastConnectedAt === "number" && Number.isFinite(record.lastConnectedAt) ? record.lastConnectedAt : null,
  };
}

export class RemoteTargetRegistry {
  readonly path = registryPath();

  list(): RemoteRuntimeTarget[] {
    return this.read().targets;
  }

  get(id: string): RemoteRuntimeTarget | null {
    return this.list().find((target) => target.id === id) ?? null;
  }

  save(input: RemoteRuntimeTargetInput): RemoteRuntimeTarget {
    const hostname = input.hostname.trim();
    const sshUser = input.sshUser?.trim() || null;
    if (!hostname) throw new Error("Remote hostname is required.");
    const file = this.read();
    const id = stableTargetId(input);
    const existing = file.targets.find((target) => target.id === id) ?? null;
    const next: RemoteRuntimeTarget = {
      id,
      name: defaultName(input),
      hostname,
      sshUser,
      port: normalizePort(input.port),
      sshKeyPath: input.sshKeyPath?.trim() || null,
      lastSeenArch: existing?.lastSeenArch ?? null,
      runtimeBinaryVersion: existing?.runtimeBinaryVersion ?? null,
      lastConnectedAt: existing?.lastConnectedAt ?? null,
    };
    file.targets = [next, ...file.targets.filter((target) => target.id !== id)];
    this.write(file);
    return next;
  }

  update(id: string, patch: Partial<RemoteRuntimeTarget>): RemoteRuntimeTarget {
    const file = this.read();
    const index = file.targets.findIndex((target) => target.id === id);
    if (index < 0) throw new Error(`Unknown remote target: ${id}`);
    const next = { ...file.targets[index]!, ...patch, id };
    file.targets[index] = next;
    this.write(file);
    return next;
  }

  remove(id: string): boolean {
    const file = this.read();
    const nextTargets = file.targets.filter((target) => target.id !== id);
    if (nextTargets.length === file.targets.length) return false;
    this.write({ version: 1, targets: nextTargets });
    return true;
  }

  private read(): RegistryFile {
    try {
      const raw = fs.readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const targets = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as { targets?: unknown }).targets)
        ? (parsed as { targets: unknown[] }).targets.map(coerceTarget).filter((target): target is RemoteRuntimeTarget => target != null)
        : [];
      return { version: 1, targets };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, targets: [] };
      throw error;
    }
  }

  private write(file: RegistryFile): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.path);
  }
}
