import { useNavigate } from "react-router-dom";
import { Cloud, Desktop, GitBranch } from "@phosphor-icons/react";
import { showToast } from "../app/toast/toastStore";
import { laneOfflineSentence, type LaneMention } from "./state/accountLaneMentions";

/**
 * A lane a pull request (or another row) mentions: its name and its machine.
 * A click opens the lane. A lane on an own computer that is offline does not
 * open; the person reads where it is and when it opens. No rename or delete
 * here: those live in the Lanes tab and the lane menu.
 */
export function LaneMentionChip({ mention }: { mention: LaneMention }): JSX.Element {
  const navigate = useNavigate();
  const MachineIcon = mention.cloud ? Cloud : Desktop;
  const open = () => {
    if (!mention.online) {
      showToast({ id: `lane-offline-${mention.key}`, tone: "info", title: "Lane is offline", message: laneOfflineSentence(mention) });
      return;
    }
    navigate(`/lanes?laneId=${encodeURIComponent(mention.laneId)}&focus=single`);
  };
  const label = `${mention.laneName} on ${mention.machineName}`;
  return (
    <button
      type="button"
      className="kit-tag inline-flex min-w-0 max-w-[260px] shrink items-center gap-1 hover:bg-fg/[0.06]"
      title={mention.online ? `Open lane ${label}` : laneOfflineSentence(mention)}
      aria-label={mention.online ? `Open lane ${label}` : `${label}, offline`}
      data-offline={mention.online ? undefined : ""}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
    >
      <GitBranch size={11} className="shrink-0" />
      <span className="truncate">{mention.laneName}</span>
      <MachineIcon size={11} className={mention.online ? "shrink-0" : "shrink-0 opacity-50"} />
      <span className={mention.online ? "truncate" : "truncate opacity-60"}>{mention.machineName}</span>
    </button>
  );
}
