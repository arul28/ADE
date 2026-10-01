import { useCallback, useEffect, useRef, useState } from "react";
import { Folder } from "@phosphor-icons/react";

import {
  getProjectIconFromCache,
  publishProjectIcon,
  setProjectIconCache,
} from "../../lib/projectIconCache";
import { Banner } from "../ui/notice/Banner";
import { Dialog as AppDialog } from "../ui/dialog/Dialog";

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
  // Bumped whenever the dialog opens on another target or closes, so a
  // request that finishes late cannot change the dialog that replaced it.
  const sessionRef = useRef(0);

  useEffect(() => {
    sessionRef.current += 1;
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
    const session = sessionRef.current;
    setChoosing(true);
    setIconError(null);
    try {
      const nextIcon = target.hostTargetId
        ? await window.ade.remoteRuntime.chooseProjectIcon(target.hostTargetId, target.rootPath)
        : await window.ade.project.chooseIcon(target.rootPath);
      if (!nextIcon) return;
      // The new icon belongs to its project whatever the dialog shows now.
      if (!target.hostTargetId) publishProjectIcon(target.rootPath, nextIcon);
      if (session !== sessionRef.current) return;
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
      if (session === sessionRef.current) setIconError(projectIconErrorMessage(error));
    } finally {
      setChoosing(false);
    }
  }, [choosing, onClose, target]);

  const handleRemoveIcon = useCallback(async () => {
    if (!target || removing) return;
    const session = sessionRef.current;
    setRemoving(true);
    setIconError(null);
    try {
      if (target.hostTargetId) {
        await window.ade.remoteRuntime.removeProjectIcon(target.hostTargetId, target.rootPath);
      } else {
        publishProjectIcon(target.rootPath, await window.ade.project.removeIcon(target.rootPath));
      }
      if (session === sessionRef.current) onClose();
    } catch (error) {
      // Keep the current icon while surfacing why removal failed.
      if (session === sessionRef.current) setIconError(projectIconErrorMessage(error));
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

