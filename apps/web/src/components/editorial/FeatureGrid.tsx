import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { LINKS } from "../../lib/links";

type Feature = {
  label: string;
  blurb: string;
  src: string;
  docs: string;
};

const FEATURES: Feature[] = [
  {
    label: "Files",
    blurb: "Every file in your project, in context with the lane you're working on.",
    src: "/images/features/files.png",
    docs: "/tools/files",
  },
  {
    label: "Git history",
    blurb: "A timeline of every commit, right beside the code it touched.",
    src: "/images/features/git-history.png",
    docs: "/tools/git",
  },
  {
    label: "Terminals",
    blurb: "Built-in shells, one per lane. Keep a REPL alongside the code.",
    src: "/images/features/terminals.png",
    docs: "/tools/terminals",
  },
  {
    label: "Workspace graph",
    blurb: "See the shape of your repo — files, imports, and open lanes.",
    src: "/images/features/workspacegraph.png",
    docs: "/tools/workspace",
  },
  {
    label: "Model config",
    blurb: "Providers, keys, and per-task model routing in a single pane.",
    src: "/images/features/modelconfig.png",
    docs: "/configuration/models",
  },
  {
    label: "Multi-tasking",
    blurb: "Switch between lanes and tasks without losing an ounce of state.",
    src: "/images/features/multi-tasking.png",
    docs: "/lanes/overview",
  },
  {
    label: "Linear sync",
    blurb: "Pull issues from Linear into the CTO. Post results back automatically.",
    src: "/images/features/linear-sync.png",
    docs: "/cto/linear-sync",
  },
];

/**
 * "Catalog" — a grid of remaining IDE functions with thumbnail screenshots.
 * Cream background, same editorial paper feel. Each card opens a doc page.
 */
export function FeatureGrid() {
  const reduceMotion = useReducedMotion() ?? true;

  return (
    <section
      id="catalog"
      className="relative bg-[color:var(--color-paper)] text-[color:var(--color-ink)]"
    >
      <div className="mx-auto max-w-[1240px] px-[clamp(20px,3vw,40px)] py-[clamp(44px,5.5vw,84px)]">
        {/* running head */}
        <div className="mb-10 flex items-baseline justify-between border-b border-[color:var(--color-ink-hairline)] pb-4 text-[11px] uppercase tracking-[0.24em] text-[color:var(--color-ink-muted)]">
          <span>ADE &middot; April &rsquo;26</span>
          <span className="hidden sm:block">Catalog</span>
          <span>Vol. 1 &middot; v1.1.0 &middot; 32</span>
        </div>

        {/* folio */}
        <div className="mb-10 grid grid-cols-3 items-baseline gap-4 text-[11px] uppercase tracking-[0.26em]">
          <span className="font-medium text-[color:var(--color-accent)]">Catalog</span>
          <span className="text-center text-[color:var(--color-ink-muted)]">
            The rest of the IDE
          </span>
          <span className="text-right text-[color:var(--color-ink-muted)]">Page 32</span>
        </div>

        <motion.h2
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="mb-4 font-serif font-normal tracking-[-0.02em] text-[color:var(--color-ink)]"
          style={{
            fontSize: "clamp(40px, 4.8vw, 68px)",
            lineHeight: 1.05,
            margin: 0,
            maxWidth: "18ch",
            paddingBottom: "0.08em",
          }}
        >
          The rest of the IDE.{" "}
          <em className="italic text-[color:var(--color-accent)]">
            In the same app.
          </em>
        </motion.h2>
        <motion.p
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="mb-10 max-w-[46ch] font-serif italic text-[color:var(--color-ink-muted)]"
          style={{ fontSize: "19px", lineHeight: 1.4 }}
        >
          Every tab you&rsquo;d expect &mdash; and a few you wouldn&rsquo;t.
          Ship-ready on day one.
        </motion.p>

        <div className="grid grid-cols-1 gap-x-8 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <motion.a
              key={feature.label}
              href={`${LINKS.docs}${feature.docs}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`${feature.label} documentation opens in a new tab`}
              initial={reduceMotion ? false : { opacity: 0, y: 14 }}
              whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              transition={{
                duration: 0.6,
                delay: Math.min(i * 0.05, 0.35),
                ease: [0.22, 1, 0.36, 1],
              }}
              className="group block no-underline"
            >
              <div className="relative aspect-[4/3] overflow-hidden border border-[color:var(--color-ink-hairline)] bg-[#0a0a0f] shadow-[0_20px_40px_-24px_rgba(24,21,15,0.45)] transition-transform duration-300 group-hover:-translate-y-[3px]">
                <img
                  src={feature.src}
                  alt={feature.label}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.04]"
                />
              </div>

              <div className="mt-5 flex items-baseline justify-between gap-4">
                <h3
                  className="font-serif font-normal text-[color:var(--color-ink)]"
                  style={{ fontSize: "26px", lineHeight: 1 }}
                >
                  {feature.label}
                </h3>
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-accent)] opacity-70 transition-opacity group-hover:opacity-100">
                  Docs <ArrowUpRight className="h-3 w-3" />
                </span>
              </div>

              <p
                className="mt-2 max-w-[36ch] font-sans text-[color:var(--color-ink-muted)]"
                style={{ fontSize: "14.5px", lineHeight: 1.5 }}
              >
                {feature.blurb}
              </p>
            </motion.a>
          ))}
        </div>
      </div>
    </section>
  );
}
