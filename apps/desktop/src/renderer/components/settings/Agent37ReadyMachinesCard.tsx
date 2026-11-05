import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, CircleNotch, Info, Lightning, Moon } from "@phosphor-icons/react";
import {
  AGENT37_KINDS,
  AGENT37_READY_DEFAULT_SHAPE,
  AGENT37_SHAPES,
  agent37ChoiceBlocker,
  agent37HourlyUsd,
  agent37ReadyIdleMonthlyUsd,
  agent37Shape,
  formatAgent37Usd,
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
import { Banner } from "../ui/notice";
import { SmartTooltip } from "../ui/SmartTooltip";
import { ipcErrorMessage } from "../../lib/format";

/** "0:42" / "2:05" since `startedAt`. */
function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The status tag beside the card title. */
function stateTag(project: Agent37ReadyProjectStatus | null): { label: string; tone?: "ok" | "warn" | "crit" } {
  if (!project) return { label: "Off" };
  if (project.state === "ready") return { label: "Ready", tone: "ok" };
  if (project.state === "failed") return { label: "Failed", tone: "crit" };
  return { label: "Preparing", tone: "warn" };
}

/** A segmented choice exposed as a radio group (`.kit-seg`). */
function Choice<T extends string>({ label, value, options, disabled, onChange }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          disabled={disabled}
          onClick={() => { if (option.value !== value) onChange(option.value); }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
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
  const identity = normalizeGitRemoteIdentity(originUrlForBinding(binding));
  const projectName = binding?.displayName ?? identity ?? "this project";

  const [ready, setReady] = useState<Agent37ReadyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Agent37MachineKind>("vm");
  const [shapeId, setShapeId] = useState<Agent37ShapeId>(AGENT37_READY_DEFAULT_SHAPE);
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
      (loadError: unknown) => { if (!cancelled) setError(ipcErrorMessage(loadError) || "Couldn't read the ready machines."); },
    );
    const off = bridge.onReadyStatus?.((next) => setReady(next));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [bridge]);

  // The form shows the saved choice once it is read, and again when it changes
  // (another window, another computer); a status update alone keeps the edit.
  const saved = mine?.settings ?? null;
  // Another project with no choice yet starts from the defaults, never from the
  // last project's setup commands.
  useEffect(() => {
    setKind(saved?.kind ?? "vm");
    setShapeId(saved?.shape ?? AGENT37_READY_DEFAULT_SHAPE);
    setSetup(saved?.setup ?? "");
  }, [identity, saved?.identity, saved?.kind, saved?.shape, saved?.setup]); // eslint-disable-line react-hooks/exhaustive-deps

  // A running prepare shows its elapsed time; one tick a second only while it runs.
  const preparing = mine?.state === "preparing" || mine?.state === "waiting";
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
      setError(ipcErrorMessage(runError) || "That didn't work.");
    } finally {
      setBusy(false);
    }
  }, []);

  if (!bridge?.readyStatus || !bridge.readySetProject || !bridge.readyRemoveProject || !bridge.readyRetry) return null;
  const save = bridge.readySetProject;
  const remove = bridge.readyRemoveProject;
  const retry = bridge.readyRetry;

  const shape = agent37Shape(shapeId) ?? agent37Shape(AGENT37_READY_DEFAULT_SHAPE)!;
  // Editing a project that already keeps a machine makes none now (the next
  // one uses the change), so the workspace's machine limit doesn't block it.
  const blocker = status ? agent37ChoiceBlocker(saved ? { ...status, instanceCount: null } : status, kind, shape) : null;
  const changed = saved != null && (saved.kind !== kind || saved.shape !== shapeId || saved.setup !== setup);
  const tag = stateTag(mine);

  return (
    <IntegrationCard
      anchor="agent37-ready"
      span="full"
      icon={<Lightning size={15} weight="fill" />}
      title="Ready machine"
      badge={<span className="kit-tag" data-tone={tag.tone}>{tag.label}</span>}
      tone={mine?.state === "failed" ? "focus" : undefined}
      hint="A cloud machine kept set up and asleep, so a new chat on it starts in seconds."
      actions={mine ? (
        <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={() => void run(() => remove(mine.settings.identity))}>
          Turn off
        </button>
      ) : null}
    >
      {!identity ? (
        <p className="ade-ig-note">Open a project with a git origin to keep a machine ready for it.</p>
      ) : (
        <>
          {mine?.state === "ready" ? (
            <div className="ade-ig-state" role="status">
              <Moon size={14} weight="fill" />
              <b>{mine.machineName ?? projectName}</b>
              <span>Asleep. The next chat wakes it.</span>
            </div>
          ) : preparing && mine ? (
            <div className="ade-ig-state" role="status">
              <CircleNotch size={14} className="animate-spin" />
              <b>Preparing</b>
              <span>{mine.message}</span>
              {mine.startedAt ? <span className="kit-num">{elapsed(mine.startedAt)}</span> : null}
            </div>
          ) : mine?.state === "failed" ? (
            <Banner
              layout="inline"
              model={{
                id: "agent37-ready-failed",
                tone: "error",
                title: "Couldn't prepare the machine",
                detail: mine.error ?? mine.message,
                actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: () => { void run(() => retry(mine.settings.identity)); } }],
              }}
            />
          ) : null}

          <div className="ade-ig-field">
            <span className="ade-ig-field-label">Machine</span>
            <div className="ade-ig-field-controls">
              <Choice
                label="Machine type"
                value={kind}
                disabled={busy}
                onChange={setKind}
                options={AGENT37_KINDS.map((spec) => ({
                  value: spec.kind,
                  label: spec.kind === "vm" ? "VM · Docker" : "Box",
                  title: spec.summary,
                }))}
              />
              <Choice
                label="Size"
                value={shapeId}
                disabled={busy}
                onChange={setShapeId}
                options={AGENT37_SHAPES.map((candidate) => ({
                  value: candidate.id,
                  label: `${candidate.cpu} CPU · ${candidate.memoryGb} GB`,
                }))}
              />
            </div>
          </div>

          <div className="ade-ig-field" data-align="top">
            <label className="ade-ig-field-label" htmlFor="agent37-ready-setup">Setup</label>
            <textarea
              id="agent37-ready-setup"
              className="ade-settings-input ade-ig-code-input"
              rows={2}
              spellCheck={false}
              disabled={busy}
              value={setup}
              placeholder={"npm ci\ndocker compose up -d"}
              onChange={(event) => setSetup(event.target.value)}
            />
          </div>

          <div className="ade-ig-figures">
            <div className="ade-ig-figure">
              <span className="kit-eyebrow">Asleep</span>
              <b>{formatAgent37Usd(agent37ReadyIdleMonthlyUsd(shape))}<small>a month</small></b>
            </div>
            <div className="ade-ig-figure">
              <span className="kit-eyebrow">Awake</span>
              <b>{(agent37HourlyUsd(kind, shape) * 100).toFixed(1)}¢<small>an hour</small></b>
            </div>
            <div className="ade-ig-figure">
              <span className="kit-eyebrow">Docker</span>
              <b>{kind === "vm" ? "Yes" : "No"}<small>{kind === "vm" ? "and Android" : "pick a VM"}</small></b>
            </div>
          </div>

          {blocker ? (
            <Banner layout="inline" model={{ id: "agent37-ready-blocker", tone: "warning", title: "Can't make this machine", detail: blocker }} />
          ) : null}
          {error ? (
            <Banner
              layout="inline"
              model={{ id: "agent37-ready-error", tone: "error", title: "Ready machine", detail: error, actions: [{ label: "Dismiss", onClick: () => setError(null) }] }}
            />
          ) : null}

          <div className="ade-ig-card-foot">
            <SmartTooltip
              forceEnabled
              content={{
                label: "Start a chat on it",
                description: "Pick \"Agent 37 · ready\" in the machine list beside the composer, or run: ade chat create --machine agent37:ready",
              }}
            >
              <span className="ade-ig-note"><Info size={13} /> Pick “Agent 37 · ready” beside the composer</span>
            </SmartTooltip>
            {saved == null || changed ? (
              <button
                type="button"
                className="ade-modern-btn"
                data-tone="primary"
                disabled={busy || blocker != null}
                onClick={() => void run(() => save({ identity, projectName, kind, shape: shapeId, setup }))}
              >
                {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                {saved ? "Save for the next machine" : `Keep one ready for ${projectName}`}
              </button>
            ) : null}
          </div>
        </>
      )}

      {others.length ? (
        <div className="ade-ig-mini-rows" aria-label="Other projects kept ready">
          {others.map((project) => {
            const other = stateTag(project);
            return (
              <div key={project.settings.identity} className="ade-ig-mini-row">
                <span className="ade-ig-mini-title">{project.settings.projectName}</span>
                <span className="kit-tag" data-tone={other.tone}>{other.label}</span>
                <span className="ade-ig-mini-detail">{project.settings.identity}</span>
                <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => void run(() => remove(project.settings.identity))}>
                  Turn off
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {ready?.error ? (
        <Banner layout="inline" model={{ id: "agent37-ready-pool-error", tone: "warning", title: "Ready machines", detail: ready.error }} />
      ) : null}
    </IntegrationCard>
  );
}
