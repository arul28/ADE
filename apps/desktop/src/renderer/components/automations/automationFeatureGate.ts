/**
 * What the rule's machine can run, for the builder to grey out the rest.
 *
 * The machine's brain answers `automations.getCapabilities` once per machine
 * and version (cached for the window's life). Until it answers, and for a
 * brain older than the call, the version table in
 * `shared/automationFeatureVersions.ts` decides. This window's own machine
 * runs this build, so nothing is gated there.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { AutomationCapabilities } from "../../../shared/types";
import { isUnsupportedAdeActionError } from "../../../shared/codedError";
import {
  automationFeatureGateReason,
  automationFeatureMissing,
  type AutomationFeatureKind,
  type AutomationMachineSupport,
} from "../../../shared/automationFeatureVersions";
import type { LaneMachine } from "../../state/laneMachineRouting";
import { eventLabel } from "./triggerCatalog";
import { isNotifyAdeAction, NOTIFY_STEP, STEP_DEFS, type StepKind } from "./actionCatalog";

const LANE_MODE_LABELS: Record<string, string> = {
  create: "A new lane each run",
  reuse: "An existing lane",
  "require-on-trigger": "The lane that triggered it",
  "pr-branch": "The PR's branch",
};

/** The builder's own name for a feature, for one the version table has no row for. */
export function automationFeatureLabel(kind: AutomationFeatureKind, id: string): string | null {
  switch (kind) {
    case "trigger": return eventLabel(id);
    case "step": return STEP_DEFS[id as StepKind]?.label ?? null;
    case "laneMode": return LANE_MODE_LABELS[id] ?? null;
    case "adeAction": {
      const [domain, action] = id.split(".");
      return isNotifyAdeAction({ domain, action }) ? NOTIFY_STEP.label : `ADE action ${id}`;
    }
    case "cloudLanes": return "Run on ADE Cloud";
  }
}

/** Answers by `pin.key|brainVersion`; an update changes the key, so it is asked again. */
const capabilitiesCache = new Map<string, Promise<AutomationCapabilities | null>>();

function readCapabilities(key: string, pin: NonNullable<LaneMachine["pin"]>): Promise<AutomationCapabilities | null> {
  const cached = capabilitiesCache.get(key);
  if (cached) return cached;
  const getCapabilities = window.ade?.automations?.getCapabilities;
  const read = typeof getCapabilities === "function"
    ? getCapabilities(pin).catch((error: unknown) => {
        // An older brain refuses the call for good; anything else (offline,
        // a timeout) is asked again next time.
        if (!isUnsupportedAdeActionError(error)) capabilitiesCache.delete(key);
        return null;
      })
    : Promise.resolve(null);
  capabilitiesCache.set(key, read);
  return read;
}

/** What is known about the ADE on `machine`; null for this window's own machine. */
export function useAutomationMachineSupport(machine: LaneMachine | null): AutomationMachineSupport {
  const foreign = machine && !machine.isThisMachine ? machine : null;
  const pin = foreign?.online ? foreign.pin : null;
  const version = foreign?.brainVersion ?? null;
  const key = pin ? `${pin.key}|${version ?? ""}` : null;
  const [answer, setAnswer] = useState<{ key: string; capabilities: AutomationCapabilities | null } | null>(null);
  useEffect(() => {
    if (!key || !pin) return;
    let cancelled = false;
    void readCapabilities(key, pin).then((capabilities) => {
      if (!cancelled) setAnswer({ key, capabilities });
    });
    return () => {
      cancelled = true;
    };
    // The pin is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const capabilities = answer && answer.key === key ? answer.capabilities : null;
  const isForeign = foreign != null;
  return useMemo(
    () => (isForeign ? { capabilities, version } : null),
    [capabilities, isForeign, version],
  );
}

export type AutomationFeatureGate = {
  /** The rule machine's name, for the reasons. */
  machineName: string | null;
  /** Why the rule's machine can't use a feature ("Needs ADE 1.2.96 on Mac Studio"), or null. */
  blockedReason: (kind: AutomationFeatureKind, id: string, label?: string | null) => string | null;
};

const OPEN_GATE: AutomationFeatureGate = { machineName: null, blockedReason: () => null };

export function buildAutomationFeatureGate(support: AutomationMachineSupport, machineName: string | null): AutomationFeatureGate {
  if (!support) return OPEN_GATE;
  return {
    machineName,
    blockedReason: (kind, id, label) => {
      const missing = automationFeatureMissing(support, kind, id, label ?? automationFeatureLabel(kind, id));
      return missing ? automationFeatureGateReason(missing, machineName) : null;
    },
  };
}

export const AutomationFeatureGateContext = createContext<AutomationFeatureGate>(OPEN_GATE);

export function useAutomationFeatureGate(): AutomationFeatureGate {
  return useContext(AutomationFeatureGateContext);
}
