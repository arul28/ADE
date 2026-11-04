import { DeviceMobile } from "@phosphor-icons/react";
import type { AnnouncementPageProps } from "../announcementPages";
import { WhatsNewFeature } from "./WhatsNewFeature";
import pr from "./assets/phone-pr.webp";
import comments from "./assets/phone-comments.webp";
import checks from "./assets/phone-checks.webp";

/** Pull requests in the iPhone app: reactions, comments, live checks. */
export default function PhonePullRequestsAnnouncement({ close }: AnnouncementPageProps) {
  return (
    <WhatsNewFeature
      close={close}
      place={{ icon: <DeviceMobile size={17} weight="fill" />, name: "iPhone app" }}
      headline="Review PRs from your phone."
      sentence="Read, comment and watch checks in the ADE iPhone app."
      action={{ tipId: "phone", label: "Pair your iPhone" }}
      media={{
        kind: "phones",
        width: 699,
        height: 1017,
        images: [
          { src: comments, alt: "A pull request's comments on iPhone, with reactions" },
          { src: pr, alt: "A pull request on iPhone: summary, test plan and reactions" },
          { src: checks, alt: "A pull request on iPhone with one check failing" },
        ],
      }}
    />
  );
}
