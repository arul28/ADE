// ---------------------------------------------------------------------------
// A chat's launch route: the saved preset (or stored key) a chat runs through,
// and how a model or preset change moves the chat onto one or off one. Pure
// rules; the chat service applies them.
// ---------------------------------------------------------------------------

import { normalizeHarnessPreset, presetLabel, presetSourceLabel } from "../../../shared/harnessPresets";
import { decodeRoutePresetId, isRoutePresetId, launchModelIdFor } from "../../../shared/harnessRoutes";
import type { AgentChatCrossMachineRoute, AgentChatProvider } from "../../../shared/types";
import { readHarnessPresetsFromMachine } from "./harnessPresetSettings";

/**
 * A preset's harness and the model its launch names, spelled the way the
 * composer sends it. Read from the same machine cache the launch reads; an
 * ad-hoc route id carries its spec in the id. Null when this machine has no
 * such preset.
 */
export function readPresetLaunchTarget(presetId: string, adeHome: string): { harness: AgentChatProvider; model: string } | null {
  const spec = isRoutePresetId(presetId)
    ? decodeRoutePresetId(presetId)
    : readHarnessPresetsFromMachine(adeHome)?.find((preset) => preset.id === presetId) ?? null;
  if (!spec) return null;
  const model = spec.model.trim() ? launchModelIdFor(spec.harness, spec.source, spec.model) : "";
  return { harness: spec.harness, model };
}

export type LaunchRouteTransition = {
  joinsPreset: boolean;
  leavesPreset: boolean;
  leavesCredential: boolean;
  /** What the chat has left, so persistence does not bring it back. */
  leftLaunchRoute: { preset: boolean; credential: boolean };
};

/**
 * A preset names the model it launches, and every launch reads the preset's
 * model over the row's. So a chat leaves its preset for another model (kept,
 * the row would name the new model while the chat ran the old one) or when
 * asked, and moves when another preset is named; the same model sent again (a
 * settings save) keeps it. A stored key only bills the launch, so it stays for
 * a model of the same provider and goes with a switch to another provider or
 * onto a preset.
 */
export function launchRouteTransition(args: {
  currentPresetId: string | null;
  hasCredential: boolean;
  /** The preset the update names, or null for a plain model. */
  nextPresetId: string | null;
  /** The update asked to leave the preset (`presetId: null`). */
  explicitLeave: boolean;
  /** The update names the model the chat already runs. */
  sameModel: boolean;
  providerChanged: boolean;
  previouslyLeft: { preset: boolean; credential: boolean } | undefined;
}): LaunchRouteTransition {
  const { currentPresetId, nextPresetId } = args;
  const joinsPreset = nextPresetId !== null && nextPresetId !== currentPresetId;
  const leavesPreset = currentPresetId !== null
    && currentPresetId !== nextPresetId
    && (nextPresetId !== null || args.explicitLeave || !args.sameModel);
  const leavesCredential = (args.providerChanged || joinsPreset) && args.hasCredential;
  return {
    joinsPreset,
    leavesPreset,
    leavesCredential,
    leftLaunchRoute: {
      preset: !joinsPreset && (leavesPreset || Boolean(args.previouslyLeft?.preset)),
      credential: leavesCredential || Boolean(args.previouslyLeft?.credential),
    },
  };
}

/**
 * What a chat moved to another machine keeps of its route, by the rule above:
 * a preset only for the same model (it names the model it launches), a stored
 * key or an account only for the same provider (an account as its email:
 * its id means nothing on another machine). Null when the chat has no
 * route of its own; `dropped` when it has one the move can't keep.
 */
export function crossMachineRouteFor(args: {
  source: {
    provider: string;
    modelId?: string | null;
    presetId?: string | null;
    credentialId?: string | null;
    instanceId?: string | null;
    /** The signed-in email of `instanceId` on the source machine, when known. */
    accountEmail?: string | null;
  };
  targetProvider: string;
  targetModelId: string;
  adeHome: string;
}): AgentChatCrossMachineRoute | null {
  const { source } = args;
  const presetId = source.presetId?.trim();
  const credentialId = source.credentialId?.trim();
  const instanceId = source.instanceId?.trim();
  const sameProvider = args.targetProvider === source.provider;
  if (presetId) {
    const route = decodeRoutePresetId(presetId);
    const saved = route ? null : readHarnessPresetsFromMachine(args.adeHome)?.find((preset) => preset.id === presetId) ?? null;
    const label = route
      ? presetSourceLabel(route.source)
      : saved ? `${presetLabel(saved)} (${presetSourceLabel(saved.source)})` : "a saved preset";
    if (source.modelId !== args.targetModelId) return { label, dropped: true };
    return { label, presetId, ...(saved ? { presetSnapshot: saved } : {}) };
  }
  if (credentialId) {
    const label = `API key · ${credentialId}`;
    return sameProvider ? { label, credentialId } : { label, dropped: true };
  }
  if (instanceId && (source.provider === "claude" || source.provider === "codex")) {
    const email = source.accountEmail?.trim() || null;
    const label = `${source.provider === "claude" ? "Claude" : "Codex"} account · ${email ?? instanceId}`;
    return sameProvider ? { label, account: { email } } : { label, dropped: true };
  }
  return null;
}

/** A carried route as the destination trusts it: bounded ids, a valid preset snapshot, or null. */
export function readCrossMachineRoute(value: unknown): AgentChatCrossMachineRoute | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (field: unknown, max: number): string | undefined =>
    typeof field === "string" && field.trim() && field.trim().length <= max ? field.trim() : undefined;
  const label = text(raw.label, 200);
  if (!label) return null;
  const presetId = text(raw.presetId, 2_000);
  const snapshot = presetId ? normalizeHarnessPreset(raw.presetSnapshot) : null;
  const credentialId = text(raw.credentialId, 200);
  const account = raw.account && typeof raw.account === "object"
    ? { email: text((raw.account as Record<string, unknown>).email, 320) ?? null }
    : null;
  return {
    label,
    ...(raw.dropped === true ? { dropped: true } : {}),
    ...(presetId ? { presetId } : {}),
    ...(snapshot && snapshot.id === presetId ? { presetSnapshot: snapshot } : {}),
    ...(credentialId ? { credentialId } : {}),
    ...(account ? { account } : {}),
  };
}

/**
 * The line a moved chat shows before its first turn: which sign-in it uses on
 * this machine, and why when that is not the one it used before.
 */
export function crossMachineRouteNotice(args: {
  route: AgentChatCrossMachineRoute;
  fromMachine: string;
  /** The route's account (by its email) is signed in here; only read when the route has one. */
  accountKept: boolean;
  /** The account the chat uses here instead, when it has one. */
  accountHere: string | null;
  /** Why the kept route can't run here (the send gate's reason), or null. */
  blockedReason: string | null;
}): { message: string; warning: boolean } {
  const { route, fromMachine: from } = args;
  if (route.dropped) {
    return { message: `This chat used ${route.label} on ${from}. The move changed its model, so it uses this machine's own sign-in here.`, warning: true };
  }
  if (route.account && !args.accountKept) {
    const here = args.accountHere ? `the account ${args.accountHere}` : "this machine's own sign-in";
    return { message: `This chat used ${route.label} on ${from}. That account isn't signed in on this machine, so it uses ${here} here.`, warning: true };
  }
  if (args.blockedReason) {
    return { message: `This chat uses ${route.label}, as on ${from}, but it can't run on this machine yet: ${args.blockedReason}`, warning: true };
  }
  return { message: `Uses ${route.label} here, as on ${from}.`, warning: false };
}
