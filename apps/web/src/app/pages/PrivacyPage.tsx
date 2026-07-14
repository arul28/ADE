import { useEffect, useState } from "react";
import { Container } from "../../components/Container";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import {
  isMarketingAnalyticsEnabled,
  onMarketingAnalyticsPreferenceChange,
  setMarketingAnalyticsEnabled,
} from "../../lib/marketingAnalyticsBrowser";

const EFFECTIVE_DATE = "July 13, 2026";
const CONTACT_EMAIL = "arulsharma1028@gmail.com";

type Section = {
  title: string;
  body: Array<string | { list: string[] }>;
  analyticsControl?: boolean;
};

const sections: Section[] = [
  {
    title: "Local-first by design",
    body: [
      "ADE keeps the machine you control as the authority for your code, repositories, prompts, and project data. The desktop app runs worktrees, git operations, terminals, processes, and tests on that machine. The iOS companion does not run agents, but it does keep a local synced or cached subset of project data so its screens can load quickly and remain useful offline.",
    ],
  },
  {
    title: "Anonymous product analytics",
    body: [
      "Configured ADE desktop and runtime surfaces use default-on, anonymous, allowlisted product analytics with an accessible opt-out. Native iOS and browser surfaces ask for consent before collecting analytics. These events help understand activation, retention, feature adoption, and reliability by describing the product surface, a normalized screen or feature category, an allowlisted action or outcome, coarse runtime metadata, and quota health. Random or installation-salted identifiers support retention analysis without an ADE account or person profile.",
      "Analytics never includes prompts, source code, file or terminal content, repository names, file paths, URLs, query strings, URL fragments, referrers, branch names, session titles, raw error messages, or stack traces. ADE does not use analytics session recordings, automatic click or page capture, surveys, advertising profiles, or PostHog feature flags.",
      "Every applicable surface provides a durable control to withdraw consent or opt out. Event collection is deduplicated and capped locally before transmission so a loop or high-frequency UI action cannot generate an unbounded event stream.",
    ],
  },
  {
    title: "What this website collects",
    body: [
      "After you allow analytics, the public marketing site manually records a daily app-open signal, an allowlisted page category, allowlisted CTA or feature-demo clicks, coarse browser error categories, and a daily event-budget summary. Before that choice, it sends no product analytics. It does not derive analytics from link destinations or visible text, and it never sends a full URL, query string, fragment, referrer, error message, or stack trace.",
      "The site uses a random browser identifier stored in local storage for anonymous retention analysis. It sends at most 40 attempted events per UTC day, with lower per-event and per-feature limits plus burst deduplication. The PostHog project token is public configuration and does not grant account access. Requests omit credentials and referrers, disable PostHog person profiles and GeoIP enrichment, and use no analytics cookies. Like any HTTPS service, PostHog still receives network metadata needed to accept the request.",
    ],
  },
  {
    title: "What the iOS app collects",
    body: [
      "The iOS app (bundle ID com.ade.ios) handles only what is needed to pair with and control an ADE machine:",
      {
        list: [
          "A pairing identifier and the machine address you scan or enter, stored on the device.",
          "Camera access, used solely on-device for QR code pairing. Frames are not stored or transmitted.",
          "Local network discovery (Bonjour, _ade-sync._tcp) to find your own ADE machine on the same network.",
          "A local database and app caches containing the synced project records, file data, chat data, and UI snapshots needed for the mobile features you use.",
        ],
      },
      "The iOS app has no ADE account system and does not put source code, files, prompts, pairing payloads, or machine addresses into analytics. When analytics is configured, the app asks before collecting and keeps the withdrawal control in Settings. Operational sync traffic flows only to the ADE machine you paired with or through ADE's connectivity relay when needed.",
    ],
  },
  {
    title: "What the desktop app collects",
    body: [
      "Project files, git history, prompts, terminal content, and process output remain on your disk and are excluded from analytics. Anonymous product analytics, when enabled, is limited to the allowlisted categories described above. Raw crash logs are shared only when you choose to submit them.",
    ],
  },
  {
    title: "Cloud relay and BYOK features",
    body: [
      "ADE can use a Cloudflare-hosted relay to connect already-paired clients when a direct connection is unavailable. Relay traffic is operational sync traffic and is separate from product analytics. If you connect a model provider with your own API key (Anthropic, OpenAI, OpenCode, Cursor, etc.), prompts and code excerpts you choose to send are transmitted to that provider under its privacy terms. ADE does not put those request bodies into product analytics.",
    ],
  },
  {
    title: "Third parties",
    body: [
      "ADE relies on a small set of infrastructure services. They receive only the data needed for the service described below; product analytics never receives project content.",
      "ADE requires PostHog and any other analytics processor to provide the same or equivalent protection described in this policy, to act only for the analytics service, and not to use ADE analytics for advertising or independent profiling.",
      {
        list: [
          "GitHub — desktop releases are distributed through GitHub Releases.",
          "Vercel — this website is hosted on Vercel; standard request logs apply.",
          "Cloudflare — ADE's connectivity relay can route sync traffic between already-paired clients.",
          "PostHog — receives anonymous, manually selected product events when analytics is enabled. Person profiles, autocapture, replay, surveys, and feature flags are disabled for ADE analytics.",
          "Mintlify — documentation is served at /docs through Mintlify.",
          "AI providers you enable — Anthropic, OpenAI, and similar, only when you turn on a model that uses them.",
        ],
      },
      "ADE does not sell personal data or share analytics with advertisers.",
    ],
  },
  {
    title: "Retention",
    body: [
      "Unpairing an iOS device clears its saved machine profile and pairing credentials, but synced project data, caches, analytics preference, and local quota counters can remain in the app container until you remove the app's data. iOS analytics opt-out cancels pending requests and removes the anonymous analytics identifier; opting in later creates a new identifier. Because iOS Keychain items can survive an uninstall on some systems, unpair before uninstalling when you want to clear pairing credentials explicitly.",
      "Desktop and runtime analytics state — including its anonymous installation identifier, identifier-hashing salt, preference, and quota counters — is stored under the machine's .ade/secrets directory until you delete that state. Opting out immediately stops analytics transmission and discards queued events, but retains that local state so toggling cannot reset quota limits. Computer project data otherwise remains on your local disk and is yours to keep, move, or delete.",
      "After consent, the marketing website stores an anonymous browser identifier, local event-budget counters, and your analytics preference. Withdrawing consent rotates the identifier but retains the preference and quota counters; clearing site data removes them. ADE retains PostHog analytics events for no longer than one year and may delete them sooner. To request earlier deletion or ask what can be associated with your anonymous installation, email arulsharma1028@gmail.com. Because ADE has no analytics account or person profile, we may need information from your installation and may be unable to associate an anonymous historical event with you. Data sent to AI providers is governed by each provider's retention policy.",
    ],
  },
  {
    title: "Your choices",
    body: [
      {
        list: [
          "Revoke camera or local network access in iOS Settings → ADE.",
          "Unpair the iOS app from the machine to clear the stored pairing.",
          "Disable cloud and BYOK features in the desktop app at any time.",
          "Turn anonymous product analytics off on each applicable ADE surface.",
          "Unpair first to clear pairing credentials, then uninstall or clear app/site data to remove the corresponding app-container or browser data.",
        ],
      },
      "On this website, the control below is durable in local storage. You can also call window.adeAnalytics.setEnabled(false) from the browser console.",
    ],
    analyticsControl: true,
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

function AnalyticsPreferenceControl() {
  const [enabled, setEnabled] = useState(() => isMarketingAnalyticsEnabled());

  useEffect(() => onMarketingAnalyticsPreferenceChange(setEnabled), []);

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border/70 bg-bg/50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-semibold text-fg">Anonymous website analytics</div>
        <div className="mt-1 text-xs text-muted-fg">
          {enabled ? "On — only manual, allowlisted, quota-bounded events are sent." : "Off — no website analytics events are sent."}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        className="focus-ring inline-flex min-w-36 items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-fg hover:bg-muted/70"
        onClick={() => setMarketingAnalyticsEnabled(!enabled)}
      >
        Turn analytics {enabled ? "off" : "on"}
      </button>
    </div>
  );
}

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
                    {section.analyticsControl ? <AnalyticsPreferenceControl /> : null}
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
