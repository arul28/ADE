import { AppleLogo, Camera, VideoCamera, WindowsLogo } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import gif from "./assets/windows-desktop.gif";
import still from "./assets/windows-desktop-still.webp";

/** Agents drive a private Windows desktop from any computer and send proof back. */
export default function WindowsDesktopAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <WindowsLogo size={17} weight="fill" color="#0078d4" />, name: "Windows desktop" }}
      headline="Agents can now use Windows."
      sentence="From any computer, even a Mac, an agent can drive its own Windows desktop and send back screenshots and videos of what it did."
      marks={[
        { icon: <AppleLogo size={14} weight="fill" />, label: "Works from a Mac" },
        { icon: <Camera size={14} weight="fill" />, label: "Screenshots" },
        { icon: <VideoCamera size={14} weight="fill" />, label: "Videos" },
      ]}
      media={{
        gif,
        still,
        width: 760,
        height: 527,
        alt: "From a Mac, an agent takes a screenshot of its private Windows desktop and posts it in the chat",
      }}
    />
  );
}
