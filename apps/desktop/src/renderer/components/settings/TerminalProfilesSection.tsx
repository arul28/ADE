import React from "react";
import { ArrowsClockwise, Plus, FloppyDisk } from "@phosphor-icons/react";
import type { TerminalLaunchProfile, TerminalProfilesSnapshot } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

function sanitizeId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export function TerminalProfilesSection() {
  const [snapshot, setSnapshot] = React.useState<TerminalProfilesSnapshot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [draftNew, setDraftNew] = React.useState<{ id: string; name: string; command: string }>({ id: "", name: "", command: "" });

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.ade.terminalProfiles.get();
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateProfile = (id: string, patch: Partial<TerminalLaunchProfile>) => {
    setSnapshot((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        profiles: prev.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p))
      };
    });
  };

  const save = async () => {
    if (!snapshot) return;
    setSaving(true);
    setError(null);
    try {
      const next = await window.ade.terminalProfiles.set(snapshot);
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const addProfile = () => {
    const id = sanitizeId(draftNew.id);
    const name = draftNew.name.trim();
    const command = draftNew.command;
    if (!snapshot) return;
    if (!id || !name) {
      setError("New profile requires id and name.");
      return;
    }
    if (snapshot.profiles.some((p) => p.id === id)) {
      setError(`Profile id '${id}' already exists.`);
      return;
    }
    setSnapshot({
      ...snapshot,
      profiles: [
        ...snapshot.profiles,
        { id, name, command, tracked: true, description: null }
      ]
    });
    setDraftNew({ id: "", name: "", command: "" });
  };

  return (
    <section className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Terminal Profiles</div>
          <div className="mt-0.5 text-xs text-muted-fg">
            Configure what runs when you click New in a lane terminal. This is the easiest way to launch Claude Code, Codex, etc. without extra steps.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
            <ArrowsClockwise size={16} weight="regular" className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
          <Button size="sm" disabled={saving || !snapshot} onClick={() => void save()}>
            <FloppyDisk size={16} weight="regular" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</div>
      ) : null}

      {!snapshot ? (
        <div className="mt-3 rounded-lg border border-border/10 bg-card/80 p-3 text-xs text-muted-fg">Loading profiles...</div>
      ) : (
        <div className="mt-3 space-y-2">
          {snapshot.profiles.map((profile) => (
            <div key={profile.id} className="rounded-lg border border-border/10 bg-card/80 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="h-8 w-[220px] rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                      value={profile.name}
                      onChange={(e) => updateProfile(profile.id, { name: e.target.value })}
                    />
                    <span className="text-[11px] text-muted-fg">
                      id: <span className="font-mono">{profile.id}</span>
                    </span>
                    <label className="ml-auto flex items-center gap-1 text-xs text-muted-fg">
                      <input
                        type="radio"
                        name="terminalProfileDefault"
                        checked={snapshot.defaultProfileId === profile.id}
                        onChange={() => setSnapshot({ ...snapshot, defaultProfileId: profile.id })}
                      />
                      default
                    </label>
                    <label className="flex items-center gap-1 text-xs text-muted-fg">
                      <input
                        type="checkbox"
                        checked={profile.tracked}
                        onChange={(e) => updateProfile(profile.id, { tracked: e.target.checked })}
                      />
                      tracked
                    </label>
                  </div>
                  <input
                    className="mt-2 h-8 w-full rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg font-mono"
                    placeholder="Command to run (leave empty for normal shell)"
                    value={profile.command}
                    onChange={(e) => updateProfile(profile.id, { command: e.target.value })}
                  />
                  <input
                    className="mt-2 h-8 w-full rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                    placeholder="Description (optional)"
                    value={profile.description ?? ""}
                    onChange={(e) => updateProfile(profile.id, { description: e.target.value })}
                  />
                </div>
              </div>
            </div>
          ))}

          <div className="rounded-lg border border-dashed border-border/20 bg-card/80 p-3">
            <div className="text-xs font-semibold text-fg">Add profile</div>
            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
              <input
                className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg font-mono"
                placeholder="id (e.g. cursor)"
                value={draftNew.id}
                onChange={(e) => setDraftNew((prev) => ({ ...prev, id: e.target.value }))}
              />
              <input
                className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                placeholder="name (e.g. Cursor)"
                value={draftNew.name}
                onChange={(e) => setDraftNew((prev) => ({ ...prev, name: e.target.value }))}
              />
              <input
                className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg font-mono"
                placeholder="command (e.g. cursor .)"
                value={draftNew.command}
                onChange={(e) => setDraftNew((prev) => ({ ...prev, command: e.target.value }))}
              />
            </div>
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="outline" onClick={addProfile} disabled={!snapshot}>
                <Plus size={16} weight="regular" />
                Add
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

