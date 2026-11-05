import { UsersThree } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import video from "./assets/subagents.mp4";
import still from "./assets/subagents-still.webp";

/** `@` a model from any provider, and it runs as a subagent that reports back. */
export default function SubagentsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <UsersThree size={17} weight="fill" />, name: "Subagents" }}
      headline="Any model can be your subagent."
      sentence="Type @ in a chat and pick models from any provider. Each one works in this lane and reports back."
      action={{ tipId: "at-menu", label: "Try @" }}
      media={{
        video,
        still,
        width: 1600,
        height: 1004,
        alt: "Typing @ to add DeepSeek V4.1 Flash and GPT-6 Luna to a message, which starts four subagents that show in the chat and its Subagents panel",
      }}
    />
  );
}
