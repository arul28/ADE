import { useEffect, useMemo, useState } from "react";
import { Apple, ArrowUpRight, Cpu, Download, Github, Laptop, Monitor, Terminal } from "lucide-react";
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

type PlatformHint = "mac" | "windows" | "linux" | "unknown";

function detectPlatform(): PlatformHint {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "mac";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "unknown";
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
        hint: "Recommended on Apple Silicon and Intel."
      },
      {
        key: "windows" as const,
        title: "Windows",
        icon: <Monitor className="h-5 w-5" />,
        note: "Installer builds are not published yet.",
        hint: "Use the source build path for now."
      },
      {
        key: "linux" as const,
        title: "Linux",
        icon: <Cpu className="h-5 w-5" />,
        note: "AppImage and package builds are not published yet.",
        hint: "Use the source build path for now."
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
            Get the latest desktop build from GitHub Releases, or build from source. ADE runs in Guest Mode without
            accounts, and can optionally enable hosted or BYOK LLM providers.
          </p>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <LinkButton to={LINKS.releases} size="lg" variant="primary" target="_blank" rel="noreferrer">
              Latest release <ArrowUpRight className="h-4 w-4" />
            </LinkButton>
            <LinkButton to={LINKS.github} size="lg" variant="secondary" target="_blank" rel="noreferrer">
              GitHub repo <Github className="h-4 w-4" />
            </LinkButton>
          </div>
        </Reveal>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
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
                      href={LINKS.releases}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download from releases <ArrowUpRight className="h-4 w-4" />
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
                    target="_blank"
                    rel="noreferrer"
                  >
                    Docs <ArrowUpRight className="h-4 w-4" />
                  </a>
                  <a
                    className="focus-ring inline-flex items-center gap-2 rounded-lg border border-border/70 bg-card/70 px-4 py-2 text-sm font-semibold text-fg hover:bg-card"
                    href={LINKS.prd}
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
                  <CopyButton value={sourceCmd} />
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
              description="Desktop builds ship via GitHub Releases. Cloud features are optional, and hosted output is treated as suggestions."
              size="md"
            />
            <div className="mt-8 grid gap-4 text-sm text-muted-fg md:grid-cols-2">
              <Card tone="solid" className="p-4 shadow-glass-sm">
                ADE is a desktop app (Electron). If your OS blocks the binary (unsigned builds, Gatekeeper, SmartScreen), use
                the official release instructions for your platform.
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
