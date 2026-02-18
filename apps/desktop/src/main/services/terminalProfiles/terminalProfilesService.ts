import type { AdeDb } from "../state/kvDb";
import type { TerminalLaunchProfile, TerminalProfilesSnapshot } from "../../../shared/types";

const KEY = "terminalProfiles:snapshot";

const DEFAULT_PROFILES: TerminalLaunchProfile[] = [
  {
    id: "shell",
    name: "Shell",
    command: "",
    tracked: true,
    description: "Normal terminal shell in this lane"
  },
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    tracked: true,
    description: "Launch Claude Code in this lane"
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    tracked: true,
    description: "Launch Codex in this lane"
  },
  {
    id: "aider",
    name: "Aider",
    command: "aider",
    tracked: true,
    description: "Launch Aider in this lane"
  }
];

function sanitizeProfiles(profiles: TerminalLaunchProfile[]): TerminalLaunchProfile[] {
  const seen = new Set<string>();
  const out: TerminalLaunchProfile[] = [];
  for (const raw of profiles) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    const command = typeof raw?.command === "string" ? raw.command : "";
    const tracked = typeof raw?.tracked === "boolean" ? raw.tracked : true;
    const description = typeof raw?.description === "string" ? raw.description : null;
    if (!id || !name) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, command, tracked, description });
  }
  return out.slice(0, 50);
}

function mergeDefaults(stored: TerminalProfilesSnapshot | null): TerminalProfilesSnapshot {
  const base = stored ?? { profiles: [], defaultProfileId: null };
  const profiles = sanitizeProfiles(base.profiles ?? []);

  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
  for (const profile of DEFAULT_PROFILES) {
    if (!byId.has(profile.id)) {
      profiles.unshift(profile);
      byId.set(profile.id, profile);
    }
  }

  const defaultProfileIdRaw = typeof base.defaultProfileId === "string" ? base.defaultProfileId.trim() : "";
  const defaultProfileId = defaultProfileIdRaw && byId.has(defaultProfileIdRaw) ? defaultProfileIdRaw : "shell";

  return { profiles, defaultProfileId };
}

export function createTerminalProfilesService({ db }: { db: AdeDb }) {
  return {
    get(): TerminalProfilesSnapshot {
      const stored = db.getJson<TerminalProfilesSnapshot>(KEY);
      return mergeDefaults(stored ?? null);
    },

    set(snapshot: TerminalProfilesSnapshot): TerminalProfilesSnapshot {
      const merged = mergeDefaults(snapshot ?? null);
      db.setJson(KEY, merged);
      return merged;
    }
  };
}

