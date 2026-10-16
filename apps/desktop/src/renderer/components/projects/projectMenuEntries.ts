import { Copy, DownloadSimple, ImageSquare, PushPin, PushPinSlash } from "@phosphor-icons/react";

import { resolveOpenInTarget } from "../../../shared/editorTargets";
import type { OpenProjectBinding } from "../../../shared/types";
import type { ContextMenuEntry } from "../ui/ContextMenu";
import type { CloneLocallyTarget } from "./CloneLocallyDialog";
import type { ProjectIconDialogTarget } from "./ProjectIconDialog";

/** A project as both right-click menus (the tab and the start page) see it. */
export type ProjectMenuProject = {
  rootPath: string;
  displayName: string;
  binding: OpenProjectBinding | null;
  /** False when this machine's checkout is missing on disk. */
  available: boolean;
  /** Null when the project is not in the recents list. */
  pinned: boolean | null;
  /** The host's latest icon, for a project on another machine. */
  hostIconDataUrl: string | null;
  /** Set when the project has no checkout here and a git origin to clone. */
  cloneTarget: CloneLocallyTarget | null;
};

/**
 * The clone offer for a project with no checkout on this machine. It needs a
 * git origin to clone from.
 */
export function cloneTargetFor(args: {
  binding: OpenProjectBinding | null | undefined;
  hasLocalCheckout: boolean;
  gitOriginUrl: string | null | undefined;
}): CloneLocallyTarget | null {
  const { binding, hasLocalCheckout, gitOriginUrl } = args;
  if (hasLocalCheckout || binding?.kind !== "remote" || !gitOriginUrl) return null;
  return {
    displayName: binding.displayName,
    machineName: binding.runtimeName,
    gitOriginUrl,
    remoteKey: binding.key,
  };
}

/**
 * The rows both project menus share, grouped so each surface can put its own
 * rows around them. The hosted web client has no editors, file dialogs or
 * recents of its own, so it gets only the rows that work there.
 */
export function projectMenuSections(
  project: ProjectMenuProject,
  opts: { webMode: boolean },
  actions: {
    onChangeIcon: (target: ProjectIconDialogTarget) => void;
    onClone: (target: CloneLocallyTarget) => void;
    onTogglePin: () => void;
  },
): { open: ContextMenuEntry[]; project: ContextMenuEntry[]; copy: ContextMenuEntry[] } {
  const { webMode } = opts;
  const remote = project.binding?.kind === "remote" ? project.binding : null;
  const openIn = !webMode && project.available
    ? resolveOpenInTarget({ worktreePath: project.rootPath, binding: project.binding })
    : null;
  const open: ContextMenuEntry[] = openIn
    ? [{ kind: "open-in", key: "open-in", rootPath: openIn.rootPath, remote: openIn.remote ?? null }]
    : [];

  const projectRows: ContextMenuEntry[] = [];
  if (!webMode && project.available) {
    projectRows.push({
      kind: "item",
      key: "icon",
      label: "Change icon…",
      icon: ImageSquare,
      onSelect: () =>
        actions.onChangeIcon({
          rootPath: project.rootPath,
          displayName: project.displayName,
          hostTargetId: remote?.targetId ?? null,
          hostName: remote?.runtimeName ?? null,
          hostIconDataUrl: remote ? (project.hostIconDataUrl ?? remote.iconDataUrl ?? null) : null,
        }),
    });
  }
  const cloneTarget = project.cloneTarget;
  if (!webMode && cloneTarget) {
    projectRows.push({
      kind: "item",
      key: "clone",
      label: "Clone to this machine…",
      icon: DownloadSimple,
      onSelect: () => actions.onClone(cloneTarget),
    });
  }
  if (!webMode && project.pinned != null) {
    projectRows.push({
      kind: "item",
      key: "pin",
      label: project.pinned ? "Unpin from recents" : "Pin to top of recents",
      icon: project.pinned ? PushPinSlash : PushPin,
      onSelect: actions.onTogglePin,
    });
  }

  const copy: ContextMenuEntry[] = [
    {
      kind: "item",
      key: "copy-path",
      label: "Copy path",
      icon: Copy,
      onSelect: () => void window.ade.app.writeClipboardText(project.rootPath).catch(() => {}),
    },
  ];
  return { open, project: projectRows, copy };
}
