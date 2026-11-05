import { AppleLogo } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import video from "./assets/iphone-duo.mp4";
import still from "./assets/iphone-duo-still.webp";

/** iPhone Duo, the foldable, in ADE's iOS simulator. */
export default function IphoneDuoAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <AppleLogo size={17} weight="fill" />, name: "iOS simulator" }}
      headline="Test on iPhone Duo."
      sentence="Run your app on the foldable in the simulator, then drag the hinge."
      action={{ tipId: "ios-simulator", label: "Open the simulator" }}
      media={{
        video,
        still,
        width: 1600,
        height: 1060,
        alt: "An app on iPhone Duo in ADE's simulator, turning in 3D and folding as the hinge slider moves",
      }}
    />
  );
}
