// ---------------------------------------------------------------------------
// Execution targets — where agent/chat work is intended to run (local vs SSH).
// Tool execution on remote hosts is not fully wired yet; UI + metadata first.
// ---------------------------------------------------------------------------

export type AdeExecutionTargetKind = "local" | "ssh";

/** Stable id; use "local" for the primary machine running ADE. */
export type AdeExecutionTargetId = string;

export type AdeSshExecutionTargetProfile = {
  id: AdeExecutionTargetId;
  kind: "ssh";
  /** Short display name, e.g. "GPU VM" */
  label: string;
  /** SSH destination, e.g. user@host or token host from Daytona */
  sshHost: string;
  /** Optional jump / ProxyJump host */
  jumpHost?: string;
  /** Working directory on the remote for this repo */
  workspacePath: string;
  /**
   * How ADE will run tools when implemented.
   * `ssh-shell` — commands over SSH; `ade-runner` — headless ADE on remote; `planned` — not connected yet.
   */
  connectionMode: "ssh-shell" | "ade-runner" | "planned";
};

export type AdeLocalExecutionTargetProfile = {
  id: "local";
  kind: "local";
  label: string;
};

export type AdeExecutionTargetProfile = AdeLocalExecutionTargetProfile | AdeSshExecutionTargetProfile;

export type AdeExecutionTargetsState = {
  version: 1;
  /** User-defined and built-in targets (always includes `local`). */
  profiles: AdeExecutionTargetProfile[];
  /** Last-selected target for this project (workspace focus). */
  activeTargetId: AdeExecutionTargetId;
};

export const ADE_LOCAL_EXECUTION_TARGET_ID = "local" as const;

export function defaultExecutionTargetsState(): AdeExecutionTargetsState {
  return {
    version: 1,
    profiles: [{ id: ADE_LOCAL_EXECUTION_TARGET_ID, kind: "local", label: "This computer" }],
    activeTargetId: ADE_LOCAL_EXECUTION_TARGET_ID,
  };
}

export function normalizeExecutionTargetsState(raw: unknown): AdeExecutionTargetsState {
  const fallback = defaultExecutionTargetsState();
  if (!raw || typeof raw !== "object") return fallback;
  const rec = raw as Partial<AdeExecutionTargetsState>;
  if (rec.version !== 1) return fallback;
  const profilesIn = Array.isArray(rec.profiles) ? rec.profiles : [];
  const profiles: AdeExecutionTargetProfile[] = [];
  const seenIds = new Set<AdeExecutionTargetId>();
  let sawLocal = false;
  for (const entry of profilesIn) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<AdeExecutionTargetProfile>;
    if (e.kind === "local" && e.id === ADE_LOCAL_EXECUTION_TARGET_ID) {
      if (sawLocal || seenIds.has(ADE_LOCAL_EXECUTION_TARGET_ID)) continue;
      const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : "This computer";
      profiles.push({ id: ADE_LOCAL_EXECUTION_TARGET_ID, kind: "local", label });
      seenIds.add(ADE_LOCAL_EXECUTION_TARGET_ID);
      sawLocal = true;
      continue;
    }
    if (e.kind === "ssh" && typeof e.id === "string" && e.id.trim()) {
      const id = e.id.trim();
      if (id === ADE_LOCAL_EXECUTION_TARGET_ID || seenIds.has(id)) continue;
      const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : id;
      const sshHost = typeof e.sshHost === "string" ? e.sshHost.trim() : "";
      const workspacePath = typeof e.workspacePath === "string" ? e.workspacePath.trim() : "";
      const jumpHost = typeof e.jumpHost === "string" && e.jumpHost.trim() ? e.jumpHost.trim() : undefined;
      const mode = e.connectionMode === "ade-runner" || e.connectionMode === "planned" ? e.connectionMode : "ssh-shell";
      if (!sshHost || !workspacePath) continue;
      profiles.push({
        id,
        kind: "ssh",
        label,
        sshHost,
        workspacePath,
        ...(jumpHost ? { jumpHost } : {}),
        connectionMode: mode,
      });
      seenIds.add(id);
    }
  }
  if (!sawLocal) {
    profiles.unshift({ id: ADE_LOCAL_EXECUTION_TARGET_ID, kind: "local", label: "This computer" });
  }
  const activeRaw = typeof rec.activeTargetId === "string" ? rec.activeTargetId.trim() : "";
  const activeTargetId = profiles.some((p) => p.id === activeRaw) ? activeRaw : ADE_LOCAL_EXECUTION_TARGET_ID;
  return { version: 1, profiles, activeTargetId };
}

export function executionTargetSummaryLabel(profile: AdeExecutionTargetProfile | undefined): string {
  if (!profile) return "Unknown target";
  if (profile.kind === "local") return profile.label || "This computer";
  return profile.label || profile.sshHost;
}
