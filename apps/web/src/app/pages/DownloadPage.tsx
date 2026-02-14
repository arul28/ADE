import { useEffect, useMemo, useState } from "react";
import { Apple, ArrowUpRight, Cpu, Download, Github, Laptop, Monitor, Terminal } from "lucide-react";
import { Container } from "../../components/Container";
import { CopyButton } from "../../components/CopyButton";
import { LinkButton } from "../../components/LinkButton";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
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
        note: "DMG (and/or ZIP) from GitHub Releases.",
        hint: "Recommended on Apple Silicon + Intel."
      },
      {
        key: "windows" as const,
        title: "Windows",
        icon: <Monitor className="h-5 w-5" />,
        note: "EXE installer from GitHub Releases.",
        hint: "Requires Windows 10+."
      },
      {
        key: "linux" as const,
        title: "Linux",
        icon: <Cpu className="h-5 w-5" />,
        note: "AppImage (or tarball) from GitHub Releases.",
        hint: "Works across most distros."
      }
    ],
    []
  );

  return (
    <Page>
      <section className="py-16 sm:py-20">
        <Container>
          <Reveal>
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-semibold text-muted-fg">
              <Download className="h-4 w-4" />
              Download
            </div>
          </Reveal>
          <Reveal delay={0.05}>
            <h1 className="mt-5 text-balance text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
              Download ADE.
            </h1>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-muted-fg sm:text-lg">
              Get the latest desktop build from GitHub Releases, or build from source. ADE is designed to run in Guest Mode
              without accounts, and can optionally enable hosted or BYOK LLM providers.
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
                  <div
                    className={[
                      "rounded-[22px] border bg-card/60 p-6 shadow-glass-sm transition-all duration-200 [transition-timing-function:var(--ease-out)]",
                      recommended ? "border-accent/50 ring-1 ring-accent/30" : "border-border"
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card/80 text-fg">
                        {c.icon}
                      </div>
                      {recommended ? (
                        <span className="rounded-full bg-[rgba(27,118,255,0.12)] px-3 py-1 text-xs font-semibold text-fg">
                          Suggested for you
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-4 text-sm font-semibold text-fg">{c.title}</div>
                    <div className="mt-1 text-sm text-muted-fg">{c.note}</div>
                    <div className="mt-3 text-xs text-muted-fg">{c.hint}</div>
                    <div className="mt-6">
                      <a
                        className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card/70 px-4 py-2 text-sm font-semibold text-fg hover:bg-card"
                        href={LINKS.releases}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Download from releases <ArrowUpRight className="h-4 w-4" />
                      </a>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </Container>
      </section>

      <section className="py-14">
        <Container>
          <Reveal>
            <div className="grid gap-8 rounded-[26px] border border-border bg-card/60 p-8 shadow-glass-sm lg:grid-cols-2">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3 py-1 text-xs font-semibold text-muted-fg">
                  <Terminal className="h-4 w-4" />
                  Build from source
                </div>
                <h2 className="mt-4 text-2xl font-semibold tracking-tight text-fg">Prefer to run from git?</h2>
                <p className="mt-3 text-sm leading-relaxed text-muted-fg">
                  Clone the repo and run the desktop app with Vite + Electron. This is also the fastest way to hack on ADE.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <a
                    className="focus-ring inline-flex items-center gap-2 rounded-lg border border-border bg-card/70 px-4 py-2 text-sm font-semibold text-fg hover:bg-card"
                    href={LINKS.docs}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Docs <ArrowUpRight className="h-4 w-4" />
                  </a>
                  <a
                    className="focus-ring inline-flex items-center gap-2 rounded-lg border border-border bg-card/70 px-4 py-2 text-sm font-semibold text-fg hover:bg-card"
                    href={LINKS.prd}
                    target="_blank"
                    rel="noreferrer"
                  >
                    PRD <ArrowUpRight className="h-4 w-4" />
                  </a>
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-[rgba(10,16,32,0.90)] p-4 font-mono text-xs text-[rgba(234,242,255,0.82)] shadow-glass-md">
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
          </Reveal>
        </Container>
      </section>

      <section className="py-14">
        <Container>
          <Reveal>
            <div className="rounded-[26px] border border-border bg-card/60 p-8 shadow-glass-sm">
              <div className="text-sm font-semibold text-fg">Notes</div>
              <div className="mt-3 grid gap-4 text-sm text-muted-fg md:grid-cols-2">
                <div className="rounded-xl border border-border bg-card/70 p-4">
                  ADE is a desktop app (Electron). If your OS blocks the binary (unsigned builds, Gatekeeper, SmartScreen),
                  use the official release instructions for your platform.
                </div>
                <div className="rounded-xl border border-border bg-card/70 p-4">
                  Cloud features are optional. ADE is designed to keep the repo authoritative and treat hosted results as
                  suggestions (diffs) you explicitly apply.
                </div>
              </div>
            </div>
          </Reveal>
        </Container>
      </section>
    </Page>
  );
}
