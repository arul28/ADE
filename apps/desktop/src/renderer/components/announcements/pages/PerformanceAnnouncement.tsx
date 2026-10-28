import { Database, DesktopTower, DeviceMobile, Lightning } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import phone from "./assets/perf-1.webp";
import macA from "./assets/perf-2.webp";
import macB from "./assets/perf-3.webp";
import dataA from "./assets/perf-4.webp";
import dataB from "./assets/perf-5.webp";

/** ADE against T3 Code on the same speed tests. */
export default function PerformanceAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <Lightning size={17} weight="fill" />, name: "Performance" }}
      headline="Faster than T3 Code."
      sentence="Ahead in 17 of 18 speed tests, against T3 Code's own published numbers."
      marks={[
        { icon: <DeviceMobile size={14} weight="fill" />, label: "iPhone on 3G" },
        { icon: <DesktopTower size={14} weight="fill" />, label: "Mac app" },
        { icon: <Database size={14} weight="fill" />, label: "Database and git" },
      ]}
      media={{
        kind: "images",
        width: 1568,
        height: 1086,
        holdMs: 2_000,
        images: [
          { src: phone, alt: "iPhone app on slow 3G: ADE wins all 4 tests against T3 Code, including a 2.41 s cold start" },
          { src: macA, alt: "Mac app: ADE loads less code at launch and redraws less while streaming than T3 Code" },
          { src: macB, alt: "Mac app: ADE is faster at typing, live updates and building the timeline, and batches more of the stream" },
          { src: dataA, alt: "Database and git: ADE stalls less while a phone syncs, reads faster and runs half the git processes" },
          { src: dataB, alt: "Database and git: ADE finds pull requests and recovers at launch faster; T3 Code is slightly faster at a single git call" },
        ],
      }}
    />
  );
}
