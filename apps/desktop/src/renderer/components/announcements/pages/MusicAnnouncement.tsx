import { MusicNotes } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import { HomeAppIcon } from "../../music/musicApps";
import shot from "./assets/music.webp";

/** Apple Music and Spotify in the Music tab. */
export default function MusicAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <MusicNotes size={17} weight="fill" />, name: "Music" }}
      headline="Your music, without leaving ADE."
      sentence="Play Apple Music or Spotify from the Music tab or the top bar."
      action={{ tipId: "music", label: "Open Music" }}
      media={{
        kind: "images",
        width: 1200,
        height: 754,
        images: [{ src: shot, alt: "The Music tab playing an album from Apple Music, with Now playing on the right" }],
      }}
    />
  );
}
