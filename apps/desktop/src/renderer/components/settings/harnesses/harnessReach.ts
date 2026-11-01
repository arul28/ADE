/**
 * Every model one harness can reach, grouped by where it comes from.
 *
 * This is the list the Custom provider wizard draws, for its model and for
 * every subagent pin it offers. It is built from three inputs ADE already has,
 * and the route for every row comes from the one pure decision in
 * `shared/harnessRoutes.ts`, so the list can never offer a pairing the launch
 * path would refuse:
 *
 * 1. The harness's own accounts (a Claude account in Claude Code). Native, no
 *    endpoint involved; models from the runtime catalog or registry.
 * 2. OpenCode sign-ins and stored API keys, from `ai.listHarnessRoutes`. Each
 *    model's route is computed here. A model no route can carry is kept as an
 *    `unreachable` entry with the route decision's reason (the wizard lists
 *    those greyed under the source, instead of silently dropping them); only a
 *    source that supplies nothing at all is absent.
 * 3. Every Claude and Codex account on this machine, in every other harness
 *    that takes an endpoint. ADE's proxy runs it on that account's own login,
 *    lent to it (`ade-cli/src/services/proxy/borrowedLogins.ts`), so there is
 *    no second sign-in.
 *
 * Pure: no React, no IPC. The hook in `useHarnessReach.ts` gathers the inputs.
 */

import {
  HARNESS_PRESET_BODIES,
  harnessBodyLabel,
  type HarnessPresetAccountProvider,
  type HarnessPresetBody,
  type HarnessPresetSource,
} from "../../../../shared/harnessPresets";
import {
  encodeRoutePresetId,
  harnessAcceptsRoutes,
  harnessRouteBlockedReason,
  launchModelIdFor,
  resolveHarnessRoute,
  routeForListedModel,
  ROUTABLE_HARNESSES,
  type HarnessRoute,
  type HarnessRouteCatalog,
  type HarnessRouteSource,
} from "../../../../shared/harnessRoutes";
import { cliPresetGateReason } from "../../../../shared/harnessPresetCliGate";
import {
  MODEL_REGISTRY,
  getModelById,
  resolveProviderGroupForModel,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../../shared/modelRegistry";
import type { AgentChatModelCatalog } from "../../../../shared/types";
import { descriptorsFromAgentChatModelCatalog } from "../../shared/ModelPicker/modelCatalog";
import { DEFAULT_RUNTIME_CATALOG_SCOPE } from "../../shared/ModelPicker/runtimeCatalogCache";
import type { HarnessAccountSource } from "./harnessSources";
import { defaultProviderInstanceId } from "../../../../shared/types/providerInstances";

/** One model a harness can run, with the route it takes. */
export type ReachableModel = {
  /** `${groupKey}::${id}` — unique across the whole list. */
  key: string;
  /** The id a preset stores and the source understands. */
  id: string;
  label: string;
  /** The id a launch passes as `modelId` (OpenCode's own spelling for OpenCode sign-ins in OpenCode). */
  launchModelId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningTiers?: string[];
  /** Registry family, for the row's logo. */
  family?: ProviderFamily | null;
  route: HarnessRoute;
};

export type ReachableGroupKind = "native" | "source" | "subscription";

/** One model a source serves that cannot run in this harness, with the reason. */
export type UnreachableModel = {
  model: ReachableModel;
  /** The route decision's own sentence, shown where the rows are explained. */
  reason: string;
};

export type ReachableGroup = {
  key: string;
  kind: ReachableGroupKind;
  label: string;
  detail: string;
  /** Provider id for the group's mark. */
  logoProvider: string;
  source: HarnessPresetSource;
  models: ReachableModel[];
  /** Models this source serves that cannot run in this harness, with reasons. */
  unreachable: UnreachableModel[];
  /**
   * The provider's default account in another harness. A preset saved with a
   * `subscription` source (before accounts were lent) runs on it, so it opens
   * here.
   */
  defaultAccount?: boolean;
  /** The catalog source behind a `source` group — what the Test button checks. */
  routeSource?: HarnessRouteSource;
  /** An account group's sign-in (its email, or its name before sign-in). */
  accountLabel?: string;
  /** An account group's plan ("ChatGPT Plus"), when the account says. */
  plan?: string | null;
  /** An account group whose login is missing or broken: listed, not usable yet. */
  signedOut?: boolean;
};

/** A native model list for one account provider, with limits. */
export type NativeModel = {
  /** The provider's own id — what a preset stores and the harness receives. */
  id: string;
  /** The registry id — what the composer selects, so names, recents and effort resolve. */
  registryId: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningTiers?: string[];
  family: ProviderFamily;
};

export type HarnessReachInputs = {
  catalog: HarnessRouteCatalog | null;
  accounts: readonly HarnessAccountSource[];
  nativeModels: Readonly<Record<HarnessPresetAccountProvider, readonly NativeModel[]>>;
};

const PROVIDER_FAMILY: Record<HarnessPresetAccountProvider, ProviderFamily> = {
  claude: "anthropic",
  codex: "openai",
};

/**
 * The native model list for Claude Code or Codex.
 *
 * The id is the provider's own (`claude-sonnet-5`, not the registry's
 * `anthropic/claude-sonnet-5`): a preset's model reaches the harness
 * unrewritten, and the proxy routes by `<prefix>/<provider id>`. The registry
 * still resolves it, through its aliases, for names and effort tiers.
 */
export function nativeModelsForProvider(
  provider: HarnessPresetAccountProvider,
  runtimeCatalog: AgentChatModelCatalog | null | undefined,
  scopeKey: string = DEFAULT_RUNTIME_CATALOG_SCOPE,
): NativeModel[] {
  const family = PROVIDER_FAMILY[provider];
  const belongs = (model: ModelDescriptor) =>
    model.family === family && !model.deprecated && resolveProviderGroupForModel(model) === provider;
  const runtime = runtimeCatalog
    ? descriptorsFromAgentChatModelCatalog(runtimeCatalog, belongs, scopeKey).models
    : [];
  const descriptors: ModelDescriptor[] = runtime.length > 0 ? runtime : MODEL_REGISTRY.filter(belongs);
  const seen = new Set<string>();
  const out: NativeModel[] = [];
  for (const descriptor of descriptors) {
    const id = descriptor.providerModelId?.trim() || descriptor.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      registryId: descriptor.id,
      label: descriptor.displayName,
      ...(descriptor.contextWindow ? { contextWindow: descriptor.contextWindow } : {}),
      ...(descriptor.maxOutputTokens ? { maxOutputTokens: descriptor.maxOutputTokens } : {}),
      ...(descriptor.reasoningTiers?.length ? { reasoningTiers: [...descriptor.reasoningTiers] } : {}),
      family,
    });
  }
  return out;
}

/** The id a launch passes for a model; owned by `shared/harnessRoutes.ts`. */
export { launchModelIdFor };

function accountProviderLabel(provider: HarnessPresetAccountProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

function nativeRow(groupKey: string, model: NativeModel, route: HarnessRoute): ReachableModel {
  return {
    key: `${groupKey}::${model.id}`,
    id: model.id,
    label: model.label,
    launchModelId: model.registryId,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.reasoningTiers ? { reasoningTiers: model.reasoningTiers } : {}),
    family: model.family,
    route,
  };
}

/** The groups a harness can reach, in the order they are listed. */
export function buildReachableGroups(harness: HarnessPresetBody, inputs: HarnessReachInputs): ReachableGroup[] {
  const groups: ReachableGroup[] = [];

  // 1 — the harness's own accounts.
  if (harness === "claude" || harness === "codex") {
    for (const account of inputs.accounts) {
      if (account.provider !== harness) continue;
      const source: HarnessPresetSource = { kind: "account", provider: harness, instanceId: account.instanceId };
      const key = `account:${account.instanceId}`;
      // The label is already the email (or the id before sign-in).
      groups.push({
        key,
        kind: "native",
        label: `${accountProviderLabel(harness)} · ${account.label}`,
        detail: account.loginBroken
          ? [account.email, "Signed out"].filter(Boolean).join(" · ")
          : account.signedIn ? "Signed in" : "Not signed in yet",
        logoProvider: harness,
        source,
        models: inputs.nativeModels[harness].map((model) => nativeRow(key, model, { kind: "native" })),
        unreachable: [],
        accountLabel: account.label,
        plan: account.plan ?? null,
        ...(!account.signedIn || account.loginBroken ? { signedOut: true } : {}),
      });
    }
  }

  // 2 — OpenCode sign-ins, stored keys, and borrowed subscriptions (Grok).
  // Claude and Codex accounts come from section 1 and 3 instead, built from the
  // accounts this hook already loads; a subscription is never offered inside
  // its own harness.
  for (const routeSource of inputs.catalog?.sources ?? []) {
    if (routeSource.source.kind === "account") continue;
    if (routeSource.source.kind === "subscription" && routeSource.source.provider === harness) continue;
    const models: ReachableModel[] = [];
    const unreachable: UnreachableModel[] = [];
    for (const model of routeSource.models) {
      const route = routeForListedModel(harness, routeSource, model);
      const registry = getModelById(model.id);
      const row: ReachableModel = {
        key: `${routeSource.key}::${model.id}`,
        id: model.id,
        label: model.label || model.id,
        launchModelId: launchModelIdFor(harness, routeSource.source, model.id),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
        ...(model.reasoningTiers?.length ? { reasoningTiers: model.reasoningTiers } : {}),
        family: registry?.family ?? null,
        route,
      };
      if (route.kind === "impossible") unreachable.push({ model: row, reason: route.reason });
      else models.push(row);
    }
    // A source that can serve nothing for this harness stays listed: the
    // wizard shows it with the reason instead of hiding the source, which is
    // the only way "why can't I use my ChatGPT sign-in here" has an answer on
    // screen. A source with no models at all is genuinely absent.
    if (models.length === 0 && unreachable.length === 0) continue;
    groups.push({
      key: routeSource.key,
      kind: routeSource.source.kind === "subscription" ? "subscription" : "source",
      label: routeSource.label,
      detail: routeSource.detail,
      logoProvider: routeSource.logoProvider,
      source: routeSource.source,
      models,
      unreachable,
      routeSource,
    });
  }

  // 3 — every other provider's accounts, on their own lent login.
  if (harnessAcceptsRoutes(harness)) {
    for (const account of inputs.accounts) {
      if (account.provider === harness) continue;
      const source: HarnessPresetSource = { kind: "account", provider: account.provider, instanceId: account.instanceId };
      const key = `account:${account.instanceId}`;
      const models = inputs.nativeModels[account.provider].map((model) =>
        nativeRow(key, model, resolveHarnessRoute({ harness, source, modelId: model.id })),
      );
      if (models.length === 0) continue;
      const providerLabel = accountProviderLabel(account.provider);
      groups.push({
        key,
        kind: "subscription",
        label: `${providerLabel} · ${account.label}`,
        detail: account.signedIn && !account.loginBroken
          ? "Your sign-in, no extra login"
          : `Signed out · sign in to ${providerLabel} under Providers to use it here`,
        logoProvider: account.provider,
        source,
        models,
        unreachable: [],
        accountLabel: account.label,
        plan: account.plan ?? null,
        ...(!account.signedIn || account.loginBroken ? { signedOut: true } : {}),
        ...(account.instanceId === defaultProviderInstanceId(account.provider) ? { defaultAccount: true } : {}),
      });
    }
  }

  return groups;
}

/** Whether two sources name the same thing. Labels do not count. */
export function sameSource(a: HarnessPresetSource, b: HarnessPresetSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "account" && b.kind === "account") return a.instanceId === b.instanceId;
  if (a.kind === "key" && b.kind === "key") return a.provider === b.provider && a.credentialId === b.credentialId;
  if (a.kind === "opencode" && b.kind === "opencode") return a.providerId === b.providerId;
  if (a.kind === "subscription" && b.kind === "subscription") return a.provider === b.provider;
  return false;
}

/** The row key for a source + model, or null when no group lists it. */
export function reachableKeyFor(
  groups: readonly ReachableGroup[],
  source: HarnessPresetSource,
  model: string,
): string | null {
  const id = model.trim();
  if (!id) return null;
  for (const group of groups) {
    const legacySubscription = source.kind === "subscription"
      && group.defaultAccount === true
      && group.source.kind === "account"
      && group.source.provider === source.provider;
    if (!sameSource(group.source, source) && !legacySubscription) continue;
    const row = group.models.find((entry) => entry.id === id || entry.launchModelId === id);
    if (row) return row.key;
  }
  return null;
}

export function findReachable(
  groups: readonly ReachableGroup[],
  key: string | null | undefined,
): { group: ReachableGroup; model: ReachableModel } | null {
  if (!key) return null;
  for (const group of groups) {
    const model = group.models.find((entry) => entry.key === key);
    if (model) return { group, model };
  }
  return null;
}

/**
 * Who a group's models are paid by, in two short parts: a title a person
 * recognises ("ChatGPT Plus", "Claude", "OpenCode Go") and the sign-in or key
 * it is ("you@example.com"). The rail, the preview and the saved cards say it
 * the same way.
 */
export function sourceSummary(group: ReachableGroup): { title: string; detail: string | null } {
  if (group.source.kind === "account") {
    const provider = accountProviderLabel(group.source.provider);
    return { title: group.plan?.trim() || provider, detail: group.accountLabel ?? null };
  }
  return { title: group.label, detail: null };
}

// ---------------------------------------------------------------------------
// Harness chips
// ---------------------------------------------------------------------------

export type HarnessChipOption = {
  harness: HarnessPresetBody;
  /** Set when the chip is shown but cannot be chosen, with the reason. */
  disabledReason: string | null;
};

/**
 * The harness chips, in one fixed order.
 *
 * Routable harnesses first. The rest stay visible but disabled with their
 * reason, so "why is Cursor not here" answers itself. In CLI mode the three
 * CLIs that take no endpoint from the launch say that instead.
 */
export function harnessChipOptions(mode: "chat" | "cli" = "chat"): HarnessChipOption[] {
  const routable = new Set<HarnessPresetBody>(ROUTABLE_HARNESSES);
  const ordered = [
    ...ROUTABLE_HARNESSES,
    ...HARNESS_PRESET_BODIES.filter((harness) => !routable.has(harness)),
  ];
  return ordered.map((harness) => {
    const cliReason = mode === "cli" ? cliPresetGateReason(harness) : null;
    return { harness, disabledReason: cliReason ?? harnessRouteBlockedReason(harness) };
  });
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

/** "1M · 384k" — context window, then max output. */
export function formatModelLimits(contextWindow?: number, maxOutputTokens?: number): string | null {
  const parts = [contextWindow, maxOutputTokens]
    .filter((value): value is number => typeof value === "number" && value > 0)
    .map(formatTokenCount);
  return parts.length ? parts.join(" · ") : null;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/** The short harness name used inside a default preset name. */
export function harnessShortLabel(harness: HarnessPresetBody): string {
  return harness === "codex" ? "Codex" : harnessBodyLabel(harness);
}

/** "DeepSeek V4.1 Flash in Claude Code" — the name a preset gets when none is typed. */
export function defaultPresetName(modelLabel: string, harness: HarnessPresetBody): string {
  return `${modelLabel.trim() || "Model"} in ${harnessShortLabel(harness)}`.slice(0, 60);
}

/**
 * The ad-hoc route id for a picked row, or null when the pick is the harness's
 * plain default account (then the ordinary model id already says everything).
 */
export function adHocPresetIdFor(
  harness: HarnessPresetBody,
  group: ReachableGroup,
  model: ReachableModel,
): string | null {
  if (group.source.kind === "account" && group.source.instanceId === group.source.provider) return null;
  return encodeRoutePresetId({ harness, source: group.source, model: model.id });
}

// ---------------------------------------------------------------------------
// Starter suggestions
// ---------------------------------------------------------------------------

export type StarterSuggestion = {
  key: string;
  harness: HarnessPresetBody;
  group: ReachableGroup;
  model: ReachableModel;
  name: string;
};

/** Models worth suggesting first, when a source serves them. */
const PREFERRED_STARTER_MODELS = [
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "kimi-k3",
  "glm-5.3",
  "qwen3.8-max",
  "minimax-m3",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "gpt-5.6-luna",
];

const STARTER_HARNESSES: readonly HarnessPresetBody[] = ["claude", "codex", "opencode", "droid"];

/**
 * Two or three one-click combos built from what this computer has connected.
 *
 * Each suggestion uses a different harness where it can, prefers a direct
 * route to a proxied one, and prefers a model people actually pick
 * (DeepSeek V4.1 Flash in Claude Code, when OpenCode Go is signed in). Only
 * outside sources are suggested: a Claude account in Claude Code is already
 * the default and needs no saved setup. Another provider's signed-in account
 * counts (GPT in Claude Code on a ChatGPT plan): for someone with just Claude
 * and ChatGPT, that is the whole point, and it needs no new sign-in.
 */
export function starterSuggestions(inputs: HarnessReachInputs, limit = 3): StarterSuggestion[] {
  const out: StarterSuggestion[] = [];
  const usedSources = new Set<string>();
  const score = (model: ReachableModel): number => {
    const preferred = PREFERRED_STARTER_MODELS.indexOf(model.id);
    return (preferred >= 0 ? preferred : 100) + (model.route.kind === "proxy" ? 50 : 0);
  };
  for (const harness of STARTER_HARNESSES) {
    if (out.length >= limit) break;
    const groups = buildReachableGroups(harness, inputs).filter(
      (group) => (group.kind === "source" || (group.kind === "subscription" && !group.signedOut))
        && !(harness === "opencode" && group.source.kind === "opencode"),
    );
    let best: { group: ReachableGroup; model: ReachableModel; score: number } | null = null;
    for (const group of groups) {
      // OpenCode Go is a flat subscription; Zen bills a separate balance that
      // is often empty, so a Go row beats the same model on Zen.
      const zenPenalty = group.source.kind === "opencode" && group.source.providerId === "opencode" ? 40 : 0;
      const sourcePenalty = (usedSources.has(group.key) ? 25 : 0) + zenPenalty;
      for (const model of group.models) {
        const value = score(model) + sourcePenalty;
        if (!best || value < best.score) best = { group, model, score: value };
      }
    }
    if (!best) continue;
    usedSources.add(best.group.key);
    out.push({
      key: `${harness}:${best.model.key}`,
      harness,
      group: best.group,
      model: best.model,
      name: defaultPresetName(best.model.label, harness),
    });
  }
  return out;
}
