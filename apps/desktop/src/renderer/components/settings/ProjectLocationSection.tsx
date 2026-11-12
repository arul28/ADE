import React, { useCallback, useEffect, useState } from "react";
import type { ProjectMoveRecord, ProjectMoveVolume } from "../../../shared/types/projectMove";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { isMacPlatform } from "../../lib/platform";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { ModernRow, ModernRows, ModernSection } from "./primitives";
import { openMoveProjectDialog } from "../projectMove/ProjectMoveHost";
import { chooseOldCopy } from "../projectMove/oldCopyActions";
import {
  displayPath,
  formatBytes,
  formatReminder,
  PROJECT_MOVE_CHANGED_EVENT,
  volumeFor,
} from "../projectMove/projectMoveModel";

/**
 * Where the page's copy of the project lives, and the Move… action. The move
 * runs in this computer's main process on a folder this computer has, so a
 * copy on another computer says so instead of offering it.
 */
export function ProjectLocationSection() {
  const { pin, machineName } = useSettingsMachineScope();
  const moveApi = window.ade?.projectMove;
  const api = isAdeAvailable(moveApi) ? moveApi : undefined;
  const root = pin?.rootPath ?? null;
  const remote = pin?.kind === "remote";
  const [volumes, setVolumes] = useState<ProjectMoveVolume[]>([]);
  const [lastMove, setLastMove] = useState<ProjectMoveRecord | null>(null);

  const refresh = useCallback(() => {
    if (!api || !root || remote || !isMacPlatform()) return;
    void api.listVolumes().then(setVolumes).catch((error) => {
      console.warn("[project-move] listing drives failed", error);
      setVolumes([]);
    });
    void api.status(root).then(setLastMove).catch((error) => {
      console.warn("[project-move] reading the last move failed", error);
      setLastMove(null);
    });
  }, [api, remote, root]);

  useEffect(() => {
    refresh();
    window.addEventListener(PROJECT_MOVE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROJECT_MOVE_CHANGED_EVENT, refresh);
  }, [refresh]);

  // Moving needs macOS's copy and drive tools; elsewhere the card is absent.
  if (!root || !api || !isMacPlatform()) return null;
  const projectName = pin?.displayName || root.split("/").pop() || "this project";

  if (remote) {
    return (
      <ModernSection group="Project" anchor="project-location" title="Project location">
        <ModernRows>
          <ModernRow title={`This copy is on ${machineName}`} hint={`Move it from ADE on ${machineName}.`} />
        </ModernRows>
      </ModernSection>
    );
  }

  const volume = volumeFor(root, volumes);
  const where = volume ? `${volume.name} · ${formatBytes(volume.freeBytes)} free` : null;
  const oldCopy = lastMove?.originalParkedAt ? lastMove : null;

  return (
    <ModernSection group="Project" anchor="project-location" title="Project location">
      <ModernRows>
        <ModernRow
          title={<code title={root}>{displayPath(root)}</code>}
          hint={where ?? undefined}
          control={(
            <button
              type="button"
              className="ade-modern-btn"
              onClick={() => openMoveProjectDialog({ projectRoot: root, projectName })}
            >
              Move…
            </button>
          )}
        />
        {oldCopy ? (
          <ModernRow
            title="Old copy"
            hint={[
              formatBytes(oldCopy.originalBytes),
              oldCopy.cleanup.choice === "remind" ? `reminder ${formatReminder(oldCopy.cleanup.remindAt)}` : null,
            ].filter(Boolean).join(" · ")}
            control={(
              <>
                <button type="button" className="ade-modern-btn" onClick={() => void api.reveal({ moveId: oldCopy.moveId, which: "original" })}>
                  Show in Finder
                </button>
                <button type="button" className="ade-modern-btn ade-modern-btn-danger" onClick={() => void chooseOldCopy(oldCopy, "delete")}>
                  Delete…
                </button>
              </>
            )}
          />
        ) : null}
      </ModernRows>
    </ModernSection>
  );
}
