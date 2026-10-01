import { useCallback, useEffect, useState } from "react";
import { Folder } from "@phosphor-icons/react";

import type { ProjectIcon } from "../../../shared/types";
import { Banner } from "../ui/notice/Banner";
import { Dialog as AppDialog } from "../ui/dialog/Dialog";

// Bounded LRU so we don't accumulate icons for every project ever opened in
// long-lived sessions. 24 entries keeps the working set hot for typical usage
// (current project + a few recents in the tab list) without unbounded growth.
const PROJECT_ICON_CACHE_MAX = 24;
const projectIconCache = new Map<string, ProjectIcon>();

export function getProjectIconFromCache(rootPath: string): ProjectIcon | undefined {
  const cached = projectIconCache.get(rootPath);
  if (cached === undefined) return undefined;
  // Touch on read to mark as most-recently-used.
  projectIconCache.delete(rootPath);
  projectIconCache.set(rootPath, cached);
  return cached;
}

export function setProjectIconCache(rootPath: string, icon: ProjectIcon): void {
  if (projectIconCache.has(rootPath)) {
    projectIconCache.delete(rootPath);
  } else if (projectIconCache.size >= PROJECT_ICON_CACHE_MAX) {
    // Map iteration order is insertion order, so the first key is the LRU.
    const oldestKey = projectIconCache.keys().next().value;
    if (oldestKey !== undefined) {
      projectIconCache.delete(oldestKey);
    }
  }
  projectIconCache.set(rootPath, icon);
}

/**
 * Tabs read their icon from the shared cache. When the icon dialog changes a
 * project's icon, it updates the cache and tells every mounted tab icon for
 * that root to read it again.
 */
export const projectIconListeners = new Set<(rootPath: string) => void>();

export function publishProjectIcon(rootPath: string, icon: ProjectIcon): void {
  setProjectIconCache(rootPath, icon);
  for (const listener of projectIconListeners) listener(rootPath);
}

function projectIconErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  return cleaned || "Failed to update project icon.";
}

export type ProjectIconDialogTarget = {
  rootPath: string;
  displayName: string;
  /** Set when the project lives on another machine; the icon is stored there. */
  hostTargetId: string | null;
  hostName: string | null;
  /** The icon the host reported, for a project on another machine. */
  hostIconDataUrl: string | null;
};

/**
 * The project icon editor. It opens only from a project's right-click menu.
 * A project on another machine stores its icon on that machine, so every
 * device that opens the project shows the same icon.
 */
export function ProjectIconDialog({
  target,
  onClose,
}: {
  target: ProjectIconDialogTarget | null;
  onClose: () => void;
}) {
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);

  useEffect(() => {
    setIconError(null);
    setPreviewFailed(false);
    if (!target) {
      setPreviewDataUrl(null);
      return;
    }
    if (target.hostTargetId) {
      setPreviewDataUrl(target.hostIconDataUrl);
      return;
    }
    const cached = getProjectIconFromCache(target.rootPath);
    setPreviewDataUrl(cached?.dataUrl ?? null);
    let cancelled = false;
    window.ade.project
      .resolveIcon(target.rootPath)
      .then((icon) => {
        if (cancelled) return;
        setProjectIconCache(target.rootPath, icon);
        setPreviewDataUrl(icon.dataUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [target]);

  const handleChooseIcon = useCallback(async () => {
    if (!target || choosing) return;
    setChoosing(true);
    setIconError(null);
    try {
      const nextIcon = target.hostTargetId
        ? await window.ade.remoteRuntime.chooseProjectIcon(target.hostTargetId, target.rootPath)
        : await window.ade.project.chooseIcon(target.rootPath);
      if (!nextIcon) return;
      if (!target.hostTargetId) publishProjectIcon(target.rootPath, nextIcon);
      setPreviewFailed(false);
      setPreviewDataUrl(nextIcon.dataUrl);
      if (nextIcon.dataUrl) {
        onClose();
      } else {
        setIconError(
          "ADE saved the path, but the image could not be rendered as a project icon.",
        );
      }
    } catch (error) {
      // Keep the current icon while surfacing why replacement failed.
      setIconError(projectIconErrorMessage(error));
    } finally {
      setChoosing(false);
    }
  }, [choosing, onClose, target]);

  const handleRemoveIcon = useCallback(async () => {
    if (!target || removing) return;
    setRemoving(true);
    setIconError(null);
    try {
      if (target.hostTargetId) {
        await window.ade.remoteRuntime.removeProjectIcon(target.hostTargetId, target.rootPath);
      } else {
        publishProjectIcon(target.rootPath, await window.ade.project.removeIcon(target.rootPath));
      }
      onClose();
    } catch (error) {
      // Keep the current icon while surfacing why removal failed.
      setIconError(projectIconErrorMessage(error));
    } finally {
      setRemoving(false);
    }
  }, [onClose, removing, target]);

  return (
    <AppDialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Project icon"
      description={
        target?.hostName
          ? `${target.displayName} on ${target.hostName}. Every device shows this icon.`
          : target?.displayName
      }
      size="sm"
      width={320}
      tone="accent"
      stopClickPropagation
      actions={[
        {
          label: "Remove",
          variant: "secondary",
          busy: removing,
          disabled: choosing || removing,
          onClick: () => void handleRemoveIcon(),
        },
        {
          label: "Replace",
          variant: "solid",
          busy: choosing,
          disabled: choosing || removing,
          onClick: () => void handleChooseIcon(),
        },
      ]}
    >
      <div className="flex items-center justify-center rounded-md border border-border bg-bg/60 p-5">
        {previewDataUrl && !previewFailed ? (
          <img
            src={previewDataUrl}
            alt=""
            className="h-20 w-20 rounded-md object-contain"
            draggable={false}
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          <Folder size={52} className="text-muted-fg" />
        )}
      </div>

      {iconError ? (
        <Banner
          model={{ id: "project-icon-error", tone: "error", title: iconError }}
          layout="inline"
          style={{ marginTop: 12 }}
        />
      ) : null}
    </AppDialog>
  );
}

