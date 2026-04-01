import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Download,
  Github,
  GitMerge,
  Layers,
  MonitorCheck,
  Package,
  Play,
  Workflow,
  Zap,
} from "lucide-react";
import { Fragment } from "react";
import { Container } from "../../components/Container";
import { Card } from "../../components/Card";
import { LinkButton } from "../../components/LinkButton";
import { Reveal } from "../../components/Reveal";
import { Page } from "../../components/Page";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

import { HeroVisual } from "../../components/ui/HeroVisual";
import { ProductShowcase } from "../../components/ProductShowcase";

/* ──────────────────────────────────────────────
   Competitor apps that ADE replaces
   ────────────────────────────────────────────── */

// Logos: apps/web/public/images/competitors/*.png (or change paths below).
const COMPETITORS = [
  { name: "Claude Code", logo: "/images/competitors/claude-code.png" },
  { name: "Codex", logo: "/images/competitors/codex.png" },
  { name: "OpenCode", logo: "/images/competitors/opencode.png" },
  { name: "T3 Code", logo: "/images/competitors/t3-code.png" },
  { name: "Cursor", logo: "/images/competitors/cursor.png" },
  { name: "Superset", logo: "/images/competitors/superset.png" },
  { name: "Conductor", logo: "/images/competitors/conductor.png" },
  { name: "Factory", logo: "/images/competitors/factory.png" },
  { name: "Paperclip", logo: "/images/competitors/paperclip.png" },
  { name: "OpenClaw", logo: "/images/competitors/openclaw.png" },
  { name: "GitHub", logo: "/images/competitors/github.png" },
] as const;

const ALSO_BUILT_IN = [
  {
    icon: Bot,
    label: "CTO agent",
    detail: "A long-lived lead for architecture and decisions, with memory and team workflows.",
  },
  {
    icon: Workflow,
    label: "Missions",
    detail: "Coordinated multi-step runs with visibility across phases — planning, testing, and PRs.",
  },
  {
    icon: Package,
    label: "Unified memory",
    detail: "Vector-indexed memory across projects and agents so work compounds instead of resetting.",
  },
  {
    icon: Zap,
    label: "Automations",
    detail: "Event-driven agents on git events, PR activity, or schedules — with guardrails while you are away.",
  },
  {
    icon: GitMerge,
    label: "Merge conflicts",
    detail: "Resolve conflicts with side-by-side diffs and a focused flow so you can land merges in one place.",
  },
  {
    icon: MonitorCheck,
    label: "Computer use",
    detail: "Screenshot-based verification of agent output when you need proof, not just prose.",
  },
  {
    icon: Layers,
    label: "35+ MCP tools",
    detail: "Built-in server for file ops, git, search, and more — desktop and headless paths.",
  },
  {
    icon: Play,
    label: "Process monitor",
    detail: "Track every terminal command agents spawn and inspect output in one timeline.",
  },
] as const;

/* ──────────────────────────────────────────────
   Quickstart copy command
   ────────────────────────────────────────────── */

function QuickstartBlock() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-xs font-bold text-accent">
            1
          </span>
          Download the latest release
        </div>
        <LinkButton to={LINKS.releases} variant="secondary" size="md" target="_blank" rel="noreferrer">
          <Download className="h-4 w-4" /> Download DMG from GitHub{" "}
          <ArrowUpRight className="h-3.5 w-3.5 text-muted-fg" />
        </LinkButton>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-xs font-bold text-accent">
            2
          </span>
          Move ADE into Applications
        </div>
        <p className="text-sm text-muted-fg">
          Drag <strong>ADE</strong> into your Applications folder before first launch so macOS can
          keep it on the normal update path.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-xs font-bold text-accent">
            3
          </span>
          Open ADE and point it at your project
        </div>
        <p className="text-sm text-muted-fg">
          No account needed. Add your own API keys for Claude, Codex, or other providers in settings.
        </p>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────
   Page
   ────────────────────────────────────────────── */

export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");

  return (
    <Page>
      {/* ── HERO — Logo Equation + ADE ─────────── */}
      <section className="relative overflow-x-hidden">
        {/* Background: gradient mesh + dot texture */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: [
              "radial-gradient(ellipse 80% 50% at 50% -5%, rgba(124,58,237,0.18) 0%, transparent 100%)",
              "radial-gradient(ellipse 40% 40% at 0% 0%, rgba(59,130,246,0.10) 0%, transparent 100%)",
              "radial-gradient(ellipse 40% 40% at 100% 5%, rgba(236,72,153,0.07) 0%, transparent 100%)",
              "radial-gradient(ellipse 50% 30% at 50% 60%, rgba(124,58,237,0.08) 0%, transparent 100%)",
              "radial-gradient(ellipse 30% 30% at 80% 80%, rgba(16,185,129,0.05) 0%, transparent 100%)",
            ].join(", "),
          }}
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
        />

        <Container className="relative pt-5 pb-10 sm:pt-8 sm:pb-16 text-center">
          {/* Logo Equation — single row, no wrap */}
          <Reveal>
            <div className="flex items-center justify-center gap-1 sm:gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              {COMPETITORS.map((app, i) => (
                <Fragment key={app.name}>
                  {i > 0 && (
                    <span className="text-base sm:text-lg font-bold text-accent/40 shrink-0">
                      +
                    </span>
                  )}
                  <div className="flex flex-col items-center gap-0.5 shrink-0">
                    <div className="group/logo h-11 w-11 sm:h-14 sm:w-14 rounded-xl border border-border/50 bg-white/[0.05] p-1 sm:p-1.5 flex items-center justify-center overflow-hidden transition-all duration-300 hover:scale-110 hover:border-accent/50 hover:bg-white/[0.1] hover:shadow-[0_0_20px_rgba(124,58,237,0.2)]">
                      <img
                        src={app.logo}
                        alt={app.name}
                        className="h-full w-full object-contain rounded-lg"
                      />
                    </div>
                    <span className="text-[9px] sm:text-[10px] font-medium text-muted-fg text-center leading-tight max-w-[52px] sm:max-w-[60px] mt-1">
                      {app.name}
                    </span>
                  </div>
                </Fragment>
              ))}
            </div>
          </Reveal>

          {/* = ADE app icon */}
          <Reveal delay={0.08}>
            <div className="mt-3 flex flex-col items-center">
              <span className="text-2xl sm:text-3xl font-black text-accent/70 mb-2">=</span>
              <div className="relative">
                <img
                  src="/images/ade-dock-icon.png"
                  alt="ADE"
                  className="relative h-32 w-32 sm:h-40 sm:w-40 rounded-[22%] object-contain drop-shadow-[0_8px_40px_rgba(124,58,237,0.45)]"
                />
              </div>
            </div>
          </Reveal>

          {/* Headline */}
          <Reveal delay={0.14}>
            <h1 className="mt-4 mx-auto max-w-4xl text-3xl font-bold tracking-tight text-fg sm:text-4xl lg:text-5xl leading-[1.15]">
              Every AI coding tool.{" "}
              <span className="bg-gradient-to-r from-violet-400 via-accent to-indigo-400 bg-clip-text text-transparent animate-gradient-text">
                One app.
              </span>
            </h1>
          </Reveal>

          {/* Subtitle */}
          <Reveal delay={0.18}>
            <p className="mx-auto mt-2.5 max-w-2xl text-sm leading-relaxed text-muted-fg sm:text-base">
              ADE replaces your scattered AI coding tools with a single local-first desktop app.
              Agent chat, parallel missions, git isolation, memory, automations — everything on
              your machine.
            </p>
          </Reveal>

          {/* CTAs */}
          <Reveal delay={0.22}>
            <div className="mt-4 flex flex-wrap justify-center gap-2.5">
              <LinkButton to={LINKS.releases} variant="primary" size="lg" target="_blank" rel="noreferrer">
                <Download className="h-5 w-5" /> Download from GitHub <ArrowUpRight className="h-4 w-4" />
              </LinkButton>
              <LinkButton to={LINKS.github} variant="secondary" size="lg" target="_blank" rel="noreferrer">
                <Github className="h-5 w-5" /> View on GitHub
              </LinkButton>
              <LinkButton to={LINKS.docs} variant="secondary" size="lg" target="_blank" rel="noreferrer">
                <BookOpen className="h-4 w-4" /> Docs <ArrowUpRight className="h-3.5 w-3.5 text-muted-fg" />
              </LinkButton>
            </div>
            <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-fg/40">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Open source &middot; Local-first &middot; macOS &middot; No account required
            </div>
          </Reveal>

          {/* Hero app visual */}
          <Reveal delay={0.26} className="overflow-visible">
            <div className="relative left-1/2 mt-5 w-screen max-w-[100vw] -translate-x-1/2 sm:mt-6 lg:mt-7">
              <HeroVisual />
            </div>
          </Reveal>
        </Container>
      </section>

      <ProductShowcase />

      {/* ── MORE CAPABILITIES ─────────────────── */}
      <section className="border-y border-border/70 bg-card/20 py-16 sm:py-20">
        <Container>
          <Reveal>
            <h2 className="text-2xl font-bold tracking-tight text-fg sm:text-3xl">Also built in</h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-fg sm:text-base">
              Everything below ships in the same app; the gallery above highlights the visuals we are showcasing on
              the site right now.
            </p>
          </Reveal>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ALSO_BUILT_IN.map((cap, idx) => (
              <Reveal key={cap.label} delay={idx * 0.03}>
                <div className="rounded-xl border border-border/70 bg-card/40 p-5 transition-colors hover:bg-card/60">
                  <cap.icon className="h-5 w-5 text-accent" />
                  <div className="mt-3 text-sm font-semibold text-fg">{cap.label}</div>
                  <div className="mt-1 text-sm text-muted-fg">{cap.detail}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      {/* ── QUICKSTART ────────────────────────── */}
      <section id="quickstart" className="scroll-mt-20 py-16 sm:py-24">
        <Container>
          <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
            <div>
              <Reveal>
                <h2 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">
                  Get started in 30 seconds
                </h2>
                <p className="mt-3 max-w-lg text-base text-muted-fg">
                  Download the latest macOS release, move ADE into Applications, and open. No account required.
                </p>
              </Reveal>

              <Reveal delay={0.05}>
                <div className="mt-8">
                  <QuickstartBlock />
                </div>
              </Reveal>
            </div>

            <Reveal delay={0.08}>
              <Card className="p-6">
                <h3 className="text-base font-semibold text-fg">Or build from source</h3>
                <p className="mt-2 text-sm text-muted-fg">
                  Clone the repo and run with Vite + Electron. Also the fastest way to contribute.
                </p>
                <div className="mt-4 rounded-xl border border-border/70 bg-[#0c0a10] p-4 font-mono text-sm leading-relaxed text-muted-fg">
                  <div>
                    <span className="text-accent/70">$</span> git clone https://github.com/
                    {LINKS.repo}.git
                  </div>
                  <div>
                    <span className="text-accent/70">$</span> cd ADE/apps/desktop
                  </div>
                  <div>
                    <span className="text-accent/70">$</span> npm install
                  </div>
                  <div>
                    <span className="text-accent/70">$</span> npm run dev
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  <LinkButton to={LINKS.docs} variant="secondary" size="sm" target="_blank" rel="noreferrer">
                    <BookOpen className="h-4 w-4" /> Docs{" "}
                    <ArrowUpRight className="h-3.5 w-3.5 text-muted-fg" />
                  </LinkButton>
                  <LinkButton to={LINKS.github} variant="secondary" size="sm" target="_blank" rel="noreferrer">
                    <Github className="h-4 w-4" /> Repo{" "}
                    <ArrowUpRight className="h-3.5 w-3.5 text-muted-fg" />
                  </LinkButton>
                </div>
              </Card>
            </Reveal>
          </div>
        </Container>
      </section>

      {/* ── CTA ───────────────────────────────── */}
      <section className="py-16 sm:py-24">
        <Container>
          <Reveal>
            <Card className="relative overflow-hidden p-10 sm:p-14 text-center">
              {/* Subtle radial gradient */}
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--color-accent)_0%,_transparent_70%)] opacity-[0.06]" />

              <div className="relative">
                <h2 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">
                  The last AI coding app you'll download.
                </h2>
                <p className="mt-3 mx-auto max-w-lg text-base text-muted-fg">
                  Free. Open source. Your code never leaves your machine.
                </p>

                <div className="mt-8 flex flex-wrap justify-center gap-3">
                  <LinkButton to={LINKS.releases} variant="primary" size="lg" target="_blank" rel="noreferrer">
                    <Download className="h-5 w-5" /> Download from GitHub <ArrowUpRight className="h-4 w-4" />
                  </LinkButton>
                  <LinkButton to={LINKS.github} variant="secondary" size="lg" target="_blank" rel="noreferrer">
                    <Github className="h-5 w-5" /> Star on GitHub
                  </LinkButton>
                </div>
              </div>
            </Card>
          </Reveal>
        </Container>
      </section>
    </Page>
  );
}
