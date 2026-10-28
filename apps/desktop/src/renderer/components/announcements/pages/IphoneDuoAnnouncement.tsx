import { AppleLogo, Cube, DeviceMobileCamera, SlidersHorizontal } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import gif from "./assets/iphone-duo.gif";
import still from "./assets/iphone-duo-still.webp";

/** iPhone Duo, the foldable, in ADE's iOS simulator. */
export default function IphoneDuoAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <AppleLogo size={17} weight="fill" />, name: "iOS simulator" }}
      headline="Test your app on iPhone Duo."
      sentence="Run your app on the foldable iPhone in the simulator, then drag the hinge to see it closed, half open and flat."
      marks={[
        { icon: <SlidersHorizontal size={14} weight="bold" />, label: "Hinge slider" },
        { icon: <Cube size={14} weight="fill" />, label: "3D view" },
        { icon: <DeviceMobileCamera size={14} weight="fill" />, label: "Cover screen" },
      ]}
      action={{ tipId: "ios-simulator", label: "Open the simulator" }}
      media={{
        gif,
        still,
        width: 600,
        height: 575,
        alt: "An app on iPhone Duo in ADE's simulator, turning in 3D and folding as the hinge slider moves",
      }}
    />
  );
}
