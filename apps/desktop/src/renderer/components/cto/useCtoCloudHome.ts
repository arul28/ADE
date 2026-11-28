import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cloudPlanIdOf, isPaidPlanId } from "../../../shared/adeCloud";
import { githubRepoOf } from "../../../shared/cloudLaneLaunch";
import type { CtoAdoptAccountCopyResult } from "../../../shared/ctoAccountCopy";
import { CTO_CLOUD_HOME_NEEDS_GITHUB, type CtoCloudHomeSnapshot } from "../../../shared/ctoCloudHome";
import { ipcErrorMessage } from "../../lib/format";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import type { ProjectMachine } from "../../state/projectMachines";
import { BRAND } from "../../../shared/brand";

/**
 * "ADE Cloud" as the CTO's home, for the CTO page (`shared/ctoCloudHome.ts`).
 *
 * Paid plans only: a free plan sees the option and is sent to the upgrade.
 * On a paid plan, picking it makes the computer in this app's main process
 * (`ctoCloudHomeService.ts`); once the computer's checkout shows up in the
 * machine list, it is recorded as the home through `choose`, the same way a
 * person's own machine is.
 */

export type CtoCloudHomeOption = {
  /** False when ADE Cloud is off for this account: the row is not shown. */
  shown: boolean;
  /** Why it can't be picked here, or null. */
  blocked: string | null;
  /** Known paid plan. False on free, and while the plan is still being read. */
  paid: boolean;
  /** The plan is read. */
  planKnown: boolean;
  job: CtoCloudHomeSnapshot | null;
  /** A start, retry or cancel failed before a job answered. */
  error: string | null;
  busy: boolean;
  /** The computer is ready, and ADE is waiting for its checkout to show up here. */
  linking: boolean;
  /** That wait has run long: the computer hasn't connected to this app yet. */
  linkStalled: boolean;
  start: () => Promise<void>;
  retry: () => Promise<void>;
  cancel: () => Promise<void>;
  upgrade: () => Promise<void>;
  clearError: () => void;
};

/** How long a ready computer may take to show up here before the page says so. */
const LINK_STALL_MS = 45_000;

/** The computer's checkout in this app's machine list, once it is reachable. */
function machineForJob(job: CtoCloudHomeSnapshot, machines: readonly ProjectMachine[]): ProjectMachine | null {
  const targetId = job.targetId ?? job.binding?.targetId ?? null;
  if (!targetId) return null;
  return machines.find((machine) => !machine.isThisMachine
    && (machine.machineId === targetId || (machine.pin?.kind === "remote" && machine.pin.targetId === targetId))
    && machine.pin != null
    && machine.hasRepo
    && machine.deviceId != null) ?? null;
}

export function useCtoCloudHome(args: {
  active: boolean;
  origin: string | null;
  machines: readonly ProjectMachine[];
  choose: (machine: ProjectMachine, options?: { cloudInstanceId?: string | null }) => Promise<CtoAdoptAccountCopyResult | null>;
  /** The computer became the home. */
  onChosen: (result: { machine: ProjectMachine; adopted: CtoAdoptAccountCopyResult | null }) => void;
}): CtoCloudHomeOption {
  const { active, origin, machines, choose, onChosen } = args;
  const enabled = useAdeCloudEnabled();
  const account = useCloudAccount();
  const api = typeof window === "undefined" ? undefined : window.ade?.cloud;
  const bridge = api?.ctoHome;
  const identity = githubRepoOf(origin)?.identity ?? null;
  const [job, setJob] = useState<CtoCloudHomeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The job for this repository: read when the page opens, then followed.
  useEffect(() => {
    if (!active || !bridge || !identity) {
      setJob(null);
      return undefined;
    }
    let cancelled = false;
    const off = api?.onCtoHomeEvent?.((event) => {
      if (event.type === "updated" && event.snapshot.projectOrigin === identity) {
        setJob((current) => (current && current.jobId === event.snapshot.jobId && current.updatedAt > event.snapshot.updatedAt
          ? current
          : event.snapshot));
      } else if (event.type === "removed" && event.projectOrigin === identity) {
        setJob((current) => (current?.jobId === event.jobId ? null : current));
      }
    });
    void bridge({ method: "get", args: { originUrl: origin } })
      .then((value) => { if (!cancelled) setJob(value ?? null); })
      .catch(() => { if (!cancelled) setJob(null); });
    return () => {
      cancelled = true;
      off?.();
    };
    // `origin` is read through `identity`; the bridge objects are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, identity]);

  // Ready: record it as the home once its checkout shows up in this app's list.
  const linkingRef = useRef<string | null>(null);
  const linkMachine = job?.phase === "ready" ? machineForJob(job, machines) : null;
  const [linkStalled, setLinkStalled] = useState(false);
  const waitingJobId = job?.phase === "ready" && !linkMachine ? job.jobId : null;
  useEffect(() => {
    setLinkStalled(false);
    if (!waitingJobId) return undefined;
    const timer = window.setTimeout(() => setLinkStalled(true), LINK_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [waitingJobId]);
  useEffect(() => {
    if (!active || !job || job.phase !== "ready" || !linkMachine) return;
    if (linkingRef.current === job.jobId) return;
    linkingRef.current = job.jobId;
    const jobId = job.jobId;
    void (async () => {
      try {
        const adopted = await choose(linkMachine, { cloudInstanceId: job.instanceId });
        await bridge?.({ method: "finish", args: { jobId } }).catch(() => undefined);
        setJob(null);
        onChosen({ machine: linkMachine, adopted });
      } catch (err) {
        linkingRef.current = null;
        setError(ipcErrorMessage(err) || `${BRAND.NAME} couldn't make the new computer the CTO's home.`);
      }
    })();
  }, [active, bridge, choose, job, linkMachine, onChosen]);

  const planKnown = account != null;
  const paid = account != null && isPaidPlanId(cloudPlanIdOf(account));
  const blocked = !bridge
    ? `Set this up from the ${BRAND.NAME} app on a computer.`
    : !identity
      ? CTO_CLOUD_HOME_NEEDS_GITHUB
      : null;

  /** Runs a call; a job it answers becomes the shown job. */
  const run = useCallback(async (call: () => Promise<CtoCloudHomeSnapshot | null>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const value = await call();
      if (value) setJob(value);
    } catch (err) {
      setError(ipcErrorMessage(err) || fallback);
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(async () => {
    if (!bridge || !identity) return;
    linkingRef.current = null;
    await run(() => bridge({ method: "start", args: { originUrl: origin } }), `${BRAND.NAME} couldn't start making the computer.`);
  }, [bridge, identity, origin, run]);

  const retry = useCallback(async () => {
    if (!bridge || !job) return;
    await run(() => bridge({ method: "retry", args: { jobId: job.jobId } }), `${BRAND.NAME} couldn't try again.`);
  }, [bridge, job, run]);

  const cancel = useCallback(async () => {
    if (!bridge || !job) return;
    const jobId = job.jobId;
    await run(async () => {
      const value = await bridge({ method: "cancel", args: { jobId } });
      // A cancel removes the job; one whose cleanup failed says what is left.
      if (value?.phase === "cancelled") {
        setJob(null);
        if (value.error) setError(value.error);
        return null;
      }
      return value;
    }, `${BRAND.NAME} couldn't cancel. Delete the computer in Settings › ${BRAND.CLOUD_NAME}.`);
  }, [bridge, job, run]);

  const upgrade = useCallback(async () => {
    const open = api?.openCheckout;
    if (!open) return;
    await run(async () => {
      await open("plus");
      return null;
    }, `${BRAND.NAME} couldn't open the upgrade page.`);
    // The plan changes when the checkout finishes; the account store reads it again.
  }, [api, run]);

  const clearError = useCallback(() => setError(null), []);

  return useMemo(() => ({
    shown: enabled,
    blocked,
    paid,
    planKnown,
    job,
    error,
    busy,
    linking: job?.phase === "ready",
    // A move-in that failed (the error says why) is stalled too: Cancel comes back.
    linkStalled: linkStalled || (job?.phase === "ready" && error != null),
    start,
    retry,
    cancel,
    upgrade,
    clearError,
  }), [blocked, busy, cancel, clearError, enabled, error, job, linkStalled, paid, planKnown, retry, start, upgrade]);
}
