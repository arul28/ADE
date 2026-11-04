import { Flask } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import track from "./assets/beta-track.webp";

/** The Beta update track: builds from main every few hours, chosen per machine. */
export default function BetaAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <Flask size={17} weight="fill" color="#f59e0b" />, name: "ADE Beta" }}
      headline="Get new features first."
      sentence="Switch to Beta in Settings › General for a new build every few hours. Same projects, same chats."
      action={{ tipId: "beta-track", label: "Switch to Beta" }}
      media={{
        kind: "images",
        width: 1600,
        height: 876,
        images: [
          { src: track, alt: "Settings, General: ADE 1.2.128-beta.2 with the Update track set to Beta, and each machine with its own track" },
        ],
      }}
    />
  );
}
