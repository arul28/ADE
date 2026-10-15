// ---------------------------------------------------------------------------
// A chat's launch route: the saved preset (or stored key) a chat runs through,
// and how a model or preset change moves the chat onto one or off one. Pure
// rules; the chat service applies them.
// ---------------------------------------------------------------------------

import { decodeRoutePresetId, isRoutePresetId, launchModelIdFor } from "../../../shared/harnessRoutes";
import type { AgentChatProvider } from "../../../shared/types";
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
