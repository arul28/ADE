import { ImageSquare } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import picker from "./assets/wallpapers.webp";

/** Backgrounds sized for the screen, with shuffle. */
export default function WallpapersAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <ImageSquare size={17} weight="fill" />, name: "Appearance" }}
      headline="Wallpapers made for your screen."
      sentence="Pick one, or shuffle a new one each launch, in Settings › Appearance."
      action={{ tipId: "themes", label: "Pick a background" }}
      media={{
        kind: "images",
        width: 1350,
        height: 940,
        images: [{ src: picker, alt: "The background picker: a grid of pictures, with Shuffle selected" }],
      }}
    />
  );
}
