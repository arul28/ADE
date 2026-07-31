import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowClockwise,
  ChatCircleDots,
  Check,
  CircleNotch,
  DesktopTower,
  FolderOpen,
  GearSix,
  SignIn,
  SignOut,
  Trash,
  X,
} from "@phosphor-icons/react";
import {
  accountMachineConnectionState,
  accountMachineDisplayName,
} from "../../../shared/accountDirectory";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { WebClientEnvironmentRecord } from "../sync";
import { browserAccountIsSignedIn } from "../account/client";
import { cn } from "../../components/ui/cn";
import { useWebWorkspace } from "./WebWorkspaceContext";
import type { WebMachineSessionSnapshot } from "./WebMachineSessionManager";

type HubMachine = {
  key: string;
  name: string;
  accountMachine: AdeAccountMachine | null;
  environment: WebClientEnvironmentRecord | null;
  session: WebMachineSessionSnapshot | null;
};

function mergeMachines(
  accountMachines: AdeAccountMachine[],
  environments: WebClientEnvironmentRecord[],
  sessions: WebMachineSessionSnapshot[],
): HubMachine[] {
  const byIdentity = new Map<string, HubMachine>();
  const identityForEnvironment = (environment: WebClientEnvironmentRecord) =>
    environment.hostDeviceId ? `device:${environment.hostDeviceId}` : `environment:${environment.envId}`;

  for (const environment of environments) {
    const identity = identityForEnvironment(environment);
    byIdentity.set(identity, {
      key: identity,
      name: environment.machineName,
      accountMachine: null,
      environment,
      session: sessions.find((entry) => entry.targetId === environment.envId) ?? null,
    });
  }
  for (const machine of accountMachines) {
    const identity = machine.deviceId ? `device:${machine.deviceId}` : `account:${machine.machineKey}`;
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, {
      key: identity,
      name: accountMachineDisplayName(machine) ?? existing?.name ?? "Unnamed machine",
      accountMachine: machine,
      environment: existing?.environment ?? null,
      session: existing?.session ?? null,
    });
  }
  return [...byIdentity.values()].sort((a, b) => {
    const rank = (machine: HubMachine) => {
      if (machine.session?.state === "live") return 0;
      if (machine.session?.state === "reconnecting") return 1;
      if (machine.session?.state === "parked") return 2;
      return 3;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
}

function statusForMachine(machine: HubMachine): {
  label: "Live" | "Reconnecting" | "Parked" | "Offline";
  className: string;
} {
  switch (machine.session?.state) {
    case "live":
      return { label: "Live", className: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.65)]" };
    case "reconnecting":
      return { label: "Reconnecting", className: "bg-amber-400 animate-pulse" };
    case "parked":
      return { label: "Parked", className: "bg-sky-400/80" };
    default:
      return { label: "Offline", className: "bg-muted-fg/45" };
  }
}

function lastSeen(machine: HubMachine): string {
  const value = machine.accountMachine?.lastSeenAt;
  if (value == null) {
    return machine.environment?.lastConnectedAt
      ? `Connected ${new Date(machine.environment.lastConnectedAt).toLocaleString()}`
      : "Not connected in this browser";
  }
  return `Last seen ${new Date(value).toLocaleString()}`;
}

export function WebWorkspaceHub() {
  const navigate = useNavigate();
  const {
    account,
    snapshot,
    adapter,
    connectingMachineKey,
    directoryLoading,
    notice,
    dismissNotice,
    consumePendingProjectPath,
    signIn,
    signOut,
    retryDirectory,
    connectAccountMachine,
    connectEnvironment,
    renameMachine,
    removeAccountMachine,
    forgetEnvironment,
  } = useWebWorkspace();
  const machines = useMemo(
    () => mergeMachines(account.machines, snapshot.environments, snapshot.sessions),
    [account.machines, snapshot.environments, snapshot.sessions],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(() => {
    const savedTargetId = adapter.getSelectedHubTargetId();
    if (!savedTargetId) return null;
    const environment = snapshot.environments.find((entry) => entry.envId === savedTargetId);
    return environment?.hostDeviceId
      ? `device:${environment.hostDeviceId}`
      : environment
        ? `environment:${environment.envId}`
        : null;
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);

  const selected = machines.find((entry) => entry.key === selectedKey)
    ?? machines.find((entry) => entry.session?.state === "live")
    ?? machines[0]
    ?? null;

  useEffect(() => {
    if (!selected) return;
    if (selectedKey !== selected.key) setSelectedKey(selected.key);
    adapter.setSelectedHubTargetId(selected.environment?.envId ?? null);
    setRenameValue(selected.name);
  }, [adapter, selected, selectedKey]);

  const connect = async (machine: HubMachine): Promise<string> => {
    if (machine.session?.state === "live") return machine.session.targetId;
    setBusyKey(machine.key);
    setError(null);
    try {
      if (machine.environment) {
        await connectEnvironment(machine.environment.envId);
        return machine.environment.envId;
      }
      if (machine.accountMachine) {
        return await connectAccountMachine(machine.accountMachine);
      }
      throw new Error("This machine has no available connection.");
    } finally {
      setBusyKey(null);
    }
  };

  const selectMachine = (machine: HubMachine) => {
    setSelectedKey(machine.key);
    setManageOpen(false);
    adapter.setSelectedHubTargetId(machine.environment?.envId ?? null);
    if (!machine.session && machine.environment) {
      void connect(machine).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    }
  };

  const projects = selected?.session?.projects ?? [];
  const accountSignedIn = browserAccountIsSignedIn(account.state);
  const directoryUnavailable = account.state === "directory_unavailable";

  useEffect(() => {
    adapter.activateHub();
  }, [adapter]);

  return (
    <div className="h-full min-h-0 w-full overflow-auto bg-bg px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto flex h-full min-h-[520px] w-full max-w-[1180px] flex-col gap-4">
        <header className="flex shrink-0 items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
              Workspace hub
            </div>
            <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-fg">
              Machines and projects
            </h1>
            <p className="mt-1 max-w-2xl text-[12px] leading-5 text-muted-fg">
              Choose a machine once, then keep its repositories open as tabs.
            </p>
          </div>
          {accountSignedIn ? (
            <button
              type="button"
              onClick={() => void signOut()}
              className="ade-shell-control inline-flex h-8 items-center gap-2 px-3 text-[11px]"
              data-variant="ghost"
            >
              <SignOut size={13} />
              Sign out
            </button>
          ) : account.state !== "unconfigured" ? (
            <button
              type="button"
              onClick={signIn}
              className="inline-flex h-8 items-center gap-2 rounded-md bg-accent px-3 text-[11px] font-semibold text-accent-fg transition hover:bg-accent/90"
            >
              <SignIn size={13} weight="bold" />
              Sign in
            </button>
          ) : null}
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-2xl border border-border/80 bg-card/55 shadow-[0_18px_60px_rgba(0,0,0,0.22)] backdrop-blur md:grid-cols-[minmax(230px,0.72fr)_minmax(0,1.55fr)]">
          <section className="flex min-h-[210px] flex-col border-b border-border/80 bg-fg/[0.018] md:min-h-0 md:border-b-0 md:border-r">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-3.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-fg">
                Machines
              </span>
              <button
                type="button"
                onClick={() => void retryDirectory()}
                disabled={directoryLoading}
                className="ade-shell-control inline-flex h-6 w-6 items-center justify-center"
                data-variant="ghost"
                title="Refresh machines"
              >
                <ArrowClockwise size={12} className={directoryLoading ? "animate-spin" : undefined} />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
              {machines.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-[11px] leading-5 text-muted-fg">
                  {accountSignedIn
                    ? "No machines are connected to this account yet."
                    : "Sign in to see your machines."}
                </div>
              ) : machines.map((machine) => {
                const status = statusForMachine(machine);
                const active = machine.key === selected?.key;
                const connecting = busyKey === machine.key
                  || connectingMachineKey === machine.accountMachine?.machineKey;
                return (
                  <button
                    key={machine.key}
                    type="button"
                    onClick={() => selectMachine(machine)}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition",
                      active
                        ? "border-accent/45 bg-accent/10 text-fg shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_10%,transparent)]"
                        : "border-transparent text-muted-fg hover:border-border/80 hover:bg-fg/[0.035] hover:text-fg",
                    )}
                  >
                    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-bg/70">
                      <DesktopTower size={16} weight="duotone" />
                      <span className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card", status.className)} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-semibold">{machine.name}</span>
                      <span className="mt-0.5 block truncate text-[9px] uppercase tracking-[0.08em] opacity-70">
                        {connecting ? "Reconnecting" : status.label}
                        {machine.accountMachine && machine.environment ? " · Account + browser" : machine.accountMachine ? " · Account" : " · This browser"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="shrink-0 border-t border-border/70 p-2">
              <button
                type="button"
                disabled={!selected}
                onClick={() => setManageOpen((value) => !value)}
                className="ade-shell-control flex h-8 w-full items-center justify-center gap-2 text-[11px]"
                data-variant="ghost"
              >
                <GearSix size={13} />
                Manage selected machine
              </button>
            </div>
          </section>

          <section className="flex min-h-[320px] min-w-0 flex-col">
            <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4">
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold text-fg">
                  {selected?.name ?? "Projects"}
                </div>
                <div className="truncate text-[9px] text-muted-fg">
                  {selected ? lastSeen(selected) : "Choose a machine to continue"}
                </div>
              </div>
              {selected ? (
                <button
                  type="button"
                  onClick={() => {
                    void connect(selected).catch((cause) => {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    });
                  }}
                  disabled={busyKey === selected.key || selected.session?.state === "live"}
                  className="ade-shell-control inline-flex h-7 items-center gap-2 px-2.5 text-[10px]"
                  data-variant="ghost"
                >
                  {busyKey === selected.key ? <CircleNotch size={12} className="animate-spin" /> : <ArrowClockwise size={12} />}
                  {selected.session?.state === "live" ? "Connected" : "Reconnect"}
                </button>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4">
              {error ? (
                <div role="alert" className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-red-400/25 bg-red-500/8 px-3 py-2.5 text-[11px] text-red-200">
                  <span>{error}</span>
                  <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100"><X size={12} /></button>
                </div>
              ) : null}

              {manageOpen && selected ? (
                <div className="mb-4 rounded-xl border border-border/80 bg-bg/45 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold text-fg">Machine details</div>
                      <div className="mt-0.5 text-[9px] text-muted-fg">{lastSeen(selected)}</div>
                    </div>
                    <button type="button" onClick={() => setManageOpen(false)} className="ade-shell-control inline-flex h-6 w-6 items-center justify-center" data-variant="ghost"><X size={11} /></button>
                  </div>
                  {selected.accountMachine ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        className="h-8 min-w-[180px] flex-1 rounded-md border border-border bg-bg px-2.5 text-[11px] text-fg outline-none transition focus:border-accent/70"
                        aria-label="Machine name"
                      />
                      <button
                        type="button"
                        disabled={renaming || renameValue.trim() === selected.name}
                        onClick={() => {
                          const machineKey = selected.accountMachine?.machineKey;
                          if (!machineKey) return;
                          setRenaming(true);
                          void renameMachine(machineKey, renameValue.trim() || null)
                            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                            .finally(() => setRenaming(false));
                        }}
                        className="ade-shell-control inline-flex h-8 items-center gap-1.5 px-2.5 text-[10px]"
                        data-variant="ghost"
                      >
                        <Check size={12} />
                        Save
                      </button>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selected.environment ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (!window.confirm(`Forget ${selected.name} on this browser?`)) return;
                          void forgetEnvironment(selected.environment!.envId)
                            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                        }}
                        className="ade-shell-control inline-flex h-8 items-center gap-2 px-2.5 text-[10px]"
                        data-variant="ghost"
                      >
                        <Trash size={12} />
                        Forget on this browser
                      </button>
                    ) : null}
                    {selected.accountMachine ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (!window.confirm(`Remove ${selected.name} from your ADE account?`)) return;
                          void removeAccountMachine(selected.accountMachine!.machineKey)
                            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                        }}
                        className="inline-flex h-8 items-center gap-2 rounded-md border border-red-400/25 bg-red-500/8 px-2.5 text-[10px] text-red-200 transition hover:bg-red-500/14"
                      >
                        <Trash size={12} />
                        Remove from account
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {selected ? (
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-fg">
                    Projects
                  </div>
                  <button
                    type="button"
                    disabled={!selected.environment && !selected.accountMachine}
                    onClick={() => {
                      void connect(selected)
                        .then(async (targetId) => {
                          await adapter.activateChats(targetId);
                          navigate("/chats");
                        })
                        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                    }}
                    className="ade-shell-control inline-flex h-7 items-center gap-2 px-2.5 text-[10px]"
                    data-variant="ghost"
                  >
                    <ChatCircleDots size={13} weight="duotone" />
                    Chats on this machine
                  </button>
                </div>
              ) : null}

              {selected && projects.length > 0 ? (
                <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => {
                        void connect(selected)
                          .then((targetId) => adapter.openProject(targetId, project.id))
                          .then(() => navigate(consumePendingProjectPath() ?? "/work"))
                          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                      }}
                      className="group flex min-w-0 items-center gap-3 rounded-xl border border-border/75 bg-fg/[0.018] px-3 py-3 text-left transition hover:border-accent/40 hover:bg-accent/[0.055]"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-bg/70 text-accent">
                        {project.iconDataUrl ? (
                          <img src={project.iconDataUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <FolderOpen size={17} weight="duotone" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-semibold text-fg">{project.displayName}</span>
                        <span className="mt-0.5 block truncate text-[9px] text-muted-fg">
                          {project.rootPath ?? "Remote project"} · {project.laneCount} lane{project.laneCount === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-accent opacity-0 transition group-hover:opacity-100">
                        Open
                      </span>
                    </button>
                  ))}
                </div>
              ) : selected && (busyKey === selected.key || selected.session?.state === "reconnecting") ? (
                <div className="flex h-40 items-center justify-center gap-2 text-[11px] text-muted-fg">
                  <CircleNotch size={14} className="animate-spin text-accent" />
                  Loading projects…
                </div>
              ) : selected ? (
                <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border text-center">
                  <DesktopTower size={22} weight="duotone" className="mb-2 text-muted-fg" />
                  <div className="text-[11px] font-medium text-fg">
                    {selected.session?.state === "live" ? "No projects found" : "Connect to view projects"}
                  </div>
                  <div className="mt-1 max-w-sm text-[10px] leading-4 text-muted-fg">
                    Parked and offline machines reconnect only when you open them.
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>

        {notice ? (
          <div
            role="status"
            className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-amber-500/7 px-3 py-2 text-[10px] text-amber-100/80"
          >
            <span>{notice}</span>
            <button type="button" onClick={dismissNotice} className="font-semibold text-amber-200 hover:text-amber-100">
              Dismiss
            </button>
          </div>
        ) : directoryUnavailable ? (
          <div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-amber-500/7 px-3 py-2 text-[10px] text-amber-100/80">
            <span>Your account directory is temporarily unavailable. Browser-saved machines still work.</span>
            <button type="button" onClick={() => void retryDirectory()} className="font-semibold text-amber-200 hover:text-amber-100">Retry</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
