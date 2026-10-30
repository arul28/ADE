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

const EFFECTIVE_DATE = "October 29, 2026";
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
    title: "Privacy-bounded product analytics",
    body: [
      "ADE desktop, runtime, hosted web, and native iOS surfaces use default-on, allowlisted product analytics. They honor the DO_NOT_TRACK=1 environment setting and any analytics opt-out you recorded in an earlier version. The public website has its own analytics switch on this page. These events help understand activation, retention, feature adoption, reliability, and quota health.",
      "Desktop and runtime events start with a random installation identity. If you sign in to an ADE account, ADE sends one PostHog identify request that links that anonymous history to a one-way hash of your account ID, and records on that analytics profile your ADE account ID, plan, platform, app version, and whether the install belongs to the ADE team. When you create an ADE account, ADE's account service records one sign-up event on the same profile with how you signed up (for example GitHub, Google, or email). ADE does not send your email, name, or access token to analytics. Signing out rotates the anonymous analytics identity.",
      "App analytics never includes prompts, source code, file or terminal content, repository names, file paths, URLs, query strings, URL fragments, referrers, branch names, session titles, raw error messages, or stack traces. ADE does not use analytics session recordings, automatic click or page capture, surveys, advertising profiles, or PostHog feature flags.",
      "Event collection is deduplicated and capped locally before transmission so a loop or high-frequency UI action cannot generate an unbounded event stream.",
    ],
  },
  {
    title: "Error and crash reporting",
    body: [
      "To find and fix failures, ADE's desktop app, runtime, hosted web client, relay services, and iOS app send error and crash reports to Sentry. This is separate from product analytics and is part of how ADE operates; it honors the DO_NOT_TRACK=1 environment setting.",
      "A report can include the error message and stack trace, file paths, the ADE version and build, operating system and hardware details, locale and time zone, the ADE action or screen involved, ADE-internal identifiers such as lane and chat session IDs, recent diagnostic log lines, and, for native crashes, a memory snapshot of the crashed process. Reports are associated with the same pseudonymous identifier used for product analytics (a random installation identifier, or a one-way hash of your account ID once you sign in). Sentry may derive an approximate location from the network address of a report; ADE configures Sentry not to store the address itself.",
      "Before a report leaves your device, ADE removes credentials, API keys, access tokens, and secret-looking values, and it does not include prompts, model responses, chat transcripts, file contents, diffs, or terminal output. A native crash snapshot captures process memory at the moment of the crash and can, rarely, contain fragments of data the process held at that time; these snapshots are used only to diagnose the crash.",
    ],
  },
  {
    title: "What this website collects",
    body: [
      "Unless you turn website analytics off on this page, the public marketing site manually records a daily app-open signal, an allowlisted page category, allowlisted CTA or feature-demo clicks, coarse browser error categories, and a daily event-budget summary. To understand where visitors come from, each event also carries the page address you are on, the site that linked you here, and any campaign tags (utm_source, utm_medium, utm_campaign, utm_term, utm_content) in the link you followed, plus the first such source this browser arrived from. Page addresses keep only the path and campaign tags; other query parameters and fragments are removed, and only the linking site's address without its query is kept. It does not derive analytics from link destinations or visible text, and it never sends an error message or stack trace.",
      "The site uses a random browser identifier stored in local storage for anonymous retention analysis, and keeps the visit's arrival source in session storage and the first arrival source in local storage. It sends at most 40 attempted events per UTC day, with lower per-event and per-feature limits plus burst deduplication. The PostHog project token is public configuration and does not grant account access. Requests omit credentials, disable PostHog person profiles and GeoIP enrichment, and use no analytics cookies. Like any HTTPS service, PostHog still receives network metadata needed to accept the request.",
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
      "The iOS app does not put source code, files, prompts, pairing payloads, or machine addresses into analytics. When analytics is configured, its allowlisted, quota-bounded analytics is default-on. Operational sync traffic flows only to the ADE machine you paired with or through ADE's connectivity relay when needed.",
    ],
  },
  {
    title: "What the desktop app collects",
    body: [
      "Project files, git history, prompts, terminal content, and process output remain on your disk and are excluded from analytics and error reports. Product analytics is limited to the allowlisted categories described above, and error and crash reports to what is described under Error and crash reporting. A full diagnostic report with local logs is shared only when you choose to submit one.",
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
          "Freebuff — an advertising-measurement pixel on this website only. Unless you have turned website analytics off, it records visits, keeps the click identifier from a Freebuff ad link, and reports when you press a download or copy-install button, so ADE can tell which ads lead to downloads.",
          "PostHog — receives manually selected product events when analytics is enabled. ADE creates a person profile, keyed by a hash of your account ID and carrying that ID, when you create an ADE account or sign in to an ADE app; autocapture, replay, surveys, and feature flags are disabled.",
          "Sentry — receives error and crash reports as described under Error and crash reporting, in Sentry's United States region. On iOS, a short, fully masked screen recording may accompany an error.",
          "Mintlify — documentation is served at /docs through Mintlify.",
          "AI providers you enable — Anthropic, OpenAI, and similar, only when you turn on a model that uses them.",
        ],
      },
      "ADE does not sell personal data. Apart from the Freebuff ad measurement on this website described above, ADE does not share analytics with advertisers.",
    ],
  },
  {
    title: "Retention",
    body: [
      "Unpairing an iOS device clears its saved machine profile and pairing credentials, but synced project data, caches, the anonymous analytics identifier, and local quota counters can remain in the app container until you remove the app's data. Because iOS Keychain items can survive an uninstall on some systems, unpair before uninstalling when you want to clear pairing credentials explicitly.",
      "Desktop and runtime analytics state — including its anonymous installation identifier, pseudonymous signed-in identity hash, install and activation milestones, identifier-hashing salt, preference, and quota counters — is stored under the machine's .ade/secrets directory until you delete that state. Opting out immediately stops analytics transmission and discards queued events, but retains that local state so toggling cannot reset quota limits. Computer project data otherwise remains on your local disk and is yours to keep, move, or delete.",
      "The marketing website stores an anonymous browser identifier, local event-budget counters, the first source this browser arrived from, and your analytics preference. Turning analytics off rotates the identifier and forgets the first source but retains the preference and quota counters; clearing site data removes them. ADE retains PostHog analytics events for no longer than one year and may delete them sooner. Sentry error reports are retained for 30 days. To request earlier deletion or ask what can be associated with your installation or pseudonymous account profile, email arulsharma1028@gmail.com. We may need information from your installation or account to locate applicable records. Data sent to AI providers is governed by each provider's retention policy.",
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
          "Set DO_NOT_TRACK=1 in the environment ADE runs in to stop product analytics and error reporting from the desktop app and runtime.",
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
