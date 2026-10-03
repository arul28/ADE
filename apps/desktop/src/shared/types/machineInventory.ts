/**
 * The token-free provider inventory a machine can publish to the account
 * directory, plus the live detail returned by a paired runtime.
 *
 * Keep these shapes deliberately smaller than ProviderInstance and
 * HarnessPreset. In particular, config homes, credential references, and
 * provider launch details must never cross the machine boundary. A preset's
 * mark crosses only as its identity — the kind, the provider it names, and the
 * accent — never uploaded image bytes.
 */

export type MachineInventoryProviderSummary = {
  provider: string;
  accounts: number;
  models: number;
};

export type MachineInventorySummary = {
  providers: MachineInventoryProviderSummary[];
  presets: number;
};

export type MachineInventoryAccount = {
  instanceId: string;
  label: string;
  email?: string;
  plan?: string;
  isDefault: boolean;
};

export type MachineInventoryProviderDetail = {
  provider: string;
  accounts: MachineInventoryAccount[];
  modelCount: number;
};

/**
 * A preset's mark, as an identity rather than artwork. `provider` names the
 * brand mark to draw; `ade` is the built-in Custom mark; `upload` and
 * `generated` are a preset whose picture lives only on its own machine, which
 * a remote surface draws as the Custom mark in the preset's accent.
 */
export type MachineInventoryPresetLogo = {
  kind: "ade" | "provider" | "upload" | "generated";
  providerId?: string;
};

export type MachineInventoryPreset = {
  id: string;
  name: string;
  harness: string;
  model: string;
  logo: MachineInventoryPresetLogo;
  accentColor?: string;
  bound: boolean;
};

export type MachineInventoryDetail = {
  machineKey: string;
  providers: MachineInventoryProviderDetail[];
  presets: MachineInventoryPreset[];
};

/** The safe fields the brain reads from the machine-local instance store. */
export type MachineInventoryProviderInput = {
  id: string;
  provider: string;
  label: string;
  isDefault: boolean;
  account?: {
    email?: string;
    plan?: string;
  };
};

/** The safe fields the brain reads from account-scoped harness settings. */
export type MachineInventoryPresetInput = {
  id: string;
  name: string;
  harness: string;
  model: string;
  logo?: MachineInventoryPresetLogo;
  accentColor?: string;
};

export type MachineInventoryModelCounts = Readonly<Record<string, number>>;

function safeText(value: unknown, maxLength = 256): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeOptionalText(value: unknown, maxLength = 256): string | undefined {
  const text = safeText(value, maxLength);
  return text || undefined;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function normalizeProviderInput(value: MachineInventoryProviderInput): {
  id: string;
  provider: string;
  label: string;
  isDefault: boolean;
  email?: string;
  plan?: string;
} | null {
  const id = safeText(value.id);
  const provider = safeText(value.provider);
  if (!id || !provider) return null;
  return {
    id,
    provider,
    label: safeText(value.label) || "Unnamed account",
    isDefault: value.isDefault === true,
    ...(safeOptionalText(value.account?.email) ? { email: safeOptionalText(value.account?.email) } : {}),
    ...(safeOptionalText(value.account?.plan) ? { plan: safeOptionalText(value.account?.plan) } : {}),
  };
}

const MACHINE_INVENTORY_LOGO_KINDS = new Set(["ade", "provider", "upload", "generated"]);
/** `#rrggbb`, the one accent form the renderer draws. */
const MACHINE_INVENTORY_ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

function normalizePresetLogo(value: unknown): MachineInventoryPresetLogo {
  if (!value || typeof value !== "object") return { kind: "ade" };
  const candidate = value as Record<string, unknown>;
  const kind = typeof candidate.kind === "string" ? candidate.kind.trim().toLowerCase() : "";
  if (!MACHINE_INVENTORY_LOGO_KINDS.has(kind)) return { kind: "ade" };
  if (kind === "provider") {
    const providerId = safeOptionalText(candidate.providerId);
    return providerId ? { kind: "provider", providerId } : { kind: "ade" };
  }
  return { kind: kind as MachineInventoryPresetLogo["kind"] };
}

function normalizePresetInput(value: MachineInventoryPresetInput): Omit<MachineInventoryPreset, "bound"> | null {
  const id = safeText(value.id);
  const name = safeText(value.name);
  const harness = safeText(value.harness);
  const model = safeText(value.model);
  if (!id || !name || !harness || !model) return null;
  const accent = safeText(value.accentColor, 16);
  return {
    id,
    name,
    harness,
    model,
    logo: normalizePresetLogo(value.logo),
    ...(MACHINE_INVENTORY_ACCENT_PATTERN.test(accent) ? { accentColor: accent } : {}),
  };
}

function normalizedPresets(
  presets: readonly MachineInventoryPresetInput[],
): Array<Omit<MachineInventoryPreset, "bound">> {
  return presets.flatMap((preset) => {
    const normalized = normalizePresetInput(preset);
    return normalized ? [normalized] : [];
  });
}

/** Build the small summary carried by every 30-second directory heartbeat. */
export function buildMachineInventorySummary(args: {
  providerInstances: readonly MachineInventoryProviderInput[];
  modelCounts?: MachineInventoryModelCounts;
  presets: readonly MachineInventoryPresetInput[];
}): MachineInventorySummary {
  const groups = new Map<string, MachineInventoryProviderSummary>();
  for (const raw of args.providerInstances) {
    const instance = normalizeProviderInput(raw);
    if (!instance) continue;
    const current = groups.get(instance.provider);
    if (current) {
      current.accounts += 1;
      continue;
    }
    groups.set(instance.provider, {
      provider: instance.provider,
      accounts: 1,
      models: safeCount(args.modelCounts?.[instance.provider]),
    });
  }
  return {
    providers: [...groups.values()],
    presets: normalizedPresets(args.presets).length,
  };
}

/** Build live detail from mocked/read-only stores without carrying secrets. */
export function buildMachineInventoryDetail(args: {
  machineKey: string;
  providerInstances: readonly MachineInventoryProviderInput[];
  modelCounts?: MachineInventoryModelCounts;
  presets: readonly MachineInventoryPresetInput[];
  boundPresetIds?: ReadonlySet<string>;
}): MachineInventoryDetail {
  const providers = new Map<string, MachineInventoryProviderDetail>();
  for (const raw of args.providerInstances) {
    const instance = normalizeProviderInput(raw);
    if (!instance) continue;
    let group = providers.get(instance.provider);
    if (!group) {
      group = {
        provider: instance.provider,
        accounts: [],
        modelCount: safeCount(args.modelCounts?.[instance.provider]),
      };
      providers.set(instance.provider, group);
    }
    group.accounts.push({
      instanceId: instance.id,
      label: instance.label,
      ...(instance.email ? { email: instance.email } : {}),
      ...(instance.plan ? { plan: instance.plan } : {}),
      isDefault: instance.isDefault,
    });
  }

  const boundPresetIds = args.boundPresetIds ?? new Set<string>();
  const presets = normalizedPresets(args.presets).map((preset) => ({
    ...preset,
    bound: boundPresetIds.has(preset.id),
  }));

  return {
    machineKey: safeText(args.machineKey),
    providers: [...providers.values()],
    presets,
  };
}
