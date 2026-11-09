import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, CircleNotch, Info, Lightning, Moon } from "@phosphor-icons/react";
import {
  CLOUD_FULL_COMPUTER_LABEL,
  CLOUD_SHAPES,
  cloudHoursRate,
  cloudShapeById,
  formatCloudHoursRate,
  type CloudMachineKind,
  type CloudShapeId,
  type CloudStatus,
} from "../../../shared/adeCloud";
import {
  CLOUD_READY_DEFAULT_SHAPE,
  CLOUD_READY_STEPS,
  type CloudReadyProjectStatus,
  type CloudReadyStatus,
  type CloudReadyStep,
} from "../../../shared/cloudReady";
import { type CloudSignInStatus } from "../../../shared/cloudSignIns";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { useAppStore } from "../../state/appStore";
import { originUrlForBinding } from "../lanes/laneMachines";
import { cursorCloudRepoLabel } from "../../lib/cursorCloudUtils";
import { IntegrationCard, IntegrationChoice } from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";

/** "0:42" / "2:05" since `startedAt`. */
function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The status tag beside the card title. */
function stateTag(project: CloudReadyProjectStatus | null): { label: string; tone?: "ok" | "warn" | "crit" } {
  if (!project) return { label: "Off" };
  if (project.state === "ready") return { label: "Ready", tone: "ok" };
  if (project.state === "failed") return { label: "Failed", tone: "crit" };
  return { label: "Preparing", tone: "warn" };
}

const READY_STEP_LABELS: Record<CloudReadyStep, string> = {
  make: "Make the machine",
  sign_in: "Sign in to ADE",
  clone: "Clone the repo",
  setup: "Your setup",
  sleep: "Asleep and ready",
};

/**
 * Which of `CLOUD_READY_STEPS` the project's machine is on; all done once
 * ready, and -1 (none marked) while another computer prepares it, since that
 * computer does not say its step.
 */
function readyStepIndex(project: CloudReadyProjectStatus): number {
  if (project.state === "ready") return CLOUD_READY_STEPS.length;
  return project.step ? CLOUD_READY_STEPS.indexOf(project.step) : -1;
}

/** The lockfiles a ready machine's setup can be guessed from, best first. */
const SETUP_BY_LOCKFILE: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["bun.lockb", "bun install"],
  ["bun.lock", "bun install"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["package-lock.json", "npm ci"],
];

/** A setup command for a repo whose top folder holds these files, or null. */
function setupSuggestion(fileNames: readonly string[]): string | null {
  const names = new Set(fileNames);
  return SETUP_BY_LOCKFILE.find(([lockfile]) => names.has(lockfile))?.[1] ?? null;
}

/**
 * Settings › Integrations › ADE Cloud › Ready machine: keep one machine
 * prepared and asleep for the open project, so a new chat on it is working in
 * seconds. Account-wide (the choice is in the account vault, the machines on
 * the provider), so it asks this desktop's main process with no pin.
 */
export function CloudReadyMachinesCard({ status, cloudSignIns }: { status: CloudStatus | null; cloudSignIns: CloudSignInStatus | null }) {
  const bridge = window.ade.cloud;
  const binding = useAppStore((state) => state.projectBinding);
  const identity = normalizeGitRemoteIdentity(originUrlForBinding(binding));
  // The repo names the project here: a project called "ADE" reads like the product.
  const projectName = (identity ? cursorCloudRepoLabel(identity) : null) || binding?.displayName || "this project";
  const [expanded, setExpanded] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const [ready, setReady] = useState<CloudReadyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<CloudMachineKind>("vm");
  const [shapeId, setShapeId] = useState<CloudShapeId>(CLOUD_READY_DEFAULT_SHAPE);
  const [setup, setSetup] = useState("");
  const [, setTick] = useState(0);

  const mine: CloudReadyProjectStatus | null = useMemo(
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
    setShapeId(saved?.shape ?? CLOUD_READY_DEFAULT_SHAPE);
    setSetup(saved?.setup ?? "");
  }, [identity, saved?.identity, saved?.kind, saved?.shape, saved?.setup]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether new ready machines start with any provider signed in (the card above).
  const noSignIns = cloudSignIns != null && !cloudSignIns.unknown && !cloudSignIns.saved.some((entry) => entry.saved);

  // A setup to offer from the repo's lockfile, read from the project's top
  // folder once the settings are open. Unpinned on purpose: the files are
  // where the project tab is bound.
  const showSettings = mine != null || expanded;
  useEffect(() => {
    // Another project's lockfile must never be offered here, even when this one's can't be read.
    setSuggestion(null);
    if (!showSettings || !identity) return;
    const files = window.ade.files;
    if (!files?.listWorkspaces || !files.listTree) return;
    let cancelled = false;
    void files.listWorkspaces().then(async (workspaces) => {
      const primary = workspaces.find((workspace) => workspace.kind === "primary") ?? null;
      if (!primary || cancelled) return;
      const nodes = await files.listTree({ workspaceId: primary.id, depth: 1 });
      if (!cancelled) setSuggestion(setupSuggestion(nodes.filter((node) => node.type === "file").map((node) => node.name)));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [identity, showSettings]);

  // A running prepare shows its elapsed time; one tick a second only while it runs.
  const preparing = mine?.state === "preparing" || mine?.state === "waiting";
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [preparing]);

  const run = useCallback(async (work: () => Promise<CloudReadyStatus | null | undefined>) => {
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

  const shape = cloudShapeById(shapeId);
  // Editing a project that already keeps a machine makes none now (the next
  // one uses the change), so it needs no room for a new machine.
  const changed = saved != null && (saved.kind !== kind || saved.shape !== shapeId || saved.setup !== setup);
  const tag = stateTag(mine);

  return (
    <IntegrationCard
      anchor="cloud-ready"
      span="full"
      icon={<Lightning size={15} weight="fill" />}
      title="Ready machine"
      badge={<span className="kit-tag" data-tone={tag.tone}>{tag.label}</span>}
      tone={mine?.state === "failed" ? "focus" : undefined}
      hint={`ADE keeps one machine with ${projectName} cloned and set up, asleep. A new chat started on "ADE Cloud · ready" in the chat's machine picker begins there in about 15 seconds, and ADE prepares the next one.`}
      actions={mine ? (
        <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={() => void run(() => remove(mine.settings.identity))}>
          Turn off
        </button>
      ) : identity && !expanded ? (
        <button type="button" className="ade-modern-btn" data-size="sm" data-tone="primary" onClick={() => setExpanded(true)}>
          Set up
        </button>
      ) : null}
    >
      {!identity ? (
        <p className="ade-ig-note">Open a project with a git origin to keep a machine ready for it.</p>
      ) : !showSettings ? null : (
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
                id: "cloud-ready-failed",
                tone: "error",
                title: "Couldn't prepare the machine",
                detail: mine.error ?? mine.message,
                actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: () => { void run(() => retry(mine.settings.identity)); } }],
              }}
            />
          ) : null}

          <ol className="ade-ig-ready-steps" aria-label="What ADE does">
            {CLOUD_READY_STEPS.map((step, index) => {
              const label = READY_STEP_LABELS[step];
              const at = mine && mine.state !== "failed" ? readyStepIndex(mine) : -1;
              const state = at < 0 ? undefined : index < at ? "done" : index === at && preparing ? "now" : undefined;
              return <li key={label} data-state={state} aria-current={state === "now" ? "step" : undefined}>{index + 1}. {label}</li>;
            })}
          </ol>
          {noSignIns ? (
            <p className="ade-ig-note">New ready machines start signed in to a provider only after you add one under Sign-ins for your cloud machines.</p>
          ) : null}

          <div className="ade-ig-field">
            <span className="ade-ig-field-label">Machine</span>
            <div className="ade-ig-field-controls">
              <IntegrationChoice
                label="Machine type"
                value={kind}
                disabled={busy}
                onChange={setKind}
                options={[
                  { value: "box", label: "Standard", title: "A sandboxed computer. Uses hours the slowest." },
                  { value: "vm", label: "Full computer", title: CLOUD_FULL_COMPUTER_LABEL },
                ]}
              />
              <IntegrationChoice
                label="Size"
                value={shapeId}
                disabled={busy}
                onChange={setShapeId}
                options={CLOUD_SHAPES.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.label,
                  title: `${candidate.cpu} CPU · ${candidate.memoryGb} GB`,
                }))}
              />
            </div>
          </div>

          <div className="ade-ig-field" data-align="top">
            <label className="ade-ig-field-label" htmlFor="cloud-ready-setup">Setup</label>
            <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
              <span className="ade-ig-note">Commands that get the project ready, like installing packages. ADE runs them after it clones the repo.</span>
              <textarea
                id="cloud-ready-setup"
                className="ade-settings-input ade-ig-code-input"
                rows={2}
                spellCheck={false}
                disabled={busy}
                value={setup}
                placeholder={"For example: npm ci"}
                onChange={(event) => setSetup(event.target.value)}
              />
              {suggestion && !setup.includes(suggestion) ? (
                <span className="ade-ig-note">
                  Suggested from the lockfile:
                  <button type="button" className="ade-ig-chip-btn" disabled={busy} onClick={() => setSetup((current) => (current.trim() ? `${current.trimEnd()}\n${suggestion}` : suggestion))}>
                    {suggestion}
                  </button>
                </span>
              ) : null}
            </div>
          </div>

          <div className="ade-ig-figures">
            <div className="ade-ig-figure">
              <span className="kit-eyebrow">Asleep</span>
              <b>0<small>hours</small></b>
            </div>
            <div className="ade-ig-figure">
              <span className="kit-eyebrow">Awake</span>
              <b>{formatCloudHoursRate(cloudHoursRate(kind, shape.id))}</b>
            </div>
            <div className="ade-ig-figure">
              <span className="kit-eyebrow">Docker</span>
              <b>{kind === "vm" ? "Yes" : "No"}<small>{kind === "vm" ? "and Android" : "pick Full computer"}</small></b>
            </div>
          </div>

          {error ? (
            <Banner
              layout="inline"
              model={{ id: "cloud-ready-error", tone: "error", title: "Ready machine", detail: error, actions: [{ label: "Dismiss", onClick: () => setError(null) }] }}
            />
          ) : null}

          <div className="ade-ig-card-foot">
            <span className="ade-ig-note" title="From an agent or a terminal: ade chat create --machine cloud:ready"><Info size={13} /> Also from the CLI</span>
            {saved == null || changed ? (
              <button
                type="button"
                className="ade-modern-btn"
                data-tone="primary"
                disabled={busy}
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
        <Banner layout="inline" model={{ id: "cloud-ready-pool-error", tone: "warning", title: "Ready machines", detail: ready.error }} />
      ) : null}
    </IntegrationCard>
  );
}
