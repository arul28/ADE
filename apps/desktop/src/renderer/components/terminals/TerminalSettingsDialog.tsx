import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, Trash, X } from "@phosphor-icons/react";
import type { TerminalLaunchProfile, TerminalProfilesSnapshot } from "../../../shared/types";
import { DEFAULT_PROFILE_IDS } from "../../lib/sessions";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

const LAUNCH_TRACKED_KEY = "ade.terminals.launchTracked";

const PROFILE_COLORS = [
  null,
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
] as const;

function isDefaultProfile(profile: TerminalLaunchProfile): boolean {
  return (DEFAULT_PROFILE_IDS as readonly string[]).includes(profile.id);
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniqueProfileId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 50; i += 1) {
    const next = `${base}-${i}`;
    if (!existing.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

export function readLaunchTracked(): boolean {
  try {
    const raw = window.localStorage.getItem(LAUNCH_TRACKED_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch { /* ignore */ }
  return true;
}

export function persistLaunchTracked(value: boolean) {
  try {
    window.localStorage.setItem(LAUNCH_TRACKED_KEY, value ? "1" : "0");
  } catch { /* ignore */ }
}

export function TerminalSettingsDialog({
  open,
  onOpenChange,
  terminalProfiles,
  onProfilesSaved,
  launchTracked,
  onLaunchTrackedChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  terminalProfiles: TerminalProfilesSnapshot | null;
  onProfilesSaved: (next: TerminalProfilesSnapshot) => void;
  launchTracked: boolean;
  onLaunchTrackedChange: (value: boolean) => void;
}) {
  const [profileDraft, setProfileDraft] = useState<TerminalLaunchProfile[]>([]);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileCommand, setNewProfileCommand] = useState("");
  const [profilesBusy, setProfilesBusy] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setProfilesError(null);
      setProfileDraft([...(terminalProfiles?.profiles ?? [])]);
      setNewProfileName("");
      setNewProfileCommand("");
    }
  }, [open, terminalProfiles]);

  const saveProfiles = useCallback(async () => {
    if (!terminalProfiles) return;
    setProfilesBusy(true);
    setProfilesError(null);
    try {
      const next = await window.ade.terminalProfiles.set({
        profiles: profileDraft,
        defaultProfileId: terminalProfiles.defaultProfileId ?? "shell",
      });
      onProfilesSaved(next);
      onOpenChange(false);
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : String(err));
    } finally {
      setProfilesBusy(false);
    }
  }, [terminalProfiles, profileDraft, onProfilesSaved, onOpenChange]);

  const addProfile = useCallback(() => {
    const name = newProfileName.trim();
    const command = newProfileCommand.trim();
    if (!name || !command) {
      setProfilesError("Name and command are required.");
      return;
    }
    const existing = new Set(profileDraft.map((p) => p.id));
    const base = slugify(name) || "custom";
    const id = uniqueProfileId(base, existing);
    setProfileDraft((prev) => [...prev, { id, name, command, tracked: true, description: null, color: null }]);
    setNewProfileName("");
    setNewProfileCommand("");
    setProfilesError(null);
  }, [newProfileName, newProfileCommand, profileDraft]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[12%] z-50 w-[min(880px,calc(100vw-24px))] -translate-x-1/2 rounded-lg border border-border/30 bg-card p-4 shadow-2xl focus:outline-none">
          <div className="mb-3 flex items-center justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold">Terminal Settings</Dialog.Title>
            <Dialog.Description className="sr-only">
              Configure launch profiles and whether new terminals collect context.
            </Dialog.Description>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">Close</Button>
            </Dialog.Close>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-border/15 bg-bg/40 p-3 text-xs">
              <div className="text-xs font-semibold text-muted-fg">Launch mode</div>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={launchTracked}
                  onChange={(e) => {
                    const next = e.target.checked;
                    onLaunchTrackedChange(next);
                    persistLaunchTracked(next);
                  }}
                />
                <span className="text-fg">Launch terminals with context (tracked transcripts + pack refresh)</span>
              </label>
              <div className="mt-1 text-xs text-muted-fg">
                If disabled, terminals still run normally but do not produce transcripts or pack updates.
              </div>
            </div>

            <div className="rounded-lg border border-border/15 bg-bg/40 p-3 text-xs">
              <div className="text-xs font-semibold text-muted-fg">Terminal buttons</div>
              <div className="mt-2 grid grid-cols-1 gap-2">
                {profileDraft.length === 0 ? (
                  <div className="text-xs text-muted-fg">No profiles loaded.</div>
                ) : (
                  profileDraft.map((p) => {
                    const locked = isDefaultProfile(p);
                    return (
                      <div key={p.id} className="rounded-lg border border-border/15 bg-card/50 p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="min-w-[140px] text-xs text-muted-fg">{p.id}</div>
                          <input
                            className="h-8 flex-1 min-w-[180px] rounded border border-border/15 bg-bg/40 px-2 text-xs text-fg outline-none"
                            value={p.name}
                            onChange={(e) =>
                              setProfileDraft((prev) => prev.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))
                            }
                            placeholder="Name"
                          />
                          <input
                            className="h-8 flex-[2] min-w-[220px] rounded border border-border/15 bg-bg/40 px-2 text-xs text-fg font-mono outline-none"
                            value={p.command}
                            onChange={(e) =>
                              setProfileDraft((prev) => prev.map((x) => (x.id === p.id ? { ...x, command: e.target.value } : x)))
                            }
                            placeholder="Command"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2 text-xs"
                            disabled={locked}
                            onClick={() => setProfileDraft((prev) => prev.filter((x) => x.id !== p.id))}
                            title={locked ? "Default buttons cannot be removed" : "Remove button"}
                          >
                            <Trash size={16} />
                          </Button>
                        </div>
                        <div className="mt-1.5 flex items-center gap-1">
                          <span className="text-[11px] text-muted-fg mr-1">Color</span>
                          {PROFILE_COLORS.map((c) => (
                            <button
                              key={c ?? "none"}
                              type="button"
                              className={cn(
                                "h-5 w-5 rounded-full border-2 transition-transform hover:scale-110",
                                (p.color ?? null) === c ? "border-fg scale-110" : "border-transparent",
                              )}
                              style={{ backgroundColor: c ?? "transparent" }}
                              onClick={() =>
                                setProfileDraft((prev) => prev.map((x) => (x.id === p.id ? { ...x, color: c } : x)))
                              }
                              title={c ?? "Default (no color)"}
                            >
                              {c == null ? <X className="h-3 w-3 mx-auto text-muted-fg" /> : null}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="mt-3 rounded-lg border border-border/15 bg-bg/40 p-2">
                <div className="text-xs font-semibold text-muted-fg">Add custom button</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="h-8 min-w-[180px] flex-1 rounded border border-border/15 bg-bg/40 px-2 text-xs text-fg outline-none"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    placeholder="Name (e.g., Dev Server)"
                  />
                  <input
                    className="h-8 min-w-[220px] flex-[2] rounded border border-border/15 bg-bg/40 px-2 text-xs text-fg font-mono outline-none"
                    value={newProfileCommand}
                    onChange={(e) => setNewProfileCommand(e.target.value)}
                    placeholder="Command (e.g., npm run dev)"
                  />
                  <Button size="sm" variant="primary" className="h-8 px-2 text-xs" onClick={addProfile}>
                    <Plus size={12} className="mr-1" />
                    Add
                  </Button>
                </div>
              </div>

              {profilesError ? (
                <div className="mt-2 rounded-lg border border-red-900 bg-red-950/20 p-2 text-xs text-red-300">
                  {profilesError}
                </div>
              ) : null}

              <div className="mt-3 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={profilesBusy}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={() => void saveProfiles()} disabled={profilesBusy}>
                  {profilesBusy ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
