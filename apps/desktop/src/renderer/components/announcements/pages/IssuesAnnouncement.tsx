import { Ticket } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import attachVideo from "./assets/issues-attach.mp4";
import attachStill from "./assets/issues-attach-still.webp";
import browse from "./assets/issues-browse.webp";
import create from "./assets/issues-new.webp";

/** Jira, Linear and GitHub issues in one place, and attached to a chat. */
export default function IssuesAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <Ticket size={17} weight="fill" />, name: "Issues" }}
      headline="Your issues, inside ADE."
      sentence="Attach a Jira, Linear or GitHub issue to a chat and the agent starts with all of it."
      action={{ tipId: "issues", label: "Connect your tracker" }}
      media={{
        kind: "images",
        width: 1560,
        height: 1005,
        images: [
          { src: attachStill, video: attachVideo, alt: "Attaching a GitHub issue to a chat from the composer's menu, then opening the issue" },
          { src: create, alt: "One New issue form with Linear, GitHub and Jira tabs" },
          { src: browse, alt: "Jira issues in ADE: a list of issues and one issue's details, with Launch agent" },
        ],
      }}
    />
  );
}
