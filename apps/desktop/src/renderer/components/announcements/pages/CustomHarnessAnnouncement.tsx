import { ArrowsLeftRight } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import pickHarness from "./assets/custom-harness-1.webp";
import pickModel from "./assets/custom-harness-2.webp";
import inPicker from "./assets/custom-harness-3.webp";

/** Custom providers: any harness on a model you already pay for, in one editor. */
export default function CustomHarnessAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <ArrowsLeftRight size={17} weight="bold" />, name: "Custom providers" }}
      headline="Any agent, on any plan you pay for."
      sentence="Run any model you pay for inside the agent you like, such as Claude Opus in OpenCode. Set it up once in Settings › Providers › Custom."
      action={{ tipId: "custom-provider", label: "Make one" }}
      media={{
        kind: "images",
        width: 1400,
        height: 1034,
        holdMs: 2_000,
        images: [
          {
            src: pickHarness,
            caption: "1. Pick the agent that runs the chat",
            alt: "The custom provider editor: OpenCode picked as the harness, and the Claude accounts you are signed in to",
          },
          {
            src: pickModel,
            caption: "2. Pick a model from an account you pay for",
            alt: "Claude Opus 5.5 picked from a Claude Max account, with effort, subagents and the look below it",
          },
          {
            src: inPicker,
            caption: "3. Use it from any chat's model picker",
            alt: "Opus 5.5 in OpenCode in the Custom section of a chat's model picker",
          },
        ],
      }}
    />
  );
}
