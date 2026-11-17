import { useState, type CSSProperties } from "react";
import { Clock } from "@phosphor-icons/react";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { Banner } from "../ui/notice";
import { keepLaneComputer } from "./CloudLaneHeaderButton";

const DAY_MS = 24 * 60 * 60_000;

/** "This lane's cloud computer is deleted in N day(s) because it is unused." Whole days, at least one. */
export function deletingSoonSentence(deletesAt: number, now: number): string {
  const days = Math.max(1, Math.ceil((deletesAt - now) / DAY_MS));
  return `This lane's cloud computer is deleted in ${days} ${days === 1 ? "day" : "days"} because it is unused. Your work is pushed first.`;
}

/**
 * One band inside a cloud lane's chat while the idle cleanup warned about its
 * computer, with Keep it. Read from the account the chat header already reads
 * (`useCloudAccount().dueForDeletion`), so there is no read of its own. The
 * Work list shows nothing for it. Keep it is account level, by the computer's
 * ADE Cloud id: no pin.
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
  return (
    <Banner
      layout="inline"
      style={style}
      model={{
        id: "cloud-lane-deleting-soon",
        tone: due.held ? "info" : "warning",
        icon: <Clock size={13} weight="bold" />,
        title: due.held
          ? "This lane's computer wasn't deleted: ADE couldn't save its work. ADE tries again later."
          : deletingSoonSentence(due.deletesAt, Date.now()),
        actions: canKeep ? [{ label: "Keep it", onClick: keep, busy: keeping }] : [],
      }}
    />
  );
}
