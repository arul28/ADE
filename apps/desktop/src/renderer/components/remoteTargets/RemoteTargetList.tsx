import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { CheckCircle, DesktopTower, PlugsConnected, Trash, Warning } from "@phosphor-icons/react";
import { extractError } from "../../lib/format";
import { useAppStore } from "../../state/appStore";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import type { RemoteRuntimeConnectResult, RemoteRuntimeDiscoveredMachine, RemoteRuntimeLocalWorkCheckResult, RemoteRuntimeProjectRecord, RemoteRuntimeTarget, RemoteRuntimeTargetInput } from "../../../shared/types";
import { RemoteProjectOpenDialog } from "../projects/RemoteProjectOpenDialog";
import { RemoteTargetForm, type RemoteTargetFormPrefill } from "./RemoteTargetForm";

type RemoteTargetListProps = {
  onConnected?: (result: RemoteRuntimeConnectResult) => void;
};

type ProjectInspectionState = {
  loading: boolean;
  laneCount: number | null;
  error: string | null;
};

type PendingRemoteProjectOpen = {
  targetId: string;
  runtimeName: string;
  project: RemoteRuntimeProjectRecord;
  localWork: RemoteRuntimeLocalWorkCheckResult;
};

const panelStyle: CSSProperties = {
  display: "grid",
  gap: 14,
};

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  borderRadius: 10,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(255,255,255,0.025)",
  padding: 14,
};

function formatLastSeen(value: number | null): string {
  if (!value) return "Never connected";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Last connection unknown";
  return `Last connected ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function projectLabel(project: RemoteRuntimeProjectRecord): string {
  return project.displayName || project.rootPath.split(/[\\/]/).filter(Boolean).at(-1) || project.projectId;
}

function discoveredRuntimeLabel(machine: RemoteRuntimeDiscoveredMachine): string {
  const kind = (machine.runtimeKind ?? "").toLowerCase();
  const label = kind === "daemon" || kind === "headless"
    ? "Background ADE"
    : kind === "desktop" || kind === "desktop-embedded"
      ? "ADE app"
      : "ADE service";
  return machine.runtimeVersion ? `${label} ${machine.runtimeVersion}` : label;
}

function discoveredProjectLabel(machine: RemoteRuntimeDiscoveredMachine): string {
  const count = machine.projectCount ?? machine.projectIds.length;
  if (count <= 0) return "No projects advertised";
  return `${count} project${count === 1 ? "" : "s"} advertised`;
}

function discoveredRoute(machine: RemoteRuntimeDiscoveredMachine): string | null {
  return machine.primaryRoute ?? machine.tailscaleAddress ?? machine.hostName ?? machine.addresses[0] ?? null;
}

function targetConnectionLabel(target: RemoteRuntimeTarget): string {
  const userPrefix = target.sshUser ? `${target.sshUser}@` : "";
  const portSuffix = target.port ? `:${target.port}` : "";
  const configHint = target.sshUser && target.port ? "" : " (SSH config)";
  return `${userPrefix}${target.hostname}${portSuffix}${configHint}`;
}

export function RemoteTargetList({ onConnected }: RemoteTargetListProps) {
  const [targets, setTargets] = useState<RemoteRuntimeTarget[]>([]);
  const [discoveredMachines, setDiscoveredMachines] = useState<RemoteRuntimeDiscoveredMachine[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projects, setProjects] = useState<RemoteRuntimeProjectRecord[]>([]);
  const [connected, setConnected] = useState<RemoteRuntimeConnectResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDiscovered, setLoadingDiscovered] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [registeringProject, setRegisteringProject] = useState(false);
  const [remoteProjectPath, setRemoteProjectPath] = useState("");
  const [projectInspections, setProjectInspections] = useState<Record<string, ProjectInspectionState>>({});
  const [pendingOpen, setPendingOpen] = useState<PendingRemoteProjectOpen | null>(null);
  const [openingPendingProject, setOpeningPendingProject] = useState(false);
  const [formPrefill, setFormPrefill] = useState<RemoteTargetFormPrefill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const switchRemoteProject = useAppStore((s) => s.switchRemoteProject);

  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedId) ?? null,
    [selectedId, targets],
  );

  const loadTargets = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.ade.remoteRuntime.listTargets();
      setTargets(next);
      setSelectedId((current) => current ?? next[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  const loadDiscoveredMachines = useCallback(async () => {
    setLoadingDiscovered(true);
    try {
      const next = await window.ade.remoteRuntime.listDiscoveredMachines();
      setDiscoveredMachines(next);
      setDiscoveryError(null);
    } catch (err) {
      setDiscoveryError(extractError(err));
    } finally {
      setLoadingDiscovered(false);
    }
  }, []);

  useEffect(() => {
    void loadDiscoveredMachines();
  }, [loadDiscoveredMachines]);

  const applyDiscoveredRoute = useCallback((machine: RemoteRuntimeDiscoveredMachine) => {
    const route = discoveredRoute(machine);
    if (!route) return;
    setFormPrefill({
      key: `${machine.id}:${machine.lastSeenAt}`,
      name: machine.machineName,
      hostname: route.replace(/\.$/, ""),
      sshUser: "",
      port: null,
      sshKeyPath: null,
    });
  }, []);

  const connectTarget = useCallback(async (targetId: string) => {
    setBusyId(targetId);
    try {
      const result = await window.ade.remoteRuntime.connect(targetId);
      setConnected(result);
      setProjects(result.projects);
      setProjectInspections({});
      setPendingOpen(null);
      setTargets((current) => current.map((target) => target.id === result.target.id ? result.target : target));
      setSelectedId(result.target.id);
      setError(null);
      onConnected?.(result);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusyId(null);
    }
  }, [onConnected]);

  const saveAndConnect = useCallback(async (input: RemoteRuntimeTargetInput) => {
    setSaving(true);
    try {
      const target = await window.ade.remoteRuntime.saveTarget(input);
      setTargets((current) => [target, ...current.filter((entry) => entry.id !== target.id)]);
      setSelectedId(target.id);
      setError(null);
      await connectTarget(target.id);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSaving(false);
    }
  }, [connectTarget]);

  const removeTarget = useCallback(async (targetId: string) => {
    setBusyId(targetId);
    try {
      await window.ade.remoteRuntime.removeTarget(targetId);
      setTargets((current) => current.filter((target) => target.id !== targetId));
      if (selectedId === targetId) {
        setSelectedId(null);
        setProjects([]);
        setConnected(null);
        setProjectInspections({});
      }
      setPendingOpen((current) => current?.targetId === targetId ? null : current);
      setError(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusyId(null);
    }
  }, [selectedId]);

  const refreshProjects = useCallback(async () => {
    if (!selectedTarget) return;
    setBusyId(selectedTarget.id);
    try {
      const next = await window.ade.remoteRuntime.listProjects(selectedTarget.id);
      setProjects(next);
      setProjectInspections({});
      setPendingOpen(null);
      setError(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusyId(null);
    }
  }, [selectedTarget]);

  const registerProject = useCallback(async () => {
    if (!selectedTarget) return;
    const rootPath = remoteProjectPath.trim();
    if (!rootPath) return;
    setRegisteringProject(true);
    try {
      const project = await window.ade.remoteRuntime.addProject(selectedTarget.id, rootPath);
      setProjects((current) => [project, ...current.filter((candidate) => candidate.projectId !== project.projectId)]);
      setConnected((current) => current && current.target.id === selectedTarget.id
        ? {
          ...current,
          projects: [project, ...current.projects.filter((candidate) => candidate.projectId !== project.projectId)],
        }
        : current);
      setRemoteProjectPath("");
      setError(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setRegisteringProject(false);
    }
  }, [remoteProjectPath, selectedTarget]);

  const inspectProject = useCallback(async (project: RemoteRuntimeProjectRecord) => {
    if (!selectedTarget) return;
    setProjectInspections((current) => ({
      ...current,
      [project.projectId]: { loading: true, laneCount: null, error: null },
    }));
    try {
      const result = await window.ade.remoteRuntime.callAction(selectedTarget.id, project.projectId, {
        domain: "lane",
        action: "list",
        args: { includeArchived: false, includeStatus: false },
      });
      const lanes = Array.isArray(result.result) ? result.result : [];
      setProjectInspections((current) => ({
        ...current,
        [project.projectId]: { loading: false, laneCount: lanes.length, error: null },
      }));
      setError(null);
    } catch (err) {
      const message = extractError(err);
      setProjectInspections((current) => ({
        ...current,
        [project.projectId]: { loading: false, laneCount: null, error: message },
      }));
    }
  }, [selectedTarget]);

  const openProject = useCallback(async (project: RemoteRuntimeProjectRecord) => {
    if (!selectedTarget) return;
    const target = selectedTarget;
    setBusyId(target.id);
    try {
      const localWork = await window.ade.remoteRuntime.checkLocalWork(project);
      if (localWork.hasDirtyWork) {
        setPendingOpen({
          targetId: target.id,
          runtimeName: target.name,
          project,
          localWork,
        });
        setError(null);
        return;
      }
      await switchRemoteProject(target.id, project.projectId);
      setError(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusyId(null);
    }
  }, [selectedTarget, switchRemoteProject]);

  const confirmPendingOpen = useCallback(async () => {
    if (!pendingOpen) return;
    setOpeningPendingProject(true);
    setBusyId(pendingOpen.targetId);
    try {
      await switchRemoteProject(pendingOpen.targetId, pendingOpen.project.projectId);
      setPendingOpen(null);
      setError(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setOpeningPendingProject(false);
      setBusyId(null);
    }
  }, [pendingOpen, switchRemoteProject]);

  return (
    <div style={panelStyle}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(300px,0.8fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <div style={sectionStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ ...LABEL_STYLE, color: COLORS.textMuted }}>REMOTE MACHINES</div>
                <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
                  Connect over SSH
                </div>
              </div>
              <DesktopTower size={22} weight="duotone" color={COLORS.accent} />
            </div>
            {loading ? (
              <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12 }}>Loading machines...</div>
            ) : targets.length === 0 ? (
              <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 13 }}>
                No remote machines saved yet.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {targets.map((target) => {
                  const active = selectedId === target.id;
                  return (
                    <button
                      key={target.id}
                      type="button"
                      onClick={() => {
                        setSelectedId(target.id);
                        setProjects([]);
                        setConnected(null);
                        setProjectInspections({});
                        setPendingOpen(null);
                      }}
                      style={{
                        display: "grid",
                        gap: 6,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                        background: active ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "rgba(255,255,255,0.02)",
                        color: COLORS.textPrimary,
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 700 }}>{target.name}</span>
                        {connected?.target.id === target.id ? <CheckCircle size={16} weight="fill" color={COLORS.success} /> : null}
                      </div>
                      <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11 }}>
                        {targetConnectionLabel(target)}
                      </span>
                      <span style={{ color: COLORS.textDim, fontFamily: SANS_FONT, fontSize: 11 }}>
                        {formatLastSeen(target.lastConnectedAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div style={sectionStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ ...LABEL_STYLE, color: COLORS.textMuted }}>NEARBY MACHINES</div>
                <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
                  LAN and Tailscale discovery
                </div>
              </div>
              <button
                type="button"
                disabled={loadingDiscovered}
                onClick={() => void loadDiscoveredMachines()}
                style={{
                  ...outlineButton({ height: 30, padding: "0 10px", fontSize: 11 }),
                  opacity: loadingDiscovered ? 0.6 : 1,
                }}
              >
                Refresh
              </button>
            </div>
            {discoveryError ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12 }}>
                <Warning size={15} weight="fill" />
                {discoveryError}
              </div>
            ) : null}
            {loadingDiscovered ? (
              <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12 }}>Scanning nearby machines...</div>
            ) : discoveredMachines.length === 0 ? (
              <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 13 }}>
                No nearby ADE machines found.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {discoveredMachines.map((machine) => {
                  const route = discoveredRoute(machine);
                  return (
                    <div
                      key={machine.id}
                      style={{
                        display: "grid",
                        gap: 6,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: `1px solid ${COLORS.border}`,
                        background: "rgba(255,255,255,0.02)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 12, fontWeight: 700 }}>
                            {machine.machineName}
                          </div>
                          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {route ? `${route}:${machine.port}` : "No route advertised"}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={!route}
                          onClick={() => applyDiscoveredRoute(machine)}
                          style={{
                            ...outlineButton({ height: 28, padding: "0 10px", fontSize: 11 }),
                            opacity: route ? 1 : 0.55,
                            flexShrink: 0,
                          }}
                        >
                          Use host
                        </button>
                      </div>
                      <div style={{ color: COLORS.textDim, fontFamily: SANS_FONT, fontSize: 11 }}>
                        {discoveredRuntimeLabel(machine)} | {discoveredProjectLabel(machine)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div style={sectionStyle}>
          <div>
            <div style={{ ...LABEL_STYLE, color: COLORS.textMuted }}>ADD MACHINE</div>
            <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
              SSH target
            </div>
          </div>
          <RemoteTargetForm busy={saving || busyId != null} prefill={formPrefill} onSubmit={saveAndConnect} />
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ ...LABEL_STYLE, color: COLORS.textMuted }}>PROJECTS</div>
            <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
              {selectedTarget ? selectedTarget.name : "Select a machine"}
            </div>
          </div>
          {selectedTarget ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                style={primaryButton({ height: 32, padding: "0 12px", fontSize: 12 })}
                disabled={busyId != null}
                onClick={() => void connectTarget(selectedTarget.id)}
              >
                <PlugsConnected size={15} weight="bold" />
                Connect
              </button>
              <button
                type="button"
                style={outlineButton({ height: 32, padding: "0 12px", fontSize: 12 })}
                disabled={busyId != null}
                onClick={() => void refreshProjects()}
              >
                Refresh
              </button>
              <button
                type="button"
                aria-label="Remove remote machine"
                style={outlineButton({ height: 32, padding: "0 10px", fontSize: 12 })}
                disabled={busyId != null}
                onClick={() => void removeTarget(selectedTarget.id)}
              >
                <Trash size={15} />
              </button>
            </div>
          ) : null}
        </div>

        {error ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12 }}>
            <Warning size={15} weight="fill" />
            {error}
          </div>
        ) : null}

        {connected ? (
          <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
            ADE service {connected.version ?? "unknown"} on {connected.arch}. {projects.length} project{projects.length === 1 ? "" : "s"} available.
          </div>
        ) : selectedTarget ? (
          <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
            Connect to list projects on this machine.
          </div>
        ) : null}

        {selectedTarget ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void registerProject();
            }}
            style={{ display: "flex", alignItems: "end", gap: 10 }}
          >
            <label style={{ display: "grid", gap: 6, minWidth: 0, flex: 1 }}>
              <span style={LABEL_STYLE}>Remote project path</span>
              <input
                value={remoteProjectPath}
                onChange={(event) => setRemoteProjectPath(event.target.value)}
                placeholder="/Users/ade/my-project"
                disabled={busyId != null || registeringProject}
                style={{
                  width: "100%",
                  height: 34,
                  borderRadius: 8,
                  border: `1px solid ${COLORS.border}`,
                  background: "rgba(255,255,255,0.03)",
                  color: COLORS.textPrimary,
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                  padding: "0 10px",
                  outline: "none",
                }}
              />
            </label>
            <button
              type="submit"
              disabled={busyId != null || registeringProject || remoteProjectPath.trim().length === 0}
              style={{
                ...outlineButton({ height: 34, padding: "0 12px", fontSize: 12 }),
                opacity: busyId == null && !registeringProject && remoteProjectPath.trim().length > 0 ? 1 : 0.55,
              }}
            >
              {registeringProject ? "Registering..." : "Register project"}
            </button>
          </form>
        ) : null}

        {projects.length > 0 ? (
          <div style={{ display: "grid", gap: 8 }}>
            {projects.map((project) => {
              const inspection = projectInspections[project.projectId] ?? null;
              return (
                <div
                  key={project.projectId}
                  style={{
                    display: "grid",
                    gap: 6,
                    borderRadius: 8,
                    border: `1px solid ${COLORS.border}`,
                    background: "rgba(255,255,255,0.02)",
                    padding: "10px 12px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 12, fontWeight: 700 }}>
                        {projectLabel(project)}
                      </div>
                      <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {project.rootPath}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                      <button
                        type="button"
                        disabled={!selectedTarget || busyId != null}
                        onClick={() => void openProject(project)}
                        style={{
                          ...primaryButton({ height: 28, padding: "0 10px", fontSize: 11 }),
                          opacity: busyId != null ? 0.6 : 1,
                        }}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        disabled={!selectedTarget || inspection?.loading}
                        onClick={() => void inspectProject(project)}
                        style={{
                          ...outlineButton({ height: 28, padding: "0 10px", fontSize: 11 }),
                          opacity: inspection?.loading ? 0.6 : 1,
                        }}
                      >
                        {inspection?.loading ? "Inspecting..." : "Inspect"}
                      </button>
                    </div>
                  </div>
                  {inspection?.laneCount != null ? (
                    <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
                      {inspection.laneCount} lane{inspection.laneCount === 1 ? "" : "s"} available on this remote project.
                    </div>
                  ) : null}
                  {inspection?.error ? (
                    <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12 }}>
                      {inspection.error}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      {pendingOpen ? (
        <RemoteProjectOpenDialog
          project={pendingOpen.project}
          localWork={pendingOpen.localWork}
          runtimeName={pendingOpen.runtimeName}
          busy={openingPendingProject}
          onCancel={() => setPendingOpen(null)}
          onContinue={() => void confirmPendingOpen()}
        />
      ) : null}
    </div>
  );
}
