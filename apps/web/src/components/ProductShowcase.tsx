import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Bot,
  FileEdit,
  GitBranch,
  GitPullRequest,
  KeyRound,
  MessageSquare,
  Package,
  Share2,
  SquareTerminal,
  Workflow,
  Zap,
} from "lucide-react";
import { Container } from "./Container";
import { FeaturePlaceholder } from "./FeaturePlaceholder";
import { cn } from "../lib/cn";
import { ADE_EASE_OUT } from "../lib/motion";

const PROVIDERS = [
  "Claude",
  "Codex",
  "Gemini",
  "OpenAI-compatible",
  "Local models",
  "BYOK",
  "Your subscription",
] as const;

function ScreenshotSlot({
  slug,
  colorClass,
  className,
}: {
  slug: string;
  colorClass: string;
  className?: string;
}) {
  const [useFallback, setUseFallback] = useState(false);
  const src = `/images/screenshots/${slug}.png`;

  return (
    <div
      className={cn(
        "relative aspect-[16/10] overflow-hidden rounded-xl border border-border/50 bg-black/30",
        className,
      )}
      title={`Add screenshot: apps/web/public/images/screenshots/${slug}.png`}
    >
      {!useFallback ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover object-top"
          loading="lazy"
          decoding="async"
          onError={() => setUseFallback(true)}
        />
      ) : (
        <FeaturePlaceholder colorClass={colorClass} />
      )}
    </div>
  );
}

type ProductItem = {
  slug: string;
  icon: LucideIcon;
  name: string;
  tagline: string;
  description: string;
  color: string;
  bgColor: string;
  borderColor: string;
  colSpan: string;
  variant?: "chat";
};

const ITEMS: ProductItem[] = [
  {
    slug: "agent-chat",
    icon: MessageSquare,
    name: "Agent chat",
    tagline: "Native · multi-provider",
    description:
      "First-class sessions with tools and context — Claude, Codex, Gemini, local models, and what you already subscribe to. Not a browser bolt-on.",
    color: "text-sky-400",
    bgColor: "bg-sky-500/10",
    borderColor: "border-sky-500/20",
    colSpan: "lg:col-span-7",
    variant: "chat",
  },
  {
    slug: "lanes",
    icon: GitBranch,
    name: "Lanes",
    tagline: "Parallel git worktrees",
    description:
      "Each agent in its own worktree — run builds, tests, and installs at the same time without stepping on the same tree.",
    color: "text-violet-400",
    bgColor: "bg-violet-500/10",
    borderColor: "border-violet-500/20",
    colSpan: "lg:col-span-5",
  },
  {
    slug: "terminals",
    icon: SquareTerminal,
    name: "Terminals",
    tagline: "Real PTY output",
    description: "Shells with live streams so you see every command agents run and every line of output.",
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "border-emerald-500/20",
    colSpan: "lg:col-span-4",
  },
  {
    slug: "prs",
    icon: GitPullRequest,
    name: "PRs",
    tagline: "Review in one place",
    description: "Open, review, and track pull requests from the same desktop shell as your agents.",
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    colSpan: "lg:col-span-4",
  },
  {
    slug: "graph",
    icon: Share2,
    name: "Workspace graph",
    tagline: "See how work connects",
    description: "A visual map of your workspace — including how PRs and lanes relate to the repo.",
    color: "text-cyan-400",
    bgColor: "bg-cyan-500/10",
    borderColor: "border-cyan-500/20",
    colSpan: "lg:col-span-4",
  },
  {
    slug: "files",
    icon: FileEdit,
    name: "Files",
    tagline: "Edit in place",
    description: "Jump from chat or review into the file surface without losing context.",
    color: "text-rose-400",
    bgColor: "bg-rose-500/10",
    borderColor: "border-rose-500/20",
    colSpan: "lg:col-span-4",
  },
  {
    slug: "cto-agent",
    icon: Bot,
    name: "CTO agent",
    tagline: "Persistent lead with memory",
    description:
      "A long-lived agent for architecture and decisions — orchestration-style lead inside the app, with Linear and team workflows.",
    color: "text-indigo-400",
    bgColor: "bg-indigo-500/10",
    borderColor: "border-indigo-500/20",
    colSpan: "lg:col-span-4",
  },
  {
    slug: "missions",
    icon: Workflow,
    name: "Missions",
    tagline: "Coordinated multi-step runs",
    description:
      "Planned DAGs with visibility across phases — planning, testing, PRs — not one-off chat blasts.",
    color: "text-fuchsia-400",
    bgColor: "bg-fuchsia-500/10",
    borderColor: "border-fuchsia-500/20",
    colSpan: "lg:col-span-4",
  },
  {
    slug: "automations",
    icon: Zap,
    name: "Automations",
    tagline: "Event-driven agents",
    description:
      "Trigger on push, PR events, or schedules — with budgets and guardrails while you are away.",
    color: "text-orange-400",
    bgColor: "bg-orange-500/10",
    borderColor: "border-orange-500/20",
    colSpan: "lg:col-span-6",
  },
  {
    slug: "unified-memory",
    icon: Package,
    name: "Unified memory",
    tagline: "Agents that remember",
    description:
      "Vector-indexed memory across projects, agents, and missions so work compounds instead of resetting.",
    color: "text-teal-400",
    bgColor: "bg-teal-500/10",
    borderColor: "border-teal-500/20",
    colSpan: "lg:col-span-6",
  },
];

function ShowcaseCard({
  item,
  delay,
  children,
}: {
  item: ProductItem;
  delay: number;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.article
      initial={reduceMotion ? undefined : { opacity: 0, y: 20 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.5, delay, ease: ADE_EASE_OUT }}
      whileHover={reduceMotion ? undefined : { y: -2 }}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/50 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition-shadow duration-300",
        "hover:border-accent/25 hover:shadow-[0_0_40px_rgba(124,58,237,0.1)]",
        item.colSpan,
      )}
    >
      {children}
    </motion.article>
  );
}

function ProviderMarquee() {
  const reduceMotion = useReducedMotion();
  return (
    <div className="relative mt-4 overflow-hidden rounded-xl border border-border/50 bg-black/30">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-card to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-card to-transparent" />
      {reduceMotion ? (
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 px-3 py-2.5 text-xs font-medium text-fg/80">
          {PROVIDERS.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      ) : (
        <div className="flex w-max animate-marquee py-2.5">
          <div className="flex shrink-0 gap-10 px-5 text-xs font-medium text-fg/80">
            {PROVIDERS.map((p) => (
              <span key={p}>{p}</span>
            ))}
          </div>
          <div className="flex shrink-0 gap-10 px-5 text-xs font-medium text-fg/80" aria-hidden>
            {PROVIDERS.map((p) => (
              <span key={`d-${p}`}>{p}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ProductShowcase() {
  const reduceMotion = useReducedMotion();

  return (
    <section
      id="features"
      className="relative scroll-mt-20 overflow-hidden border-y border-border/50 bg-[#08080c] py-16 sm:py-24"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background: [
            "radial-gradient(ellipse 70% 45% at 20% 0%, rgba(124,58,237,0.12) 0%, transparent 55%)",
            "radial-gradient(ellipse 50% 40% at 100% 30%, rgba(59,130,246,0.08) 0%, transparent 50%)",
            "radial-gradient(ellipse 40% 35% at 50% 100%, rgba(236,72,153,0.06) 0%, transparent 45%)",
          ].join(", "),
        }}
      />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.35))]" />

      <Container className="relative">
        <motion.div
          initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.55, ease: ADE_EASE_OUT }}
          className="mx-auto max-w-3xl text-center"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent/80">Product</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            The whole loop in{" "}
            <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
              one native window
            </span>
          </h2>
          <p className="mt-3 text-base text-muted-fg sm:text-lg">
            Chat, lanes, terminals, PRs, graph, files, CTO agent, missions, automations, and memory —
            all in one shell. Hover a preview to see which PNG to add, or drop files into{" "}
            <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-sm text-fg/90">
              apps/web/public/images/screenshots/
            </code>
            .
          </p>
        </motion.div>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
          {ITEMS.map((item, idx) => (
            <ShowcaseCard key={item.slug} item={item} delay={idx * 0.04}>
              <div className="flex flex-1 flex-col p-5 sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border",
                      item.bgColor,
                      item.borderColor,
                    )}
                  >
                    <item.icon className={cn("h-5 w-5", item.color)} strokeWidth={2} />
                  </div>
                  {item.variant === "chat" ? (
                    <span className="rounded-full border border-border/60 bg-white/[0.03] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-fg">
                      Native
                    </span>
                  ) : null}
                </div>
                <h3 className="mt-4 text-lg font-semibold text-fg">{item.name}</h3>
                <p className="mt-0.5 text-sm text-muted-fg">{item.tagline}</p>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-fg">{item.description}</p>

                <div className="mt-4">
                  <ScreenshotSlot slug={item.slug} colorClass={item.color} />
                </div>
                {item.variant === "chat" ? <ProviderMarquee /> : null}
              </div>
            </ShowcaseCard>
          ))}
        </div>

        <motion.div
          initial={reduceMotion ? undefined : { opacity: 0, y: 14 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.35 }}
          transition={{ duration: 0.5, delay: 0.1, ease: ADE_EASE_OUT }}
          className="mt-6 flex flex-col items-center gap-4 rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/10 via-card/60 to-transparent px-6 py-8 text-center sm:flex-row sm:text-left"
        >
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-accent/30 bg-accent/15 text-accent">
            <KeyRound className="h-7 w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-fg">Your keys. Your seats.</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-fg">
              Wire ADE to API keys and subscriptions you already use — we unify the workspace, not your
              provider billing.
            </p>
          </div>
        </motion.div>
      </Container>
    </section>
  );
}
