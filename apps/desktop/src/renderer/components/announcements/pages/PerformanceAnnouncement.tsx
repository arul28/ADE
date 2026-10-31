import { Cpu, Gauge, Lightning, Timer } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import mainThread from "./assets/perf-t3-1.webp";
import keepingUp from "./assets/perf-t3-2.webp";
import cpuMemory from "./assets/perf-t3-3.webp";

/** ADE against T3 Code on the same streaming test. */
export default function PerformanceAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <Lightning size={17} weight="fill" />, name: "Performance" }}
      headline="Faster than T3 Code."
      sentence="Streaming the same 50 KB reply, ADE uses half of T3 Code's main-thread time and app CPU, and shows the last line first."
      marks={[
        { icon: <Gauge size={14} weight="fill" />, label: "Main thread" },
        { icon: <Timer size={14} weight="fill" />, label: "Keeping up" },
        { icon: <Cpu size={14} weight="fill" />, label: "CPU and memory" },
      ]}
      media={{
        kind: "images",
        width: 1568,
        height: 1086,
        holdMs: 2_000,
        images: [
          { src: mainThread, alt: "Streaming a reply: ADE uses 1.77 s of main-thread time to T3 Code's 3.51 s, and less JavaScript, layout and style time" },
          { src: keepingUp, alt: "Keeping up: ADE paints the last line in 19 ms to T3 Code's 32 ms, is late by at most 8 ms, and changes the page half as often" },
          { src: cpuMemory, alt: "CPU and memory: ADE uses 3.5 s of app CPU to T3 Code's 6.6 s, 2.2 s of graphics CPU to 3.3 s, and 33 MB of memory to 51 MB" },
        ],
      }}
    />
  );
}
