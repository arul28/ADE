import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, CircleNotch, Lightning, Warning } from "@phosphor-icons/react";
import {
  AGENT37_KINDS,
  AGENT37_SHAPES,
  agent37ChoiceBlocker,
  agent37Shape,
  describeAgent37ReadyCost,
  type Agent37MachineKind,
  type Agent37ReadyProjectStatus,
  type Agent37ReadyStatus,
  type Agent37ShapeId,
  type Agent37Status,
} from "../../../shared/agent37";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { useAppStore } from "../../state/appStore";
import { originUrlForBinding } from "../lanes/laneMachines";
import { IntegrationCard } from "./integrations/IntegrationChrome";
import { AGENT37_NAME } from "../remoteTargets/agent37Brand";

function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "").trim();
  return message || fallback;
}

function elapsedLabel(startedAt: number | null): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return seconds < 90 ? ` (${seconds} s)` : ` (${Math.round(seconds / 60)} min)`;
}

/**
 * Settings › Integrations › Agent 37 › Ready machine: keep one machine
 * prepared and asleep for the open project, so a new chat on it is working in
 * seconds. Account-wide (the choice is in the account vault, the machines on
 * Agent 37), so it asks this desktop's main process with no pin.
 */
export function Agent37ReadyMachinesCard({ status }: { status: Agent37Status | null }) {
  const bridge = window.ade.agent37;
  const binding = useAppStore((state) => state.projectBinding);
  const originUrl = binding ? binding.gitOriginUrl ?? originUrlForBinding(binding) : null;
  const identity = normalizeGitRemoteIdentity(originUrl);
  const projectName = binding?.displayName ?? identity ?? "this project";

  const [ready, setReady] = useState<Agent37ReadyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Agent37MachineKind>("vm");
  const [shapeId, setShapeId] = useState<Agent37ShapeId>("4x8");
  const [setup, setSetup] = useState("");
  const [, setTick] = useState(0);

  const mine: Agent37ReadyProjectStatus | null = useMemo(
    () => ready?.projects.find((project) => project.settings.identity === identity) ?? null,
    [identity, ready],
  );
  const others = useMemo(
    () => ready?.projects.filter((project) => project.settings.identity !== identity) ?? [],
    [identity, ready],
  );

  useEffect(() => {
    if (!bridge?.readyStatus) return;
    let cancelled = false;
    void bridge.readyStatus().then(
      (next) => { if (!cancelled && next) setReady(next); },
      (loadError: unknown) => { if (!cancelled) setError(errorText(loadError, "Couldn't read the ready machines.")); },
    );
    const off = bridge.onReadyStatus?.((next) => setReady(next));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [bridge]);

  // The form shows the saved choice once it is read.
  useEffect(() => {
    if (!mine) return;
    setKind(mine.settings.kind);
    setShapeId(mine.settings.shape);
    setSetup(mine.settings.setup);
  }, [mine?.settings.identity, mine?.settings.kind, mine?.settings.shape, mine?.settings.setup]);

  // A running prepare shows its elapsed time; one tick a second only while it runs.
  const preparing = mine?.state === "preparing";
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [preparing]);

  const run = useCallback(async (work: () => Promise<Agent37ReadyStatus | null | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (next) setReady(next);
    } catch (runError) {
      setError(errorText(runError, "That didn't work."));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!bridge?.readyStatus || !bridge.readySetProject || !bridge.readyRemoveProject || !bridge.readyRetry) return null;
  const save = bridge.readySetProject;
  const remove = bridge.readyRemoveProject;
  const retry = bridge.readyRetry;

  const shape = agent37Shape(shapeId) ?? AGENT37_SHAPES[1]!;
  const blocker = status ? agent37ChoiceBlocker(status, kind, shape) : null;
  const saved = mine != null;
  const changed = saved && (mine.settings.kind !== kind || mine.settings.shape !== shapeId || mine.settings.setup !== setup);
  const icon = mine?.state === "failed"
    ? <Warning size={15} weight="fill" />
    : preparing
      ? <CircleNotch size={15} className="animate-spin" />
      : <Lightning size={15} weight="fill" />;

  return (
    <IntegrationCard
      anchor="agent37-ready"
      icon={icon}
      title="Ready machine"
      tone={mine?.state === "failed" ? "focus" : undefined}
      hint={`Keep a cloud machine ready for a project: ADE makes it, clones the repository, runs your setup, starts its services, then puts it to sleep. A new chat on it wakes it and is working in seconds. The next one is prepared after each chat.`}
      actions={mine?.state === "failed" ? (
        <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={() => void run(() => retry(mine.settings.identity))}>
          <ArrowClockwise size={12} /> Retry
        </button>
      ) : null}
    >
      {!identity ? (
        <p className="ade-ig-note">Open a project with a git origin to keep a machine ready for it. The machine clones it from there.</p>
      ) : (
        <div className="ade-ig-form" style={{ display: "grid", gap: 8 }}>
          {mine ? (
            <p className="ade-ig-note" role="status">
              <b>{projectName}:</b> {mine.message}{preparing ? elapsedLabel(mine.startedAt) : ""}
            </p>
          ) : (
            <p className="ade-ig-note">Not kept ready for <b>{projectName}</b> ({identity}).</p>
          )}
          <div className="ade-ig-inline-field">
            <span>Machine</span>
            <select
              className="ade-settings-input"
              aria-label="Machine type"
              style={{ height: 28, width: "auto" }}
              disabled={busy}
              value={kind}
              onChange={(event) => setKind(event.target.value === "box" ? "box" : "vm")}
            >
              {AGENT37_KINDS.map((spec) => (
                <option key={spec.kind} value={spec.kind}>{spec.label}{spec.kind === "vm" ? " (Docker)" : ""}</option>
              ))}
            </select>
            <select
              className="ade-settings-input"
              aria-label="Size"
              style={{ height: 28, width: "auto" }}
              disabled={busy}
              value={shapeId}
              onChange={(event) => setShapeId((agent37Shape(event.target.value)?.id ?? "4x8"))}
            >
              {AGENT37_SHAPES.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.cpu} CPU · {candidate.memoryGb} GB</option>
              ))}
            </select>
          </div>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span>Setup, run once in the clone before it sleeps</span>
            <textarea
              className="ade-settings-input"
              aria-label="Setup commands"
              rows={3}
              spellCheck={false}
              disabled={busy}
              value={setup}
              placeholder={"npm ci\ndocker compose up -d"}
              onChange={(event) => setSetup(event.target.value)}
              style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11.5, resize: "vertical", minHeight: 56 }}
            />
          </label>
          <p className="ade-ig-note">
            {describeAgent37ReadyCost(kind, shape)}
            {kind === "box" ? " A box has no Docker; pick a VM for a project that starts containers." : ""}
          </p>
          {blocker ? <p className="ade-ig-note" role="alert">{blocker}</p> : null}
          {error ? <p className="ade-ig-note" role="alert">{error}</p> : null}
          <div className="ade-ig-step-actions">
            {!saved || changed ? (
              <button
                type="button"
                className="ade-modern-btn"
                data-tone="primary"
                disabled={busy || blocker != null}
                onClick={() => void run(() => save({ identity, originUrl: originUrl ?? undefined, projectName, kind, shape: shapeId, setup }))}
              >
                {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                {saved ? "Save" : "Keep a machine ready"}
              </button>
            ) : null}
            {saved ? (
              <button type="button" className="ade-modern-btn" data-variant="ghost" disabled={busy} onClick={() => void run(() => remove(identity))}>
                Turn off
              </button>
            ) : null}
          </div>
          {saved && changed ? <p className="ade-ig-note">The next machine uses the new choice; one already prepared stays as it is.</p> : null}
        </div>
      )}
      {others.length ? (
        <div style={{ display: "grid", gap: 4, marginTop: 10 }}>
          <p className="ade-ig-note"><b>Other projects kept ready</b></p>
          {others.map((project) => (
            <div key={project.settings.identity} className="ade-ig-inline-field">
              <span>{project.settings.projectName}: {project.message}</span>
              <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => void run(() => remove(project.settings.identity))}>
                Turn off
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {ready?.error ? <p className="ade-ig-note" role="alert">{ready.error}</p> : null}
      <p className="ade-ig-note" style={{ marginTop: 8 }}>
        Start a chat on it from the machine list beside the composer ({AGENT37_NAME} · ready), or with <code>ade chat create --machine agent37:ready</code>.
      </p>
    </IntegrationCard>
  );
}
