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
import { isAdeAvailable } from "../../lib/adeAvailability";
import type { AutomationCapabilities } from "../../../shared/types";
import { isUnsupportedAdeActionError } from "../../../shared/codedError";
import {
  AUTOMATION_CLOUD_LANES_ID,
  automationFeatureGateReason,
  automationFeatureMissing,
  type AutomationFeatureKind,
  type AutomationMachineSupport,
} from "../../../shared/automationFeatureVersions";
import type { LaneMachine } from "../../state/laneMachineRouting";
import { eventLabel } from "./triggerCatalog";
import { isNotifyAdeAction, NOTIFY_STEP, STEP_DEFS, type StepKind } from "./actionCatalog";
import { BRAND } from "../../../shared/brand";

/** The "Run in" choices, as the builder names them. */
export const LANE_MODE_LABELS: Record<string, string> = {
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
      return isNotifyAdeAction({ domain, action }) ? NOTIFY_STEP.label : `${BRAND.NAME} action ${id}`;
    }
    case "cloudLanes": return `Run on ${BRAND.CLOUD_NAME}`;
    case "notifyLink": return "A notification that opens this run's history";
  }
}

/**
 * A brain's answer, and whether it is final. A missing answer that is not
 * final (offline, a timeout, a brain still starting) is asked again.
 */
type CapabilitiesRead = { capabilities: AutomationCapabilities | null; final: boolean };

/** How long the builder waits before asking a machine that did not answer again, and how often. */
const CAPABILITIES_RETRY_DELAY_MS = 15_000;
const CAPABILITIES_MAX_RETRIES = 4;

/** Answers by `pin.key|brainVersion`; an update changes the key, so it is asked again. */
const capabilitiesCache = new Map<string, Promise<CapabilitiesRead>>();

function readCapabilities(key: string, pin: NonNullable<LaneMachine["pin"]>): Promise<CapabilitiesRead> {
  const cached = capabilitiesCache.get(key);
  if (cached) return cached;
  const getCapabilities = window.ade?.automations?.getCapabilities;
  const read: Promise<CapabilitiesRead> = isAdeAvailable(getCapabilities)
    ? getCapabilities(pin).then((answer) => {
        // A brain still starting has not bound its actions (`adeActions` is
        // null, ADE Cloud lanes read as absent): not an answer to keep. The
        // version table decides until it is asked again.
        if (answer.adeActions == null) {
          capabilitiesCache.delete(key);
          return { capabilities: null, final: false };
        }
        return { capabilities: answer, final: true };
      }, (error: unknown) => {
        // An older brain refuses the call for good; anything else (offline,
        // a timeout) is asked again. Either way the version table decides
        // meanwhile.
        if (isUnsupportedAdeActionError(error)) return { capabilities: null, final: true };
        capabilitiesCache.delete(key);
        console.warn("[automations] could not read the rule machine's capabilities; using the version table", error);
        return { capabilities: null, final: false };
      })
    : Promise.resolve({ capabilities: null, final: true });
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
  // Retries of a missing answer while the same machine stays selected.
  const [retry, setRetry] = useState<{ key: string; count: number } | null>(null);
  const retries = retry && retry.key === key ? retry.count : 0;
  useEffect(() => {
    if (!key || !pin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void readCapabilities(key, pin).then(({ capabilities, final }) => {
      if (cancelled) return;
      setAnswer({ key, capabilities });
      if (!final && retries < CAPABILITIES_MAX_RETRIES) {
        timer = setTimeout(() => setRetry({ key, count: retries + 1 }), CAPABILITIES_RETRY_DELAY_MS);
      }
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // The pin is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retries]);
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

/**
 * A select option for a gated feature: disabled with the reason in its label,
 * except the one already picked, which stays choosable.
 */
export function gatedOption(
  gate: AutomationFeatureGate,
  kind: AutomationFeatureKind,
  id: string,
  label: string,
  picked: boolean,
): { disabled: boolean; label: string } {
  const blocked = picked ? null : gate.blockedReason(kind, id, label);
  return { disabled: blocked != null, label: blocked ? `${label} (${blocked})` : label };
}

/** Why the rule's machine can't run each run on ADE Cloud, or null. */
export function cloudLanesBlockedReason(gate: AutomationFeatureGate): string | null {
  return gate.blockedReason("cloudLanes", AUTOMATION_CLOUD_LANES_ID);
}

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
