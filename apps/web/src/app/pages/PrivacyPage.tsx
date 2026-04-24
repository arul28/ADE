import { Container } from "../../components/Container";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

const EFFECTIVE_DATE = "April 22, 2026";
const CONTACT_EMAIL = "arulsharma1028@gmail.com";

type Section = {
  title: string;
  body: Array<string | { list: string[] }>;
};

const sections: Section[] = [
  {
    title: "Local-first by design",
    body: [
      "ADE keeps your code, repositories, prompts, and project data on the machine you control. The desktop app runs entirely on your computer — worktrees, git operations, terminals, processes, tests, and file content stay local. The iOS companion app is a remote viewer and controller for that machine; it does not run agents or store your project content on its own.",
    ],
  },
  {
    title: "What the iOS app collects",
    body: [
      "The iOS app (bundle ID com.ade.ios) handles only what is needed to pair with a desktop host and receive notifications:",
      {
        list: [
          "A pairing identifier and the host address you scan or enter, stored on the device.",
          "An Apple Push Notification (APNs) device token, sent only to the desktop host you have paired with.",
          "Camera access, used solely on-device for QR code pairing. Frames are not stored or transmitted.",
          "Local network discovery (Bonjour, _ade-sync._tcp) to find your own desktop host on the same network.",
        ],
      },
      "There are no analytics SDKs, no third-party trackers, no account system, and no remote logging in the iOS app. The app does not transmit source code, files, or AI prompts to any ADE-operated server — all traffic flows to the desktop host you paired with, over your local network or your own VPN.",
    ],
  },
  {
    title: "What the desktop app collects",
    body: [
      "The desktop app does not collect telemetry by default. Project files, git history, terminals, and process state remain on your disk. Crash logs, if you choose to share them, are submitted manually.",
    ],
  },
  {
    title: "Optional cloud and BYOK features",
    body: [
      "If you opt in to ADE Cloud features or connect a model provider with your own API key (Anthropic, OpenAI, OpenCode, Cursor, etc.), the prompts and code excerpts you choose to send are transmitted to that provider under that provider's privacy terms. ADE does not retain a separate copy of those requests on its own servers when you use your own keys. Cloud and BYOK features are clearly marked in the desktop app and are off until you enable them.",
    ],
  },
  {
    title: "Third parties",
    body: [
      "ADE relies on a small set of infrastructure services. None of them receive your project content unless you opt in to a feature that uses them.",
      {
        list: [
          "Apple — Apple Push Notification service for delivery to the iOS app.",
          "GitHub — desktop releases are distributed through GitHub Releases.",
          "Vercel — this website is hosted on Vercel; standard request logs apply.",
          "Mintlify — documentation is served at /docs through Mintlify.",
          "AI providers you enable — Anthropic, OpenAI, and similar, only when you turn on a model that uses them.",
        ],
      },
      "ADE does not sell personal data, does not share it with advertisers, and does not include third-party analytics in the iOS app.",
    ],
  },
  {
    title: "Retention",
    body: [
      "Pairing identifiers and push tokens persist on the iOS device until you uninstall the app or unpair from the host. Desktop data persists on your local disk and is yours to keep, move, or delete. Data sent to AI providers is governed by each provider's retention policy.",
    ],
  },
  {
    title: "Your choices",
    body: [
      {
        list: [
          "Revoke camera or local network access in iOS Settings → ADE.",
          "Unpair the iOS app from the host to clear the stored pairing.",
          "Disable cloud and BYOK features in the desktop app at any time.",
          "Uninstall the apps to remove all locally stored ADE data on the device.",
        ],
      },
    ],
  },
  {
    title: "Children",
    body: [
      "ADE is a developer tool and is not directed at children under 13. The apps do not knowingly collect personal information from children.",
    ],
  },
  {
    title: "Changes to this policy",
    body: [
      "If we make material changes we will update this page and the effective date above. Continued use of ADE after a change indicates acceptance of the revised policy.",
    ],
  },
  {
    title: "Contact",
    body: [
      `Questions about privacy or data handling: ${CONTACT_EMAIL}.`,
    ],
  },
];

export function PrivacyPage() {
  useDocumentTitle("ADE Privacy");

  return (
    <Page>
      <section className="py-16 sm:py-20">
        <Container>
          <Reveal>
            <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">Privacy</h1>
            <p className="mt-3 text-sm text-muted-fg">Effective {EFFECTIVE_DATE}</p>
            <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-fg">
              ADE is a developer tool built around a simple promise: by default, your code and prompts stay on the
              machine you control. This page explains what data ADE handles, where it goes, and the choices you have.
            </p>
          </Reveal>

          <div className="mt-10 grid gap-6">
            {sections.map((section, index) => (
              <Reveal key={section.title} delay={Math.min(index * 0.04, 0.2)}>
                <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                  <h2 className="text-sm font-semibold text-fg">{section.title}</h2>
                  <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-fg">
                    {section.body.map((block, i) =>
                      typeof block === "string" ? (
                        <p key={i}>{block}</p>
                      ) : (
                        <ul key={i} className="list-disc space-y-1.5 pl-5">
                          {block.list.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      )
                    )}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>
    </Page>
  );
}
