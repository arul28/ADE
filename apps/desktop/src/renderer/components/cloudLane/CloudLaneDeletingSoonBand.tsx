import { useState, type CSSProperties } from "react";
import { Clock } from "@phosphor-icons/react";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { Banner } from "../ui/notice";
import { idleHeldDetail } from "../settings/cloudDashboard/CloudIdleCleanupNotice";
import { keepLaneComputer } from "./CloudLaneHeaderButton";
import { cloudQueueSizeLabel } from "./cloudLanesWithoutComputer";
import { BRAND } from "../../../shared/brand";

const DAY_MS = 24 * 60 * 60_000;

/**
 * "This lane's cloud computer is deleted in N day(s)", in whole days, at least
 * one, and what happens after: its work is saved in ADE Cloud (never pushed;
 * files git ignores are not),
 * and the size is the one a message after the delete starts its new computer
 * at (`cloudQueueSizeLabel`).
 */
function deletingSoonWords(deletesAt: number, now: number, sizeLabel: string): { title: string; detail: string } {
  const days = Math.max(1, Math.ceil((deletesAt - now) / DAY_MS));
  return {
    title: `This lane's cloud computer is deleted in ${days} ${days === 1 ? "day" : "days"}`,
    detail: `It isn't being used. Its work that isn't on GitHub is saved in ${BRAND.CLOUD_NAME} first, and the lane and its chats stay. `
      + "Files git ignores, such as .env, aren't saved. "
      + `Your next message makes a new computer at ${sizeLabel}.`,
  };
}

/**
 * One band inside a cloud lane's chat while the idle cleanup warned about its
 * computer, with Keep it. Read from the account the chat header already reads
 * (`useCloudAccount().dueForDeletion`), so there is no read of its own. The
 * Work and Lanes rows of the lane say "Deleting soon" (`useCloudLaneRowNotes`).
 * Keep it is account level, by the computer's ADE Cloud id: no pin.
 */
export function CloudLaneDeletingSoonBand({ laneId, style }: { laneId: string | null; style?: CSSProperties }) {
  const { computers } = useAdeCloudLaneComputers();
  const account = useCloudAccount();
  const [keeping, setKeeping] = useState(false);
  const computer = laneId ? computers.find((entry) => entry.laneId === laneId) ?? null : null;
  const due = computer ? account?.dueForDeletion?.find((entry) => entry.instanceId === computer.instanceId) ?? null : null;
  if (!computer || !due) return null;
  const canKeep = Boolean(window.ade?.cloud?.keepIdleComputer);
  const keep = () => {
    if (keeping) return;
    setKeeping(true);
    void keepLaneComputer(computer.instanceId, computer.laneName || "this lane").finally(() => setKeeping(false));
  };
  const now = Date.now();
  const words = due.held
    ? {
      title: `This lane's computer wasn't deleted: ${BRAND.NAME} couldn't save its work`,
      detail: idleHeldDetail({ ...due, held: due.held }, now),
    }
    : deletingSoonWords(due.deletesAt, now, cloudQueueSizeLabel(account));
  return (
    <Banner
      layout="inline"
      style={style}
      model={{
        id: "cloud-lane-deleting-soon",
        tone: due.held ? "info" : "warning",
        icon: <Clock size={13} weight="bold" />,
        title: words.title,
        detail: words.detail,
        actions: canKeep ? [{ label: "Keep it", onClick: keep, busy: keeping }] : [],
      }}
    />
  );
}
