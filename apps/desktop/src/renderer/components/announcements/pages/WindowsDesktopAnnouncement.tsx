import { WindowsLogo } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import video from "./assets/windows-desktop.mp4";
import still from "./assets/windows-desktop-still.webp";

/** Agents drive a private Windows or Linux desktop from any computer and send proof back. */
export default function WindowsDesktopAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <WindowsLogo size={17} weight="fill" color="#0078d4" />, name: "Windows and Linux" }}
      headline="Agents can use Windows and Linux."
      sentence="From any computer, an agent drives its own Windows or Linux desktop and sends back proof."
      action={{ tipId: "private-desktop", label: "See where" }}
      media={{
        video,
        still,
        width: 1600,
        height: 1004,
        alt: "From a Mac, an agent takes a screenshot of its private Windows desktop and posts it in the chat",
      }}
    />
  );
}
