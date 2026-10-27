import { ArrowsOutLineHorizontal, ImageSquare, Shuffle } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import picker from "./assets/wallpapers.webp";

/** Backgrounds sized for the screen, with shuffle. */
export default function WallpapersAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <ImageSquare size={17} weight="fill" />, name: "Appearance" }}
      headline="New backgrounds, sharp on your screen."
      sentence="Pick a picture, or let ADE shuffle a new one each launch. Each comes in sizes that fit your display, ultrawide included."
      marks={[
        { icon: <Shuffle size={14} weight="bold" />, label: "Shuffle" },
        { icon: <ArrowsOutLineHorizontal size={14} weight="bold" />, label: "Ultrawide" },
      ]}
      media={{
        kind: "images",
        width: 1350,
        height: 940,
        images: [{ src: picker, alt: "The background picker: a grid of pictures, with Shuffle selected" }],
      }}
    />
  );
}
