import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Copy,
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
import { useCallback, useState } from "react";
import { Container } from "../../components/Container";
import { Card } from "../../components/Card";
import { LinkButton } from "../../components/LinkButton";
import { Reveal } from "../../components/Reveal";
import { Page } from "../../components/Page";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

/* ──────────────────────────────────────────────
   Feature data
   ────────────────────────────────────────────── */

const FEATURES = [
  {
    icon: GitBranch,
    name: "Lanes",
    tagline: "Parallel worktrees with conflict detection",
    description:
      "Each agent works in its own isolated git worktree. Run builds, tests, and installs simultaneously across branches without touching main.",
    color: "text-violet-400",
    bgColor: "bg-violet-500/10",
    borderColor: "border-violet-500/20",
    screenshotLabel: "Lanes View",
  },
  {
    icon: Target,
    name: "Missions",
    tagline: "Multi-step orchestrated execution",
    description:
      "Break complex tasks into planned steps. Review the execution plan, approve it, then watch agents work through each step with full visibility.",
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    screenshotLabel: "Mission Planner",
  },
  {
    icon: Bot,
    name: "CTO Agent",
    tagline: "Persistent AI project lead with memory",
    description:
      "A long-lived agent that understands your project architecture, remembers past decisions, and delegates work to coding agents via Linear integration.",
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "border-emerald-500/20",
    screenshotLabel: "CTO Agent Chat",
  },
  {
    icon: Terminal,
    name: "Agent Chat",
    tagline: "Multi-provider coding agents",
    description:
      "Chat with Claude, Codex, or local models. Every agent gets its own terminal, file access, and tool suite. BYOK or use any provider.",
    color: "text-sky-400",
    bgColor: "bg-sky-500/10",
    borderColor: "border-sky-500/20",
    screenshotLabel: "Agent Chat Session",
  },
  {
    icon: Zap,
    name: "Automations",
    tagline: "Event-driven background execution",
    description:
      "Define rules that trigger agents on events like push, PR creation, or schedule. Set budget caps and guardrails per automation.",
    color: "text-rose-400",
    bgColor: "bg-rose-500/10",
    borderColor: "border-rose-500/20",
    screenshotLabel: "Automation Rules",
  },
  {
    icon: Package,
    name: "Context Packs",
    tagline: "Structured context for agents",
    description:
      "Bundle project docs, architecture decisions, and conventions into packs that agents consume automatically. No more repeating yourself.",
    color: "text-indigo-400",
    bgColor: "bg-indigo-500/10",
    borderColor: "border-indigo-500/20",
    screenshotLabel: "Context Pack Editor",
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
  const [copied, setCopied] = useState(false);

  const xattrCmd = 'xattr -dr com.apple.quarantine /Applications/ADE.app';

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(xattrCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no-op
    }
  }, [xattrCmd]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-xs font-bold text-accent">1</span>
          Download the latest release
        </div>
        <LinkButton to={LINKS.releases} variant="secondary" size="md" target="_blank" rel="noreferrer">
          <Download className="h-4 w-4" /> Download DMG from GitHub <ArrowUpRight className="h-3.5 w-3.5 text-muted-fg" />
        </LinkButton>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-xs font-bold text-accent">2</span>
          Clear Gatekeeper (unsigned build)
        </div>
        <div className="group relative rounded-xl border border-border/70 bg-[#0c0a10] p-4">
          <code className="block text-sm leading-relaxed text-muted-fg select-all">
            {xattrCmd}
          </code>
          <button
            type="button"
            onClick={onCopy}
            className="absolute right-3 top-3 rounded-md border border-border/70 bg-card/70 p-1.5 text-muted-fg opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg"
            aria-label="Copy command"
          >
            {copied ? <span className="text-xs px-1">Copied</span> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-xs font-bold text-accent">3</span>
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
   Screenshot placeholder
   ────────────────────────────────────────────── */

function ScreenshotPlaceholder({
  label,
  aspectClass = "aspect-video",
  className,
}: {
  label: string;
  aspectClass?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/70 bg-surface/60",
        aspectClass,
        className
      )}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6">
        <div className="h-10 w-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
          <MonitorCheck className="h-5 w-5 text-accent/60" />
        </div>
        <span className="text-sm font-medium text-muted-fg/70 text-center">
          Screenshot: {label}
        </span>
      </div>
      {/* Subtle grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />
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
      {/* ── HERO ─────────────────────────────── */}
      <section className="relative overflow-hidden">
        {/* Background accent blobs */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-[300px] left-1/2 -translate-x-1/2 h-[600px] w-[900px] rounded-full bg-accent/8 blur-[120px]" />
          <div className="absolute top-[200px] -right-[200px] h-[400px] w-[400px] rounded-full bg-indigo-500/6 blur-[100px]" />
        </div>

        <Container className="relative pt-20 pb-16 sm:pt-28 sm:pb-24">
          <Reveal>
            <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-fg sm:text-5xl lg:text-6xl leading-[1.1]">
              Orchestrate parallel AI agents from your desktop.
            </h1>
          </Reveal>

          <Reveal delay={0.05}>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-fg sm:text-xl">
              ADE is a local-first Electron app that isolates coding agents into git worktrees,
              plans multi-step missions, and tracks every command they run.
              Your code stays on your machine.
            </p>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton to="/download" variant="primary" size="lg">
                <Download className="h-5 w-5" /> Download for macOS
              </LinkButton>
              <LinkButton to={LINKS.github} variant="secondary" size="lg" target="_blank" rel="noreferrer">
                <Github className="h-5 w-5" /> View on GitHub
              </LinkButton>
              <LinkButton to={LINKS.docs} variant="secondary" size="lg" target="_blank" rel="noreferrer">
                <BookOpen className="h-4 w-4" /> Docs <ArrowUpRight className="h-3.5 w-3.5 text-muted-fg" />
              </LinkButton>
            </div>
          </Reveal>

          {/* Hero screenshot placeholder */}
          <Reveal delay={0.15}>
            <div className="mt-14">
              <div className="rounded-2xl border border-border/70 bg-card/40 p-2 shadow-glass-md">
                {/* Mock window chrome */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <div className="flex gap-1.5">
                    <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                    <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
                    <div className="h-3 w-3 rounded-full bg-[#28c840]" />
                  </div>
                  <div className="mx-auto text-xs text-muted-fg/50">ADE Desktop</div>
                </div>
                <ScreenshotPlaceholder
                  label="ADE Workspace Overview"
                  aspectClass="aspect-[16/9]"
                />
              </div>
            </div>
          </Reveal>
        </Container>
      </section>

      {/* ── FEATURES ──────────────────────────── */}
      <section id="features" className="scroll-mt-20 py-16 sm:py-24">
        <Container>
          <Reveal>
            <h2 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">
              What you get
            </h2>
            <p className="mt-3 max-w-xl text-base text-muted-fg">
              Everything needed to run multiple AI coding agents in parallel, safely.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, idx) => (
              <Reveal key={f.name} delay={idx * 0.04}>
                <Card className="group flex h-full flex-col p-6 transition-all duration-300 hover:border-border hover:bg-card/70 hover:shadow-glass-md">
                  <div className="flex items-start gap-4">
                    <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border", f.bgColor, f.borderColor)}>
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
                  <div className="mt-5">
                    <ScreenshotPlaceholder
                      label={f.screenshotLabel}
                      aspectClass="aspect-[4/3]"
                    />
                  </div>
                </Card>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      {/* ── MORE CAPABILITIES ─────────────────── */}
      <section className="border-y border-border/70 bg-card/20 py-16 sm:py-20">
        <Container>
          <Reveal>
            <h2 className="text-2xl font-bold tracking-tight text-fg sm:text-3xl">
              Also built in
            </h2>
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
                  Download the DMG, clear Gatekeeper, and open. No account required.
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
                  <div><span className="text-accent/70">$</span> git clone https://github.com/{LINKS.repo}.git</div>
                  <div><span className="text-accent/70">$</span> cd ADE/apps/desktop</div>
                  <div><span className="text-accent/70">$</span> npm install</div>
                  <div><span className="text-accent/70">$</span> npm run dev</div>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  <LinkButton to={LINKS.docs} variant="secondary" size="sm" target="_blank" rel="noreferrer">
                    <BookOpen className="h-4 w-4" /> Docs <ArrowUpRight className="h-3.5 w-3.5 text-muted-fg" />
                  </LinkButton>
                  <LinkButton to={LINKS.github} variant="secondary" size="sm" target="_blank" rel="noreferrer">
                    <Github className="h-4 w-4" /> Repo <ArrowUpRight className="h-3.5 w-3.5 text-muted-fg" />
                  </LinkButton>
                </div>
              </Card>
            </Reveal>
          </div>
        </Container>
      </section>

      {/* ── LINKS / CTA ───────────────────────── */}
      <section className="py-16 sm:py-24">
        <Container>
          <Reveal>
            <Card className="relative overflow-hidden p-10 sm:p-14 text-center">
              {/* Subtle radial gradient */}
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--color-accent)_0%,_transparent_70%)] opacity-[0.04]" />

              <div className="relative">
                <h2 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">
                  Local-first. Open source.
                </h2>
                <p className="mt-3 mx-auto max-w-lg text-base text-muted-fg">
                  Your source code never leaves your machine. ADE orchestrates agents locally
                  and treats all output as diffs you explicitly apply.
                </p>

                <div className="mt-8 flex flex-wrap justify-center gap-3">
                  <LinkButton to="/download" variant="primary" size="lg">
                    <Download className="h-5 w-5" /> Download ADE
                  </LinkButton>
                  <LinkButton to={LINKS.github} variant="secondary" size="lg" target="_blank" rel="noreferrer">
                    <Github className="h-5 w-5" /> Star on GitHub
                  </LinkButton>
                  <LinkButton to={LINKS.docs} variant="secondary" size="lg" target="_blank" rel="noreferrer">
                    <BookOpen className="h-4 w-4" /> Documentation
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
