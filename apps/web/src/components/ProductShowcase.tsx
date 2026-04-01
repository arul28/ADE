import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { KeyRound } from "lucide-react";
import { Container } from "./Container";
import { cn } from "../lib/cn";
import { ADE_EASE_OUT } from "../lib/motion";

/**
 * Product screenshots: `apps/web/public/images/features/`
 * Filenames match the assets under `/Users/arul/ADE/apps/web/public/images/features/`.
 */
type FeatureAsset = {
  /** Basename under `/images/features/` (may include spaces). */
  image: string;
  name: string;
  tagline: string;
  description: string;
};

const FEATURES: FeatureAsset[] = [
  {
    image: "agent-chat.png",
    name: "Agent chat",
    tagline: "Native · multi-provider",
    description:
      "First-class sessions with tools and context — Claude, Codex, Gemini, local models, and what you already subscribe to.",
  },
  {
    image: "lanes.png",
    name: "Lanes",
    tagline: "Parallel git worktrees",
    description:
      "Each agent in its own worktree — run builds, tests, and installs at the same time without stepping on the same tree.",
  },
  {
    image: "terminals.png",
    name: "Terminals",
    tagline: "Live PTY output",
    description: "Shells with live streams so you see every command agents run and every line of output.",
  },
  {
    image: "files.png",
    name: "Files",
    tagline: "Edit in place",
    description: "Jump from chat or review into the file surface without losing context.",
  },
  {
    image: "workspacegraph.png",
    name: "Workspace graph",
    tagline: "See how work connects",
    description: "A visual map of your workspace — including how PRs and lanes relate to the repo.",
  },
  {
    image: "prs.png",
    name: "PRs",
    tagline: "Review in one place",
    description: "Open, review, and track pull requests from the same desktop shell as your agents.",
  },
  {
    image: "git history.png",
    name: "Git history",
    tagline: "Timeline in context",
    description: "Inspect commits and history beside the lane and file you are working in — without leaving ADE.",
  },
  {
    image: "modelconfig.png",
    name: "Model configuration",
    tagline: "Your keys and models",
    description: "Wire providers, models, and API keys in one settings surface — BYOK and subscriptions you already use.",
  },
];

function featureSrc(image: string) {
  return `/images/features/${encodeURIComponent(image)}`;
}

function FeatureImage({ image, title }: { image: string; title: string }) {
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-xl border border-border/50 bg-[#0a0f1a]">
      <img
        src={featureSrc(image)}
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-top"
        loading="lazy"
        decoding="async"
      />
      <span className="sr-only">{title}</span>
    </div>
  );
}

function ShowcaseCard({
  item,
  delay,
  children,
}: {
  item: FeatureAsset;
  delay: number;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.article
      initial={reduceMotion ? undefined : { opacity: 0, y: 20 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.5, delay, ease: ADE_EASE_OUT }}
      whileHover={reduceMotion ? undefined : { y: -2 }}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/50 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition-shadow duration-300",
        "hover:border-accent/25 hover:shadow-[0_0_40px_rgba(124,58,237,0.1)]",
      )}
    >
      {children}
    </motion.article>
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
            Chat, lanes, terminals, files, the workspace graph, pull requests, git history, and model setup — all
            captured from the real app. More capabilities are listed below under &ldquo;Also built in.&rdquo;
          </p>
        </motion.div>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-4">
          {FEATURES.map((item, idx) => (
            <ShowcaseCard key={item.image} item={item} delay={idx * 0.04}>
              <div className="flex flex-1 flex-col p-5 sm:p-6">
                <FeatureImage image={item.image} title={item.name} />
                <h3 className="mt-4 text-lg font-semibold text-fg">{item.name}</h3>
                <p className="mt-0.5 text-sm font-medium text-accent/90">{item.tagline}</p>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-fg">{item.description}</p>
              </div>
            </ShowcaseCard>
          ))}
        </div>

        <motion.div
          initial={reduceMotion ? undefined : { opacity: 0, y: 14 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.35 }}
          transition={{ duration: 0.5, delay: 0.1, ease: ADE_EASE_OUT }}
          className="mt-10 flex flex-col items-center gap-4 rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/10 via-card/60 to-transparent px-6 py-8 text-center sm:flex-row sm:text-left"
        >
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-accent/30 bg-accent/15 text-accent">
            <KeyRound className="h-7 w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-fg">Your keys. Your seats.</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-fg">
              Wire ADE to API keys and subscriptions you already use — we unify the workspace, not your provider
              billing.
            </p>
          </div>
        </motion.div>
      </Container>
    </section>
  );
}
