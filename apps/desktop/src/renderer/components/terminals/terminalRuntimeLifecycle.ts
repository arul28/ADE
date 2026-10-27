/**
 * The project-change hook for cached terminal runtimes, without the terminal
 * itself. `AppShell` is part of every launch; importing this from
 * `TerminalView` put the whole terminal (and xterm) on the startup path. The
 * view registers its disposer when it loads; before that there is no runtime
 * to dispose.
 */
type TerminalRuntimeDisposer = (activeProjectKey: string | null, activeProjectRevision: number) => void;

let disposer: TerminalRuntimeDisposer | null = null;

export function registerTerminalRuntimeDisposer(next: TerminalRuntimeDisposer): void {
  disposer = next;
}

export function disposeTerminalRuntimesForProjectChange(
  activeProjectKey: string | null,
  activeProjectRevision: number,
): void {
  disposer?.(activeProjectKey, activeProjectRevision);
}
