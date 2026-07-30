import { useEffect, useMemo, useState } from "react";
import { Apple, ArrowUpRight, Cpu, Download, Github, Laptop, Monitor, Smartphone, Terminal } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { LinkButton } from "../../components/LinkButton";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { Section } from "../../components/Section";
import { SectionHeading } from "../../components/SectionHeading";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import {
  MARKETING_CTA_LABELS,
  MARKETING_CTA_POSITIONS,
  MARKETING_FEATURES,
  type MarketingFeature,
} from "../../lib/marketingAnalytics";

type PlatformHint = "mac" | "windows" | "linux" | "ios" | "unknown";

const WINDOWS_DOWNLOAD_ENABLED = import.meta.env.VITE_ADE_WINDOWS_DOWNLOAD_ENABLED === "1";

function detectPlatform(): PlatformHint {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  // navigator.platform is deprecated; used only as an iPad-spoof fallback.
  const navigatorPlatform = typeof navigator !== "undefined" ? (navigator.platform ?? "").toLowerCase() : "";
  const maxTouchPoints = typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0;
  if (/(iphone|ipad|ipod)/.test(ua) || (navigatorPlatform === "macintel" && maxTouchPoints > 1)) return "ios";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "mac";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

function downloadCtaForFeature(feature: MarketingFeature) {
  if (feature === MARKETING_FEATURES.DOWNLOAD_MAC) return MARKETING_CTA_LABELS.DOWNLOAD_MAC;
  if (feature === MARKETING_FEATURES.DOWNLOAD_WINDOWS) return MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS;
  if (feature === MARKETING_FEATURES.DOWNLOAD_IOS) return MARKETING_CTA_LABELS.DOWNLOAD_IOS;
  return undefined;
}

export function DownloadPage() {
  useDocumentTitle("Download ADE");
  const [platform, setPlatform] = useState<PlatformHint>("unknown");

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const sourceCmd = useMemo(
    () =>
      [
        `git clone https://github.com/${LINKS.repo}.git`,
        "cd ADE/apps/desktop",
        "npm install",
        "npm run dev"
      ].join("\n"),
    []
  );

  const cards = useMemo(
    () => [
      {
        key: "mac" as const,
        title: "macOS",
        icon: <Apple className="h-5 w-5" />,
        note: "Current beta release target: DMG and ZIP from GitHub Releases.",
        hint: "ADE for computers bundles the app, ade CLI, ade code, and the background ADE brain.",
        actionHref: LINKS.releasesLatest,
        actionLabel: "Download for Mac",
        analyticsFeature: MARKETING_FEATURES.DOWNLOAD_MAC,
      },
      {
        key: "windows" as const,
        title: "Windows",
        icon: <Monitor className="h-5 w-5" />,
        note: WINDOWS_DOWNLOAD_ENABLED
          ? "Windows 10 and 11 x64 installer from GitHub Releases."
          : "Windows x64 preview builds are in release validation.",
        hint: WINDOWS_DOWNLOAD_ENABLED
          ? "The NSIS installer includes the app, ade CLI, ade code, and the background ADE brain."
          : "Public download stays gated until a signed N → N+1 installed-update test passes.",
        actionHref: WINDOWS_DOWNLOAD_ENABLED ? LINKS.releasesLatest : LINKS.releases,
        actionLabel: WINDOWS_DOWNLOAD_ENABLED ? "Download for Windows" : "View Windows release status",
        analyticsFeature: WINDOWS_DOWNLOAD_ENABLED
          ? MARKETING_FEATURES.DOWNLOAD_WINDOWS
          : MARKETING_FEATURES.VIEW_RELEASES,
      },
      {
        key: "linux" as const,
        title: "Linux",
        icon: <Cpu className="h-5 w-5" />,
        note: "AppImage and package builds are not published yet.",
        hint: "Use the source build path for now.",
        actionHref: LINKS.releases,
        actionLabel: "Check releases",
        analyticsFeature: MARKETING_FEATURES.VIEW_RELEASES,
      },
      {
        key: "ios" as const,
        title: "iOS",
        icon: <Smartphone className="h-5 w-5" />,
        note: "ADE Mobile is available through TestFlight while the App Store listing is prepared.",
        hint: "Pair once with an ADE machine, then review, approve, and follow push state from the phone.",
        actionHref: LINKS.testflight,
        actionLabel: "Download for iOS",
        analyticsFeature: MARKETING_FEATURES.DOWNLOAD_IOS,
      }
    ],
    []
  );

  return (
    <Page>
      <Section className="py-0 pt-16 pb-14 sm:pt-20 sm:pb-16">
        <Reveal>
          <Badge className="bg-card/50">
            <Download className="h-4 w-4" />
            Download
          </Badge>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="mt-5 text-balance text-5xl font-semibold leading-[1.06] tracking-tight text-fg sm:text-6xl">
            Download ADE.
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-muted-fg sm:text-lg">
            Get ADE for macOS from GitHub Releases, follow Windows x64 release validation, install the iOS companion
            from TestFlight, or build from source. Computer installs include the app, ade CLI, ade code, and ADE brain.
          </p>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <LinkButton to={LINKS.releasesLatest} analyticsFeature={MARKETING_FEATURES.DOWNLOAD_MAC} analyticsCta={MARKETING_CTA_LABELS.DOWNLOAD_MAC} analyticsPosition={MARKETING_CTA_POSITIONS.DOWNLOAD_PAGE} size="lg" variant="primary" target="_blank" rel="noreferrer">
              Download for Mac <ArrowUpRight className="h-4 w-4" />
            </LinkButton>
            {WINDOWS_DOWNLOAD_ENABLED ? (
              <LinkButton to={LINKS.releasesLatest} analyticsFeature={MARKETING_FEATURES.DOWNLOAD_WINDOWS} analyticsCta={MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS} analyticsPosition={MARKETING_CTA_POSITIONS.DOWNLOAD_PAGE} size="lg" variant="primary" target="_blank" rel="noreferrer">
                Download for Windows <ArrowUpRight className="h-4 w-4" />
              </LinkButton>
            ) : null}
            <LinkButton to={LINKS.testflight} analyticsFeature={MARKETING_FEATURES.DOWNLOAD_IOS} analyticsCta={MARKETING_CTA_LABELS.DOWNLOAD_IOS} analyticsPosition={MARKETING_CTA_POSITIONS.DOWNLOAD_PAGE} size="lg" variant="secondary" target="_blank" rel="noreferrer">
              Download for iOS <Smartphone className="h-4 w-4" />
            </LinkButton>
            <LinkButton to={LINKS.github} analyticsFeature={MARKETING_FEATURES.VIEW_GITHUB} size="lg" variant="secondary" target="_blank" rel="noreferrer">
              GitHub repo <Github className="h-4 w-4" />
            </LinkButton>
          </div>
        </Reveal>

        <div className="mt-12 grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          {cards.map((c, idx) => {
            const recommended = platform === c.key;
            return (
              <Reveal key={c.key} delay={idx * 0.03}>
                <Card
                  className={cn(
                    "p-6 transition-all duration-300 [transition-timing-function:var(--ease-out)]",
                    "hover:-translate-y-0.5 hover:border-border hover:bg-card/70 hover:shadow-glass-md",
                    recommended ? "border-accent/45 ring-1 ring-accent/25 shadow-glass-md" : undefined
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-card/80 text-fg">
                      {c.icon}
                    </div>
                    {recommended ? <Badge variant="accent">Suggested for you</Badge> : null}
                  </div>
                  <div className="mt-4 text-sm font-semibold text-fg">{c.title}</div>
                  <div className="mt-1 text-sm text-muted-fg">{c.note}</div>
                  <div className="mt-3 text-xs text-muted-fg">{c.hint}</div>
                  <div className="mt-6">
                    <a
                      className={cn(
                        "focus-ring inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border/70 bg-card/70 px-4 py-2 text-sm font-semibold text-fg",
                        "transition-all duration-200 [transition-timing-function:var(--ease-out)] hover:bg-card hover:shadow-glass-sm"
                      )}
                      href={c.actionHref}
                      data-ade-analytics-feature={c.analyticsFeature}
                      data-ade-analytics-cta={downloadCtaForFeature(c.analyticsFeature)}
                      data-ade-analytics-position={downloadCtaForFeature(c.analyticsFeature) ? MARKETING_CTA_POSITIONS.DOWNLOAD_PAGE : undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {c.actionLabel} <ArrowUpRight className="h-4 w-4" />
                    </a>
                  </div>
                </Card>
              </Reveal>
            );
          })}
        </div>
      </Section>

      <Section className="py-0 pb-16 sm:pb-20">
        <Reveal>
          <Card className="p-8 lg:p-10">
            <SectionHeading
              eyebrow={
                <span className="inline-flex items-center gap-2">
                  <Terminal className="h-4 w-4" />
                  Build from source
                </span>
              }
              title="Prefer to run from git?"
              description="Clone the repo and run the desktop app with Vite + Electron. This is also the fastest way to hack on ADE."
              size="md"
            />

            <div className="mt-8 grid gap-8 lg:grid-cols-2">
              <div>
                <div className="flex flex-wrap gap-3">
                  <a
                    className="focus-ring inline-flex items-center gap-2 rounded-lg border border-border/70 bg-card/70 px-4 py-2 text-sm font-semibold text-fg hover:bg-card"
                    href={LINKS.docs}
                    data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOCS}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Docs <ArrowUpRight className="h-4 w-4" />
                  </a>
                  <a
                    className="focus-ring inline-flex items-center gap-2 rounded-lg border border-border/70 bg-card/70 px-4 py-2 text-sm font-semibold text-fg hover:bg-card"
                    href={LINKS.prd}
                    data-ade-analytics-feature={MARKETING_FEATURES.VIEW_PRD}
                    target="_blank"
                    rel="noreferrer"
                  >
                    PRD <ArrowUpRight className="h-4 w-4" />
                  </a>
                </div>
              </div>

              <div className="rounded-2xl border border-border/70 bg-[rgba(10,16,32,0.90)] p-4 font-mono text-xs text-[rgba(234,242,255,0.82)] shadow-glass-md">
                <div className="flex items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 text-[rgba(234,242,255,0.74)]">
                    <Laptop className="h-4 w-4" />
                    quickstart
                  </div>
                  <CopyButton value={sourceCmd} analyticsFeature={MARKETING_FEATURES.COPY_SOURCE_COMMAND} />
                </div>
                <pre className="mt-4 overflow-auto leading-relaxed">
                  <code>{sourceCmd}</code>
                </pre>
              </div>
            </div>
          </Card>
        </Reveal>
      </Section>

      <Section className="py-0 pb-20">
        <Reveal>
          <Card className="p-8 lg:p-10">
            <SectionHeading
              eyebrow={<span className="inline-flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-accent" />Notes</span>}
              title="A couple heads-ups."
              description="Computer builds ship via GitHub Releases. Cloud features are optional, and hosted output is treated as suggestions."
              size="md"
            />
            <div className="mt-8 grid gap-4 text-sm text-muted-fg md:grid-cols-2">
              <Card tone="solid" className="p-4 shadow-glass-sm">
                Official macOS releases are signed and notarized. Windows pull-request previews may be unsigned and are
                intended only for internal testing; public Windows download remains disabled until a signed installed
                N → N+1 update, relaunch, and background-brain recovery pass on a clean VM.
              </Card>
              <Card tone="solid" className="p-4 shadow-glass-sm">
                Cloud features are optional. ADE is designed to keep the repo authoritative and treat hosted results as
                suggestions (diffs) you explicitly apply.
              </Card>
            </div>
          </Card>
        </Reveal>
      </Section>
    </Page>
  );
}
