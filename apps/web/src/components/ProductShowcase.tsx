import { useState, type ReactNode } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ArrowUpRight, X } from "lucide-react";
import { Container } from "./Container";
import { cn } from "../lib/cn";
import { ADE_EASE_OUT } from "../lib/motion";

const DOCS_BASE = "https://www.ade-app.dev/docs";

type Feature = {
  image: string;
  name: string;
  tagline: string;
  description: string;
  docsPath: string;
};

const FEATURES: Feature[] = [
  {
    image: "agent-chat.png",
    name: "Agent chat",
    tagline: "Native multi-provider chat",
    description:
      "First-class AI chat sessions with tools and context — Claude, GPT, Gemini, local models, and whatever you already subscribe to.",
    docsPath: "/chat/overview",
  },
  {
    image: "cto.png",
    name: "CTO agent",
    tagline: "Persistent technical lead",
    description:
      "A long-lived agent that knows your codebase, remembers prior decisions, and delegates work across your team of agents.",
    docsPath: "/cto/overview",
  },
  {
    image: "lanes.png",
    name: "Lanes",
    tagline: "Parallel git worktrees",
    description:
      "Each agent works in its own isolated worktree — run builds, tests, and installs in parallel without conflicts.",
    docsPath: "/lanes/overview",
  },
  {
    image: "multi-tasking.png",
    name: "Multi-tasking",
    tagline: "Parallel agent sessions",
    description:
      "Run multiple agents side-by-side across lanes, each with their own chat, terminal, and file context.",
    docsPath: "/lanes/overview",
  },
  {
    image: "terminals.png",
    name: "Terminals",
    tagline: "Live PTY output",
    description:
      "Real terminal shells with live streams so you see every command agents run and every line of output.",
    docsPath: "/tools/terminals",
  },
  {
    image: "files.png",
    name: "Files",
    tagline: "Built-in editor",
    description:
      "Jump from chat or review into the file editor without losing context — syntax-highlighted and diff-aware.",
    docsPath: "/tools/files-editor",
  },
  {
    image: "prs.png",
    name: "Pull requests",
    tagline: "Review in one place",
    description:
      "Open, review, and track pull requests from the same desktop shell where your agents work.",
    docsPath: "/tools/pull-requests",
  },
  {
    image: "workspacegraph.png",
    name: "Workspace graph",
    tagline: "Visualize your work",
    description:
      "A visual map of your workspace showing how PRs, lanes, and branches relate to each other.",
    docsPath: "/tools/workspace-graph",
  },
  {
    image: "git history.png",
    name: "Git history",
    tagline: "Timeline in context",
    description:
      "Inspect commits and history beside the lane and file you are working in — without leaving ADE.",
    docsPath: "/tools/history",
  },
  {
    image: "modelconfig.png",
    name: "Model configuration",
    tagline: "Your keys and models",
    description:
      "Wire providers, models, and API keys in one settings surface — BYOK with subscriptions you already pay for.",
    docsPath: "/configuration/ai-providers",
  },
  {
    image: "linear-sync.png",
    name: "Linear sync",
    tagline: "Issues to agents",
    description:
      "Connect Linear projects so the CTO agent can pick up issues, plan work, and drive them to completion.",
    docsPath: "/cto/linear",
  },
  {
    image: "run.png",
    name: "Process runner",
    tagline: "Monitor every command",
    description:
      "Track every terminal process agents spawn — view output, status, and timing in one unified timeline.",
    docsPath: "/tools/project-home",
  },
];

function featureSrc(image: string) {
  return `/images/features/${encodeURIComponent(image)}`;
}

/** Lightbox overlay for full-screen image view */
function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: ADE_EASE_OUT }}
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute top-5 right-5 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20"
        onClick={onClose}
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
      <motion.img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[92vw] rounded-xl border border-border/30 object-contain shadow-2xl"
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        transition={{ duration: 0.3, ease: ADE_EASE_OUT }}
        onClick={(e) => e.stopPropagation()}
      />
    </motion.div>
  );
}

function FeatureCard({
  feature,
  delay,
  onImageClick,
}: {
  feature: Feature;
  delay: number;
  onImageClick: () => void;
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
        "hover:border-accent/25 hover:shadow-[0_0_40px_rgba(124,58,237,0.1)]"
      )}
    >
      {/* Image — zoomed in by default, zooms out on hover */}
      <button
        type="button"
        className="relative aspect-[16/10] w-full overflow-hidden bg-[#0a0f1a] cursor-zoom-in"
        onClick={onImageClick}
        aria-label={`View ${feature.name} full screen`}
      >
        <img
          src={featureSrc(feature.image)}
          alt={feature.name}
          className="absolute inset-0 h-full w-full object-cover object-top transition-transform duration-500 ease-out scale-[1.15] group-hover:scale-100"
          loading="lazy"
          decoding="async"
        />
      </button>

      {/* Text content */}
      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <h3 className="text-lg font-semibold text-fg">{feature.name}</h3>
        <p className="mt-0.5 text-sm font-medium text-accent/90">
          {feature.tagline}
        </p>
        <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-fg">
          {feature.description}
        </p>
        <a
          href={`${DOCS_BASE}${feature.docsPath}`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent/80 transition-colors hover:text-accent"
        >
          View in docs <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      </div>
    </motion.article>
  );
}

export function ProductShowcase() {
  const reduceMotion = useReducedMotion();
  const [lightbox, setLightbox] = useState<{
    src: string;
    alt: string;
  } | null>(null);

  return (
    <>
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
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent/80">
              Product
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-fg sm:text-4xl">
              The whole loop in{" "}
              <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
                one native window
              </span>
            </h2>
            <p className="mt-3 text-base text-muted-fg sm:text-lg">
              Chat, lanes, terminals, files, the workspace graph, pull requests,
              git history, and model setup — all captured from the real app.
              Click any screenshot to view full size.
            </p>
          </motion.div>

          <div className="mt-12 grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
            {FEATURES.map((feature, idx) => (
              <FeatureCard
                key={feature.image}
                feature={feature}
                delay={idx * 0.04}
                onImageClick={() =>
                  setLightbox({
                    src: featureSrc(feature.image),
                    alt: feature.name,
                  })
                }
              />
            ))}
          </div>
        </Container>
      </section>

      {/* Lightbox */}
      <AnimatePresence>
        {lightbox && (
          <Lightbox
            src={lightbox.src}
            alt={lightbox.alt}
            onClose={() => setLightbox(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
