import { DeviceMobile, HandTap, Lightning } from "@phosphor-icons/react";
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
      headline="Use the simulator from your iPhone."
      sentence="ADE streams the simulator to your phone. Tap and swipe it like a real iPhone, and see every change as it lands."
      marks={[
        { icon: <HandTap size={14} weight="fill" />, label: "Touch control" },
        { icon: <Lightning size={14} weight="fill" />, label: "Live updates" },
      ]}
      media={{
        video,
        still,
        width: 840,
        height: 1000,
        alt: "The simulator on a Mac beside a real iPhone showing the same screen, where a finger taps to open an app",
      }}
      action={{ tipId: "phone", label: "Pair your iPhone" }}
    />
  );
}
