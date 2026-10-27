import { MusicNotes, Queue } from "@phosphor-icons/react";
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
      headline="Apple Music and Spotify, right inside ADE."
      sentence="Browse your library, pick an album and play, pause or skip from the Music tab or the top bar. No switching apps."
      marks={[
        { icon: <HomeAppIcon app="appleMusic" size={15} />, label: "Apple Music" },
        { icon: <HomeAppIcon app="spotify" size={15} />, label: "Spotify" },
        { icon: <Queue size={13} weight="bold" />, label: "Up next" },
      ]}
      media={{
        kind: "images",
        width: 1200,
        height: 754,
        images: [{ src: shot, alt: "The Music tab playing an album from Apple Music, with Now playing on the right" }],
      }}
      action={{ tipId: "music", label: "Open Music" }}
    />
  );
}
