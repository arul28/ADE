/**
 * Live detail for one account-directory machine.
 *
 * The directory summary is the durable floor. This reader only asks a machine
 * that is already online and already connected in the paired pool; expanding a
 * row never creates a pairing or spends a reconnect attempt.
 */

import type {
  AdeAccountMachine,
  AdeAccountMachinesResult,
  MachineInventoryModelCounts,
  MachineInventoryPresetInput,
  MachineInventoryProviderInput,
  MachineInventoryDetail,
} from "../../../shared/types";
import { normalizeHarnessPresetList } from "../../../shared/harnessPresets";
import { buildMachineInventoryDetail } from "../../../shared/types/machineInventory";
import type { ProviderInstance } from "../../../shared/types/providerInstances";
import type { ProviderInstanceStore } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import { getErrorMessage } from "../shared/utils";

export const MACHINE_INVENTORY_MAX_LIVE_MACHINES = 12;
export const MACHINE_INVENTORY_RATE_FLOOR_MS = 30_000;
const MACHINE_INVENTORY_TIMEOUT_MS = 8_000;
const MAX_DETAIL_PROVIDERS = 32;
const MAX_DETAIL_ACCOUNTS = 128;
const MAX_DETAIL_PRESETS = 256;
const MAX_TEXT_LENGTH = 256;

const UNKNOWN_METHOD_MESSAGE = /method not found:|unsupported remote command:/i;
const AUTHORIZATION_DENIAL_MESSAGE = /requires elevated role|requires an authenticated owner scope|not authorized for this caller|not owned by this caller|requires .*(?:permission|scope)|permission denied|not permitted|access denied|unauthorized/i;

/**
 * Build the local-machine detail from the two read-only runtime actions that
 * already own these sources. The account page's IPC fallback can therefore
 * use the brain's account settings and AI catalog without inventing a second
 * store or exposing provider configuration.
 */
export async function readLocalMachineInventoryDetail(args: {
  machineKey: string;
  providerInstanceStore: Pick<ProviderInstanceStore, "list" | "get">
    & Partial<Pick<ProviderInstanceStore, "getPresetBindings" | "hasPresetBinding">>;
  readPresetValue: () => Promise<unknown>;
  readModelCounts: () => Promise<MachineInventoryModelCounts>;
}): Promise<MachineInventoryDetail> {
  const [rawPresetValue, modelCounts] = await Promise.all([
    args.readPresetValue().catch(() => undefined),
    args.readModelCounts().catch(() => ({})),
  ]);
  const normalizedPresets = normalizeHarnessPresetList(rawPresetValue);
  const providerInstances: MachineInventoryProviderInput[] = args.providerInstanceStore
    .list()
    .map((instance: ProviderInstance) => ({
      id: instance.id,
      provider: instance.provider,
      label: instance.label,
      isDefault: instance.isDefault,
      ...(instance.account?.email || instance.account?.plan
        ? {
          account: {
            ...(instance.account.email ? { email: instance.account.email } : {}),
            ...(instance.account.plan ? { plan: instance.account.plan } : {}),
          },
        }
        : {}),
    }));
  const presets: MachineInventoryPresetInput[] = normalizedPresets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    harness: preset.harness,
    model: preset.model,
  }));
  const boundPresetIds = new Set(args.providerInstanceStore.getPresetBindings?.() ?? []);
  for (const preset of normalizedPresets) {
    if (args.providerInstanceStore.hasPresetBinding?.(preset.id)) {
      boundPresetIds.add(preset.id);
      continue;
    }
    if (preset.source.kind === "account" && args.providerInstanceStore.get(preset.source.instanceId)) {
      boundPresetIds.add(preset.id);
    }
  }
  return buildMachineInventoryDetail({
    machineKey: args.machineKey,
    providerInstances,
    modelCounts,
    presets,
    boundPresetIds,
  });
}

/** Keep this discriminator in lockstep with accountUsageLiveRefresh.ts. */
function isMethodNotFound(error: unknown): boolean {
  if (!error) return false;
  const message = getErrorMessage(error);
  if (AUTHORIZATION_DENIAL_MESSAGE.test(message)) return false;
  return UNKNOWN_METHOD_MESSAGE.test(message);
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = Math.max(250, Math.floor(timeoutMs));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out")), timeout);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function boundedText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_TEXT_LENGTH) : "";
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function sanitizeDetail(value: unknown, machineKey: string): MachineInventoryDetail {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const providers = Array.isArray(record.providers)
    ? record.providers.slice(0, MAX_DETAIL_PROVIDERS).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const raw = entry as Record<string, unknown>;
      const provider = boundedText(raw.provider);
      if (!provider) return [];
      const accounts = Array.isArray(raw.accounts)
        ? raw.accounts.slice(0, MAX_DETAIL_ACCOUNTS).flatMap((account) => {
          if (!account || typeof account !== "object" || Array.isArray(account)) return [];
          const row = account as Record<string, unknown>;
          const instanceId = boundedText(row.instanceId);
          if (!instanceId) return [];
          const label = boundedText(row.label) || "Unnamed account";
          const email = boundedText(row.email);
          const plan = boundedText(row.plan);
          return [{
            instanceId,
            label,
            ...(email ? { email } : {}),
            ...(plan ? { plan } : {}),
            isDefault: row.isDefault === true,
          }];
        })
        : [];
      return [{ provider, accounts, modelCount: boundedCount(raw.modelCount) }];
    })
    : [];
  const presets = Array.isArray(record.presets)
    ? record.presets.slice(0, MAX_DETAIL_PRESETS).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const raw = entry as Record<string, unknown>;
      const id = boundedText(raw.id);
      const name = boundedText(raw.name);
      const harness = boundedText(raw.harness);
      const model = boundedText(raw.model);
      if (!id || !name || !harness || !model) return [];
      return [{ id, name, harness, model, bound: raw.bound === true }];
    })
    : [];
  return { machineKey, providers, presets };
}

function machineLabel(machine: AdeAccountMachine): string {
  return machine.customName?.trim() || machine.name?.trim() || machine.machineKey;
}

type InventoryFailure = { attemptedAt: number; message: string };

export type AccountMachineInventoryFetcher = (
  machineKey: string,
  options?: { timeoutMs?: number },
) => Promise<MachineInventoryDetail>;

export function createAccountMachineInventoryFetcher({
  listMachines,
  resolveTargetIdForMachineKey,
  isTargetConnected,
  callMachineMethod,
  callLocalMachineMethod,
  localMachineKey,
  now = Date.now,
  logger,
}: {
  listMachines: () => Promise<AdeAccountMachinesResult>;
  resolveTargetIdForMachineKey: (machineKey: string) => string | null;
  isTargetConnected?: (targetId: string) => boolean;
  callMachineMethod: <T>(
    targetId: string,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
  callLocalMachineMethod?: (machineKey: string, options?: { timeoutMs?: number }) => Promise<unknown>;
  localMachineKey: () => string;
  now?: () => number;
  logger?: {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
}): AccountMachineInventoryFetcher {
  const cached = new Map<string, { attemptedAt: number; detail: MachineInventoryDetail }>();
  const failures = new Map<string, InventoryFailure>();
  const inFlight = new Set<string>();

  return async (rawMachineKey, options = {}): Promise<MachineInventoryDetail> => {
    const machineKey = boundedText(rawMachineKey);
    if (!machineKey) throw new Error("A machine identity is required.");
    const timeoutMs = options.timeoutMs ?? MACHINE_INVENTORY_TIMEOUT_MS;
    const currentTime = now();
    const prior = cached.get(machineKey);
    if (prior && currentTime - prior.attemptedAt < MACHINE_INVENTORY_RATE_FLOOR_MS) {
      return prior.detail;
    }
    const priorFailure = failures.get(machineKey);
    if (priorFailure && currentTime - priorFailure.attemptedAt < MACHINE_INVENTORY_RATE_FLOOR_MS) {
      throw new Error(priorFailure.message);
    }
    if (inFlight.size >= MACHINE_INVENTORY_MAX_LIVE_MACHINES && !inFlight.has(machineKey)) {
      throw new Error("Too many machine inventory reads are already in progress.");
    }

    inFlight.add(machineKey);
    const attemptedAt = currentTime;
    let label = machineKey;
    try {
      const listed = await withDeadline(listMachines(), timeoutMs);
      if (listed.state !== "ok") throw new Error("Details unavailable right now.");
      const machine = listed.machines.find((entry) => entry.machineKey === machineKey);
      if (!machine) throw new Error("That computer is no longer on your account.");
      label = machineLabel(machine);
      if (!machine.online) throw new Error("Details unavailable while offline.");

      let detail: unknown;
      if (machineKey === boundedText(localMachineKey())) {
        if (!callLocalMachineMethod) throw new Error("Details unavailable right now.");
        detail = await withDeadline(callLocalMachineMethod(machineKey, { timeoutMs }), timeoutMs);
      } else {
        const targetId = resolveTargetIdForMachineKey(machineKey);
        if (!targetId || (isTargetConnected && !isTargetConnected(targetId))) {
          throw new Error("Details unavailable while this computer is disconnected.");
        }
        detail = await withDeadline(
          callMachineMethod<unknown>(targetId, "account.getMachineInventory", { machineKey }, { timeoutMs }),
          timeoutMs,
        );
      }
      const safe = sanitizeDetail(detail, machineKey);
      cached.set(machineKey, { attemptedAt, detail: safe });
      failures.delete(machineKey);
      return safe;
    } catch (error) {
      const message = isMethodNotFound(error)
        ? "This computer's ADE is too old to share provider inventory."
        : error instanceof Error && error.message
          ? error.message
          : "Details unavailable right now.";
      failures.set(machineKey, { attemptedAt, message });
      logger?.debug?.("account.machine_inventory_refresh_failed", {
        machineKey,
        label,
        error: getErrorMessage(error),
      });
      throw new Error(message);
    } finally {
      inFlight.delete(machineKey);
    }
  };
}
