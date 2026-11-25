import type { OpenProjectBinding } from "../../../../shared/types";
import { useAdeCloudLaneForBinding } from "../../../state/adeCloudLaneIndex";
import { useCloudAccount } from "../../../state/cloudAccountStore";
import { useSponsoredViewer } from "./useSponsoredViewer";

/**
 * An agent CLI on an ADE Cloud computer, on screen: the person watches it,
 * so the Index may answer that agent (`ade cloud recommend`), which says
 * "Sponsored" in its own reply. Shows nothing; a terminal never shows a card.
 */
export function SponsoredTerminalViewer({ pin, visible }: { pin: OpenProjectBinding | null; visible: boolean }) {
  const instanceId = useAdeCloudLaneForBinding(visible ? pin : null)?.instanceId ?? null;
  const sponsored = useCloudAccount(Boolean(instanceId))?.sponsored;
  useSponsoredViewer(instanceId, Boolean(sponsored?.ads && sponsored.consent !== "declined"));
  return null;
}
