import { motion, useReducedMotion } from "framer-motion";
import { LINKS } from "../../lib/links";

type Entry = { name: string; page: string; href: string };

const ENTRIES: Entry[] = [
  { name: "Agents & Chat", page: "08", href: "/chat/overview" },
  { name: "Automations", page: "28", href: "/automations/overview" },
  { name: "Byok (Bring your own keys)", page: "22", href: "/configuration/settings" },
  { name: "Computer Use", page: "30", href: "/computer-use/overview" },
  { name: "Context packs", page: "26", href: "/context-packs/overview" },
  { name: "CTO (chief technical officer)", page: "15", href: "/cto/overview" },
  { name: "CLI · ade", page: "12", href: "/tools/project-home" },
  { name: "Dispatch", page: "17", href: "/missions/creating" },
  { name: "File viewer", page: "05", href: "/tools/files-editor" },
  { name: "Git history", page: "07", href: "/tools/history" },
  { name: "iOS app", page: "28", href: "/getting-started/install" },
  { name: "Lanes", page: "04", href: "/lanes/overview" },
  { name: "Linear sync", page: "18", href: "/cto/linear" },
  { name: "Local models", page: "23", href: "/configuration/ai-providers" },
  { name: "Memory (unified)", page: "16", href: "/cto/memory" },
  { name: "Merge conflicts", page: "26", href: "/tools/conflicts" },
  { name: "Missions", page: "14", href: "/missions/overview" },
  { name: "Mobile sync", page: "28", href: "/tools/project-home" },
  { name: "Model configuration", page: "22", href: "/configuration/ai-providers" },
  { name: "Multi-provider chat", page: "08", href: "/chat/capabilities" },
  { name: "Orchestrator", page: "14", href: "/missions/overview" },
  { name: "PR review", page: "20", href: "/tools/pull-requests" },
  { name: "Planning phase", page: "14", href: "/missions/creating" },
  { name: "Play runtime", page: "25", href: "/automations/executors" },
  { name: "Providers", page: "22", href: "/configuration/ai-providers" },
  { name: "Proof drawer", page: "21", href: "/computer-use/proofs" },
  { name: "Screenshots (computer use)", page: "30", href: "/computer-use/overview" },
  { name: "Settings", page: "22", href: "/configuration/settings" },
  { name: "Sub-agents", page: "17", href: "/missions/workers" },
  { name: "Team (CTO org)", page: "15", href: "/cto/workers" },
  { name: "Terminals", page: "10", href: "/tools/terminals" },
  { name: "Testing phase", page: "14", href: "/missions/overview" },
  { name: "Worktrees (lanes)", page: "04", href: "/lanes/overview" },
  { name: "Workspace graph", page: "06", href: "/tools/workspace-graph" },
];

/**
 * Book-style feature index — two columns on desktop, dot leaders, page numbers.
 * Every entry anchors to the relevant doc section.
 */
export function IndexPage() {
  const reduceMotion = useReducedMotion() ?? true;

  const sorted = [...ENTRIES].sort((a, b) => a.name.localeCompare(b.name));
  const mid = Math.ceil(sorted.length / 2);
  const left = sorted.slice(0, mid);
  const right = sorted.slice(mid);

  return (
    <section
      id="index"
      className="relative bg-[color:var(--color-paper)] text-[color:var(--color-ink)]"
    >
      <div className="mx-auto max-w-[1240px] px-[clamp(20px,3vw,40px)] py-[clamp(44px,5.5vw,84px)]">
        <div className="mb-10 flex items-baseline justify-between border-b border-[color:var(--color-ink-hairline)] pb-4 text-[11px] uppercase tracking-[0.24em] text-[color:var(--color-ink-muted)]">
          <span>ADE &middot; April &rsquo;26</span>
          <span className="hidden sm:block">Back matter</span>
          <span>Vol. 1 &middot; v1.1.0 &middot; 34</span>
        </div>

        <motion.h2
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="mb-3 font-serif font-normal tracking-[-0.02em] text-[color:var(--color-ink)]"
          style={{
            fontSize: "clamp(40px, 4.6vw, 64px)",
            lineHeight: 1.05,
            margin: 0,
            paddingBottom: "0.08em",
          }}
        >
          Index.
        </motion.h2>
        <motion.p
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, delay: 0.08 }}
          className="mb-10 max-w-[40ch] font-serif italic text-[color:var(--color-ink-muted)]"
          style={{ fontSize: "19px", lineHeight: 1.4 }}
        >
          Everything that ships in the same app. No plugins, no extensions,
          no tabs.
        </motion.p>

        <div className="grid grid-cols-1 gap-x-14 gap-y-2 md:grid-cols-2">
          <IndexColumn entries={left} />
          <IndexColumn entries={right} />
        </div>
      </div>
    </section>
  );
}

function IndexColumn({ entries }: { entries: Entry[] }) {
  const reduceMotion = useReducedMotion() ?? true;
  return (
    <ul className="list-none p-0">
      {entries.map((entry, i) => (
        <motion.li
          key={entry.name}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: 0.35, delay: Math.min(i * 0.02, 0.4) }}
          className="my-0 border-b border-dotted border-[color:var(--color-ink-hairline)] py-[10px]"
        >
          <a
            href={`${LINKS.docs}${entry.href}`}
            target="_blank"
            rel="noreferrer"
            className="group flex items-baseline gap-3 text-[color:var(--color-ink)] no-underline transition-colors hover:text-[color:var(--color-accent)]"
          >
            <span
              className="font-sans"
              style={{ fontSize: "14.5px", letterSpacing: "-0.005em" }}
            >
              {entry.name}
            </span>
            <span
              className="flex-1 border-b border-dotted border-[color:var(--color-ink-hairline)]"
              aria-hidden
            />
            <span
              className="font-serif text-[color:var(--color-ink-muted)] group-hover:text-[color:var(--color-accent)]"
              style={{ fontSize: "15px" }}
            >
              {entry.page}
            </span>
          </a>
        </motion.li>
      ))}
    </ul>
  );
}
