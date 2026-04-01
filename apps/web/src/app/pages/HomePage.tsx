import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Download,
  GitBranch,
  Github,
  Layers,
  MonitorCheck,
  Package,
  Play,
  Settings2,
  Target,
  Terminal,
  Zap,
} from "lucide-react";
import { Fragment } from "react";
import { Container } from "../../components/Container";
import { Card } from "../../components/Card";
import { LinkButton } from "../../components/LinkButton";
import { Reveal } from "../../components/Reveal";
import { Page } from "../../components/Page";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

import { HeroVisual } from "../../components/ui/HeroVisual";
import { CanvasDemo } from "../../components/ui/CanvasDemo";

/* ──────────────────────────────────────────────
   Competitor apps that ADE replaces
   ────────────────────────────────────────────── */

const COMPETITORS = [
  { name: "Claude Code", logo: "/images/competitors/claude-code.png" },
  { name: "Codex", logo: "/images/competitors/codex.png" },
  { name: "OpenCode", logo: "/images/competitors/opencode.png" },
  { name: "T3 Code", logo: "/images/competitors/t3-code.png" },
  { name: "Superset", logo: "/images/competitors/superset.png" },
  { name: "Conductor", logo: "/images/competitors/conductor.png" },
  { name: "Factory", logo: "/images/competitors/factory.png" },
  { name: "Paperclip", logo: "/images/competitors/paperclip.png" },
  { name: "OpenClaw", logo: "/images/competitors/openclaw.png" },
  { name: "Symphony", logo: "/images/competitors/symphony.png" },
] as const;

/* ──────────────────────────────────────────────
   Feature data
   ────────────────────────────────────────────── */

/* ──────────────────────────────────────────────
   Feature Placeholder (until real screenshots)
   ────────────────────────────────────────────── */

function FeaturePlaceholder({ colorClass }: { colorClass: string }) {
  return (
    <div className="relative w-full h-full bg-[#0a0a0f] overflow-hidden flex flex-col">
      {/* Abstract background glow */}
      <div className={cn("absolute -top-10 -right-10 w-32 h-32 rounded-full blur-[40px] opacity-20", colorClass.replace("text-", "bg-"))} />
      <div className={cn("absolute -bottom-10 -left-10 w-32 h-32 rounded-full blur-[40px] opacity-10", colorClass.replace("text-", "bg-"))} />
      
      {/* Mock Window Header */}
      <div className="h-6 border-b border-white/5 flex items-center px-3 gap-1.5 shrink-0 bg-white/[0.02]">
        <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
        <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
        <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
      </div>
      
      {/* Mock content */}
      <div className="flex-1 p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3 w-full">
          <div className="w-8 h-8 rounded-lg bg-white/5 shrink-0" />
          <div className="space-y-1.5 flex-1">
            <div className="h-2 w-1/3 bg-white/10 rounded-full" />
            <div className="h-2 w-1/4 bg-white/5 rounded-full" />
          </div>
        </div>
        <div className="flex-1 rounded-lg border border-white/5 bg-white/[0.01] p-3 flex flex-col gap-2">
           <div className="h-1.5 w-full bg-white/5 rounded-full" />
           <div className="h-1.5 w-[90%] bg-white/5 rounded-full" />
           <div className="h-1.5 w-[95%] bg-white/5 rounded-full" />
           <div className="h-1.5 w-[80%] bg-white/5 rounded-full" />
           <div className={cn("h-1.5 w-[40%] rounded-full mt-auto opacity-40", colorClass.replace("text-", "bg-"))} />
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    icon: Terminal,
    name: "Agent Chat",
    tagline: "Multi-provider coding agents",
    description:
      "Chat with Claude, Codex, or local models. Every agent gets its own terminal, file access, and MCP tool suite. BYOK — bring any provider.",
    color: "text-sky-400",
    bgColor: "bg-sky-500/10",
    borderColor: "border-sky-500/20",
  },
  {
    icon: GitBranch,
    name: "Lanes",
    tagline: "Parallel git worktrees",
    description:
      "Each agent works in its own isolated git worktree. Run builds, tests, and installs across branches simultaneously — zero conflicts.",
    color: "text-violet-400",
    bgColor: "bg-violet-500/10",
    borderColor: "border-violet-500/20",
  },
  {
    icon: Target,
    name: "Missions",
    tagline: "Multi-step orchestrated execution",
    description:
      "Break complex tasks into planned DAGs. Watch agents work through each step with full visibility — built-in planning, testing, and PR phases.",
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
  },
  {
    icon: Bot,
    name: "CTO Agent",
    tagline: "Persistent AI lead with memory",
    description:
      "A long-lived agent that understands your architecture, remembers past decisions, manages a team of workers, and syncs with Linear.",
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "border-emerald-500/20",
  },
  {
    icon: Zap,
    name: "Automations",
    tagline: "Event-driven background agents",
    description:
      "Trigger agents on push, PR creation, or schedule. Set budget caps and guardrails per automation. Your agents work while you sleep.",
    color: "text-rose-400",
    bgColor: "bg-rose-500/10",
    borderColor: "border-rose-500/20",
  },
  {
    icon: Package,
    name: "Unified Memory",
    tagline: "Agents that actually remember",
    description:
      "Vector-indexed memory across projects, agents, and missions. Your agents learn from past work and share knowledge automatically.",
    color: "text-indigo-400",
    bgColor: "bg-indigo-500/10",
    borderColor: "border-indigo-500/20",
  },
] as const;

const CAPABILITIES = [
  { icon: MonitorCheck, label: "Computer Use", detail: "Screenshot-based verification of agent output" },
  { icon: Layers, label: "35+ MCP Tools", detail: "Built-in server for file ops, git, search, and more" },
  { icon: Settings2, label: "Multi-Provider", detail: "Claude, Codex, Gemini, local models via BYOK" },
  { icon: Play, label: "Process Monitor", detail: "Track every terminal command and its output" },
];

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
      <section className="relative overflow-hidden">
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
                    <span className="text-[8px] sm:text-[9px] text-muted-fg/40 text-center leading-tight max-w-[48px] sm:max-w-[56px] mt-1">
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
                  src="/images/ade-mark.svg"
                  alt="ADE"
                  className="relative h-20 w-20 sm:h-24 sm:w-24 drop-shadow-[0_4px_20px_rgba(124,58,237,0.35)]"
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
          <Reveal delay={0.26}>
            <div className="mt-12 lg:mt-16 w-full flex justify-center">
              <HeroVisual />
            </div>
          </Reveal>
        </Container>
      </section>

      {/* ── FEATURES ──────────────────────────── */}
      <section id="features" className="scroll-mt-20 py-16 sm:py-24">
        <Container>
          <Reveal>
            <h2 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">What you get</h2>
            <p className="mt-3 max-w-xl text-base text-muted-fg">
              Everything you need to run AI coding agents — from a single chat to a full team of
              autonomous workers.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, idx) => (
              <Reveal key={f.name} delay={idx * 0.04}>
                <Card className="group flex h-full flex-col p-6 transition-all duration-300 hover:border-border hover:bg-card/70 hover:shadow-[0_0_30px_rgba(124,58,237,0.08)]">
                  <div className="flex items-start gap-4">
                    <div
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border",
                        f.bgColor,
                        f.borderColor,
                      )}
                    >
                      <f.icon className={cn("h-5 w-5", f.color)} />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-fg">{f.name}</h3>
                      <p className="mt-0.5 text-sm text-muted-fg">{f.tagline}</p>
                    </div>
                  </div>
                  <p className="mt-4 flex-1 text-sm leading-relaxed text-muted-fg">
                    {f.description}
                  </p>
                  <div className="mt-5 overflow-hidden rounded-xl border border-border/40 bg-surface/30 aspect-[4/3] group-hover:border-border/80 transition-colors relative">
                    <FeaturePlaceholder colorClass={f.color} />
                  </div>
                </Card>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      {/* ── INTERACTIVE CANVAS DEMO ────────────── */}
      <section className="py-16 sm:py-24 overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-accent/5 to-transparent pointer-events-none" />
        <Container>
          <Reveal>
            <div className="text-center mb-10">
              <h2 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">Merge features instantly</h2>
              <p className="mt-3 mx-auto max-w-xl text-base text-muted-fg">
                Drag a feature branch onto main to see how ADE handles automatic context merging.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="max-w-5xl mx-auto">
              <CanvasDemo />
            </div>
          </Reveal>
        </Container>
      </section>

      {/* ── MORE CAPABILITIES ─────────────────── */}
      <section className="border-y border-border/70 bg-card/20 py-16 sm:py-20">
        <Container>
          <Reveal>
            <h2 className="text-2xl font-bold tracking-tight text-fg sm:text-3xl">Also built in</h2>
          </Reveal>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {CAPABILITIES.map((cap, idx) => (
              <Reveal key={cap.label} delay={idx * 0.04}>
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
