import { ArrowRight, GitBranch, GitPullRequest, History, Layers3, Play, Settings, Shield, Terminal, Workflow } from "lucide-react";
import { Container } from "../../components/Container";
import { LinkButton } from "../../components/LinkButton";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { ArchitectureDiagram } from "../../components/illustrations/ArchitectureDiagram";

type Highlight = {
  title: string;
  eyebrow: string;
  description: string;
  bullets: string[];
  imageSrc: string;
};

const HIGHLIGHTS: Highlight[] = [
  {
    eyebrow: "Run",
    title: "Your stack, one click at a time",
    description:
      "Start and monitor managed processes, run test suites, and edit project configuration in a single command center.",
    bullets: [
      "Process lifecycle + readiness checks + logs",
      "Test suite runner with history and outcomes",
      "Lane-aware execution context"
    ],
    imageSrc: "/images/features/run.svg"
  },
  {
    eyebrow: "Files",
    title: "Browse and edit without leaving the cockpit",
    description:
      "A fast file explorer and editor for lane workspaces, with diffs and conflict-aware modes so you can fix and validate quickly.",
    bullets: [
      "Workspace-scoped file trees with git status hints",
      "Monaco editor + quick open + cross-file search",
      "Diff and conflict workflows alongside lanes"
    ],
    imageSrc: "/images/features/files.svg"
  },
  {
    eyebrow: "Lanes",
    title: "Parallel work, first-class",
    description:
      "Spin up worktree-backed lanes, stack them, restack them, and keep each execution surface visible and measurable.",
    bullets: [
      "Lane types: Primary, Worktree, Attached",
      "Stacks for layered branch workflows",
      "High-density status: dirty/clean, ahead/behind, risk, last activity"
    ],
    imageSrc: "/images/features/lanes.svg"
  },
  {
    eyebrow: "Packs",
    title: "Durable context you can trust",
    description:
      "Packs are ADE’s versioned context system. It captures checkpoints, touched files, and validation signals so you can hand off work without losing the thread.",
    bullets: [
      "Project, lane, feature, plan, and conflict packs",
      "Immutable checkpoints at session and commit boundaries",
      "Template narratives locally; LLM narratives optional"
    ],
    imageSrc: "/images/features/packs.svg"
  },
  {
    eyebrow: "Conflict Radar",
    title: "Predict conflicts before merge day",
    description:
      "ADE watches parallel lanes and surfaces integration risk early. When conflicts are likely, it bundles the evidence into a conflict pack and proposes resolution paths.",
    bullets: [
      "Risk scoring across overlapping file surfaces",
      "Merge simulation + conflict diffs",
      "Patch proposals shown as diffs for review"
    ],
    imageSrc: "/images/features/conflicts.svg"
  },
  {
    eyebrow: "Terminals",
    title: "Sessions with observability",
    description:
      "Every terminal session is a tracked execution unit: transcripts, deltas, start/end SHAs, and outcomes. Keep the raw logs and the summarized intent together.",
    bullets: [
      "PTY terminals + transcript capture",
      "Session deltas (files changed, insertions/deletions)",
      "Optional untracked sessions when you want silence"
    ],
    imageSrc: "/images/features/terminals.svg"
  },
  {
    eyebrow: "Graph + GitHub",
    title: "See the workspace as a system",
    description:
      "From stack topology to PR status to risk edges, the workspace graph gives you a visual model of parallel work. GitHub integration makes PRs part of the cockpit.",
    bullets: [
      "Workspace graph canvas (stack/risk/activity)",
      "PR CRUD + polling + stacked PR workflows",
      "Lane-to-PR linking and land flow support"
    ],
    imageSrc: "/images/features/graph.svg"
  },
  {
    eyebrow: "Automations",
    title: "Jobs and rules, not rituals",
    description:
      "ADE’s job engine refreshes lane state, packs, and risk signals. Automations let you turn events into actions with history and guardrails.",
    bullets: [
      "Event-driven job pipeline with coalescing",
      "Trigger-action rules + execution history",
      "Designed to be safe and inspectable"
    ],
    imageSrc: "/images/features/automations.svg"
  }
];

export function HomePage() {
  useDocumentTitle("ADE — Mission control for agentic development");

  return (
    <Page>
      <section className="relative overflow-hidden py-16 sm:py-20">
        <Container>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <Reveal>
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-fg">
                  <span className="inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
                  Agentic Development Environment
                </div>
              </Reveal>
              <Reveal delay={0.05}>
                <h1 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight text-fg sm:text-5xl">
                  Mission control for agentic development.
                </h1>
              </Reveal>
              <Reveal delay={0.1}>
                <p className="mt-4 max-w-xl text-pretty text-base leading-relaxed text-muted-fg sm:text-lg">
                  ADE is a desktop cockpit that keeps parallel lanes, sessions, packs, and conflicts visible
                  while you run multiple AI coding agents across branches.
                </p>
              </Reveal>

              <Reveal delay={0.14}>
                <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <LinkButton to="/download" size="lg" variant="primary">
                    Download ADE <ArrowRight className="h-4 w-4" />
                  </LinkButton>
                  <LinkButton to={LINKS.prd} size="lg" variant="secondary" target="_blank" rel="noreferrer">
                    Read the PRD
                  </LinkButton>
                </div>
              </Reveal>

              <Reveal delay={0.18}>
                <div className="mt-8 grid gap-3 rounded-xl border border-border bg-card/60 p-4 text-sm text-muted-fg">
                  <div className="flex items-start gap-3">
                    <Shield className="mt-0.5 h-4 w-4 text-fg/70" />
                    <div>
                      <div className="font-semibold text-fg">Local-first trust boundary</div>
                      <div className="mt-0.5">
                        The main process is the only component with file/process access; the UI talks over typed IPC.
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Workflow className="mt-0.5 h-4 w-4 text-fg/70" />
                    <div>
                      <div className="font-semibold text-fg">Hosted agent is read-only</div>
                      <div className="mt-0.5">
                        When enabled, the cloud side mirrors content and returns narratives + patch proposals as diffs for review.
                      </div>
                    </div>
                  </div>
                </div>
              </Reveal>
            </div>

            <Reveal className="relative">
              <div className="float-slow absolute -right-10 -top-10 hidden h-44 w-44 rounded-full bg-gradient-to-br from-[rgba(85,211,255,0.28)] to-[rgba(27,118,255,0.18)] blur-2xl lg:block" />
              <div className="relative overflow-hidden rounded-[28px] border border-border bg-card/60 shadow-glass-md">
                <div className="flex items-center gap-2 border-b border-border bg-card/70 px-4 py-3">
                  <span className="h-3 w-3 rounded-full bg-[rgba(255,93,93,0.85)]" />
                  <span className="h-3 w-3 rounded-full bg-[rgba(255,201,61,0.85)]" />
                  <span className="h-3 w-3 rounded-full bg-[rgba(85,255,178,0.85)]" />
                  <div className="ml-2 text-xs font-medium text-muted-fg">Lanes • Packs • Conflicts</div>
                </div>
                <img
                  src="/images/features/lanes.svg"
                  alt="Illustration of lanes and stacks in ADE"
                  className="block w-full"
                  loading="eager"
                />
              </div>

              <div className="pointer-events-none absolute -bottom-6 left-6 hidden rounded-2xl border border-border bg-card/70 p-4 shadow-glass-md lg:block">
                <div className="flex items-center gap-3">
                  <GitBranch className="h-5 w-5 text-fg/70" />
                  <div>
                    <div className="text-sm font-semibold text-fg">Worktrees + stacks</div>
                    <div className="text-xs text-muted-fg">Manage 3–10+ lanes without losing the plot.</div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </Container>
      </section>

      <section id="product" className="scroll-mt-24 py-14">
        <Container>
          <Reveal>
            <div className="grid gap-8 rounded-[26px] border border-border bg-card/60 p-8 shadow-glass-sm lg:grid-cols-2">
              <div>
                <div className="text-sm font-semibold text-fg">What ADE is</div>
                <p className="mt-3 text-sm leading-relaxed text-muted-fg">
                  A development operations cockpit for agentic coding workflows. ADE doesn’t replace your IDE and it
                  doesn’t run agents. It observes, orchestrates, and makes parallel work legible.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-card/70 p-4">
                  <div className="text-xs font-semibold text-fg">Context fragmentation</div>
                  <div className="mt-1 text-xs text-muted-fg">
                    Packs and checkpoints keep a durable record of intent, deltas, and validation.
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card/70 p-4">
                  <div className="text-xs font-semibold text-fg">Integration risk</div>
                  <div className="mt-1 text-xs text-muted-fg">
                    Conflict radar predicts overlaps across parallel lanes before merge time.
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card/70 p-4">
                  <div className="text-xs font-semibold text-fg">Context switching</div>
                  <div className="mt-1 text-xs text-muted-fg">
                    One cockpit for lanes, terminals, diffs, tests, PRs, and history.
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card/70 p-4">
                  <div className="text-xs font-semibold text-fg">Observability</div>
                  <div className="mt-1 text-xs text-muted-fg">
                    Sessions are tracked units with transcripts, SHAs, and change deltas.
                  </div>
                </div>
              </div>
            </div>
          </Reveal>
        </Container>
      </section>

      <section id="features" className="scroll-mt-24 py-14">
        <Container>
          <Reveal>
            <div className="flex items-end justify-between gap-6">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-fg">Features</div>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                  Built around parallel work.
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-fg">
                  ADE’s surfaces map to how agentic teams actually work: lanes for parallel branches, packs for
                  context durability, conflict prediction for integration safety, and GitHub-aware workflows.
                </p>
              </div>
              <div className="hidden sm:flex">
                <LinkButton to="/download" variant="secondary">
                  Get ADE <ArrowRight className="h-4 w-4" />
                </LinkButton>
              </div>
            </div>
          </Reveal>

          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {[
              { icon: <Play className="h-5 w-5" />, title: "Run", text: "Processes, tests, config, and agent tool discovery." },
              { icon: <Layers3 className="h-5 w-5" />, title: "Lanes", text: "Worktrees, diffs, git operations, stacks." },
              { icon: <Settings className="h-5 w-5" />, title: "Settings", text: "Onboarding, provider modes, profiles." },
              { icon: <Terminal className="h-5 w-5" />, title: "Terminals", text: "Tracked sessions, transcripts, deltas." },
              { icon: <GitPullRequest className="h-5 w-5" />, title: "PRs", text: "GitHub integration + stacked PR flows." },
              { icon: <History className="h-5 w-5" />, title: "History", text: "Operations timeline + checkpoints." }
            ].map((item, idx) => (
              <Reveal key={item.title} delay={idx * 0.03}>
                <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                  <div className="flex items-center gap-3">
                    <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card/80 text-fg">
                      {item.icon}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-fg">{item.title}</div>
                      <div className="mt-1 text-sm text-muted-fg">{item.text}</div>
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      <section className="py-14">
        <Container className="space-y-14">
          {HIGHLIGHTS.map((h, idx) => {
            const reverse = idx % 2 === 1;
            return (
              <div
                key={h.title}
                className="grid items-center gap-10 lg:grid-cols-2"
              >
                <Reveal className={reverse ? "lg:order-2" : undefined}>
                  <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-semibold text-muted-fg">
                    {h.eyebrow}
                  </div>
                  <h3 className="mt-4 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                    {h.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-muted-fg">{h.description}</p>
                  <ul className="mt-5 space-y-2 text-sm text-muted-fg">
                    {h.bullets.map((b) => (
                      <li key={b} className="flex gap-3">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </Reveal>

                <Reveal delay={0.05} className={reverse ? "lg:order-1" : undefined}>
                  <div className="overflow-hidden rounded-[28px] border border-border bg-card/60 shadow-glass-md">
                    <img src={h.imageSrc} alt={`${h.eyebrow} illustration`} className="block w-full" loading="lazy" />
                  </div>
                </Reveal>
              </div>
            );
          })}
        </Container>
      </section>

      <section id="architecture" className="scroll-mt-24 py-14">
        <Container>
          <Reveal>
            <div className="grid gap-10 rounded-[28px] border border-border bg-card/60 p-8 shadow-glass-sm lg:grid-cols-2 lg:items-center">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-fg">Architecture</div>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-fg">A strict trust boundary.</h2>
                <p className="mt-3 text-sm leading-relaxed text-muted-fg">
                  ADE keeps filesystem, Git, and process access in the Electron main process. The renderer UI stays
                  untrusted and calls a narrow IPC surface via the preload bridge. Hosted features are designed as
                  read-only: the cloud returns narratives and patch proposals for review.
                </p>
                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <LinkButton to={LINKS.docs} variant="secondary" target="_blank" rel="noreferrer">
                    View architecture docs
                  </LinkButton>
                  <LinkButton to="/download" variant="primary">
                    Download
                  </LinkButton>
                </div>
              </div>
              <div className="overflow-hidden rounded-[22px] border border-border bg-card/70 p-4">
                <ArchitectureDiagram className="w-full" />
              </div>
            </div>
          </Reveal>
        </Container>
      </section>

      <section id="faq" className="scroll-mt-24 py-14">
        <Container>
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-tight text-fg">FAQ</h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-fg">
              A few answers to the questions people ask right before they try running multiple agents across multiple lanes.
            </p>
          </Reveal>

          <div className="mt-8 grid gap-4">
            {[
              {
                q: "Does ADE run AI agents?",
                a: "No. ADE doesn’t replace your IDE and it doesn’t run agents. It orchestrates work surfaces, captures context, predicts conflicts, and keeps operations observable."
              },
              {
                q: "Can I use ADE without cloud features?",
                a: "Yes. Guest Mode supports local features (lanes, terminals, git operations, processes, tests). Hosted narratives and conflict proposals are optional."
              },
              {
                q: "What does “read-only hosted agent” mean?",
                a: "The hosted side never mutates your repo. It produces narratives and patch proposals which ADE shows as diffs for local review and application."
              },
              {
                q: "Is ADE only for stacked PR workflows?",
                a: "No. Stacks are a first-class workflow, but ADE is useful for any parallel branching strategy where integration risk and context loss are common."
              }
            ].map((item, idx) => (
              <Reveal key={item.q} delay={idx * 0.03}>
                <details className="group rounded-[18px] border border-border bg-card/60 p-5 shadow-glass-sm">
                  <summary className="cursor-pointer list-none text-sm font-semibold text-fg">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      {item.q}
                    </span>
                    <span className="ade-details-chevron float-right text-muted-fg transition-transform">›</span>
                  </summary>
                  <div className="mt-3 text-sm leading-relaxed text-muted-fg">{item.a}</div>
                </details>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      <section className="py-16">
        <Container>
          <Reveal>
            <div className="relative overflow-hidden rounded-[30px] border border-border bg-gradient-to-br from-[rgba(27,118,255,0.14)] to-[rgba(85,211,255,0.10)] p-10 shadow-glass-md">
              <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-[rgba(85,211,255,0.18)] blur-3xl" />
              <div className="relative">
                <div className="text-sm font-semibold text-fg">Ready to run parallel work without chaos?</div>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                  Download ADE and make lanes legible.
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-fg">
                  Start in Guest Mode, add hosted or BYOK provider support when you’re ready, and keep every session measurable.
                </p>
                <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                  <LinkButton to="/download" size="lg" variant="primary">
                    Download <ArrowRight className="h-4 w-4" />
                  </LinkButton>
                  <LinkButton to={LINKS.github} size="lg" variant="secondary" target="_blank" rel="noreferrer">
                    View on GitHub
                  </LinkButton>
                </div>
              </div>
            </div>
          </Reveal>
        </Container>
      </section>
    </Page>
  );
}
