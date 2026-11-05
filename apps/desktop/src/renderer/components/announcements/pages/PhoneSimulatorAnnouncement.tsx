import { DeviceMobile } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import video from "./assets/phone-stream.mp4";
import still from "./assets/phone-stream-still.webp";

/** The simulator, streamed to the iPhone app and driven by touch. */
export default function PhoneSimulatorAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <DeviceMobile size={17} weight="fill" />, name: "iPhone app" }}
      headline="The simulator, on your iPhone."
      sentence="Tap and swipe the simulator from your phone, live."
      action={{ tipId: "phone", label: "Pair your iPhone" }}
      media={{
        video,
        still,
        width: 1920,
        height: 1080,
        alt: "The simulator on a Mac beside a real iPhone showing the same screen, where a finger taps to open an app",
      }}
    />
  );
}
