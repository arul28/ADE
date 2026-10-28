import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalShellOption, TerminalShellSettings } from "../../../shared/types/terminalShells";
import { Banner } from "../ui/notice";
import { ModernRow, ModernRows, ModernSection, SettingsSelect } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";

const AUTOMATIC = "__automatic__";

/** Windows ids name a kind, not a path; say them the way the picker does. */
const WINDOWS_SHELL_LABELS: Record<string, string> = {
  pwsh: "PowerShell 7",
  powershell: "Windows PowerShell",
  cmd: "Command Prompt",
  "git-bash": "Git Bash",
};

function savedShellLabel(id: string): string {
  return WINDOWS_SHELL_LABELS[id] ?? id;
}

function shellBaseName(value: string): string {
  return value.split(/[\\/]/).pop() || value;
}

/** Labels that two shells share ("bash" from Apple and from Homebrew) carry their path. */
function shellOptionLabels(shells: TerminalShellOption[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const shell of shells) counts.set(shell.label, (counts.get(shell.label) ?? 0) + 1);
  return new Map(shells.map((shell) => [
    shell.id,
    (counts.get(shell.label) ?? 0) > 1 ? `${shell.label} (${shell.path})` : shell.label,
  ]));
}

/**
 * The shell a new terminal opens on the machine this page is about.
 *
 * The list and the saved choice both live on that machine (its brain detects
 * the shells; the choice sits in its ADE home), so every call carries the
 * page's pin. Automatic is the behaviour ADE always had and stays the default.
 */
function shellHintLead(selectedPath: string | null, automaticShell: string | null): string {
  if (selectedPath) return `New shells open ${selectedPath}.`;
  if (automaticShell) return `Automatic opens ${automaticShell}, as ADE always has.`;
  return "Automatic picks the shell ADE always has.";
}

export function TerminalShellSection() {
  const { pin, machineName } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const [settings, setSettings] = useState<TerminalShellSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadRequest = useRef(0);

  useEffect(() => {
    const request = ++loadRequest.current;
    setSettings(null);
    setLoadFailed(false);
    setError(null);
    void window.ade.pty.getShellSettings(pinRef.current)
      .then((next) => {
        if (request === loadRequest.current) setSettings(next);
      })
      .catch(() => {
        if (request !== loadRequest.current) return;
        setLoadFailed(true);
      });
    return () => {
      // A newer machine or retry owns the page now.
      loadRequest.current += 1;
    };
  }, [pinKey, attempt]);

  const choose = useCallback(async (value: string) => {
    if (saving || !settings) return;
    const shellId = value === AUTOMATIC ? null : value;
    if (shellId === settings.defaultShellId) return;
    setSaving(true);
    setError(null);
    const request = loadRequest.current;
    try {
      const next = await window.ade.pty.setDefaultShell({ shellId }, pinRef.current);
      if (request === loadRequest.current) setSettings(next);
    } catch {
      if (request === loadRequest.current) setError("ADE couldn't save that shell. Pick it again, or reload the list.");
    } finally {
      setSaving(false);
    }
  }, [saving, settings]);

  const labels = settings ? shellOptionLabels(settings.shells) : new Map<string, string>();
  const automaticLabel = settings?.automaticShell
    ? `Automatic (${shellBaseName(settings.automaticShell)})`
    : "Automatic";
  const options = settings
    ? [
        { value: AUTOMATIC, label: automaticLabel },
        ...settings.shells.map((shell) => ({ value: shell.id, label: labels.get(shell.id) ?? shell.label })),
        ...(settings.savedShellMissing && settings.defaultShellId
          ? [{ value: settings.defaultShellId, label: `${savedShellLabel(settings.defaultShellId)} (not found)` }]
          : []),
      ]
    : [];
  const selected = settings?.defaultShellId ?? AUTOMATIC;
  const selectedShell = settings?.shells.find((shell) => shell.id === settings.defaultShellId) ?? null;
  const hint = `${shellHintLead(selectedShell?.path ?? null, settings?.automaticShell ?? null)} Agent and command terminals keep Automatic.`;

  return (
    <ModernSection
      group="Terminal"
      anchor="terminal-shell"
      title="Terminal shell"
      hint={`The shell a new terminal opens on ${machineName}.`}
    >
      <ModernRows>
        <ModernRow
          title="Default shell"
          hint={hint}
          control={
            settings ? (
              <SettingsSelect
                ariaLabel="Default shell"
                value={selected}
                disabled={saving}
                onChange={(value) => void choose(value)}
                options={options}
              />
            ) : loadFailed ? null : (
              <span className="ade-modern-muted" aria-live="polite">Loading…</span>
            )
          }
        >
          {settings?.savedShellMissing && settings.defaultShellId ? (
            <Banner
              layout="inline"
              model={{
                id: "terminal-shell-missing",
                tone: "warning",
                title: `${savedShellLabel(settings.defaultShellId)} isn't installed on ${machineName} anymore`,
                detail: "New shells use Automatic until it's back or you pick another.",
                actions: [{ label: "Use Automatic", onClick: () => void choose(AUTOMATIC) }],
              }}
            />
          ) : null}
          {loadFailed ? (
            <Banner
              layout="inline"
              model={{
                id: "terminal-shell-load-failed",
                tone: "error",
                title: `Couldn't read the shells on ${machineName}`,
                actions: [{ label: "Try again", onClick: () => setAttempt((value) => value + 1) }],
              }}
            />
          ) : null}
          {error ? (
            <Banner
              layout="inline"
              model={{
                id: "terminal-shell-save-error",
                tone: "error",
                title: error,
                report: { surface: "terminal_shell_settings" },
                dismiss: { onDismiss: () => setError(null) },
              }}
            />
          ) : null}
        </ModernRow>
      </ModernRows>
    </ModernSection>
  );
}
