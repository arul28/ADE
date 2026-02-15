import { motion, useScroll, useTransform } from "framer-motion";
import { ArrowRight, Box, Check, ChevronRight, GitBranch, Layout, Play, Shield, Terminal, Zap } from "lucide-react";
import { useRef } from "react";
import { LinkButton } from "../../components/LinkButton";
import { Page } from "../../components/Page";
import { AppScreenshot } from "../../components/ui/AppScreenshot";
import { CanvasDemo } from "../../components/ui/CanvasDemo";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { ArchitectureDiagram } from "../../components/illustrations/ArchitectureDiagram";
import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { FeatureGallery, type FeatureGalleryItem } from "../../components/FeatureGallery";
import { Section } from "../../components/Section";
import { SectionHeading } from "../../components/SectionHeading";

const HIGHLIGHTS: FeatureGalleryItem[] = [
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
      "A fast file explorer and editor for lane workspaces, with diffs and conflict-aware modes.",
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
      "Spin up worktree-backed lanes, stack them, restack them, and keep each execution surface visible.",
    bullets: [
      "Lane types: Primary, Worktree, Attached",
      "Stacks for layered branch workflows",
      "High-density status: dirty/clean, ahead/behind, risk"
    ],
    imageSrc: "/images/features/lanes.svg"
  },
];

export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");
  const scrollRef = useRef(null);
  const { scrollYProgress } = useScroll();
  const scaleX = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return (
    <Page className="overflow-x-hidden bg-background text-fg">
      {/* Scroll Progress */}
      <motion.div
        className="fixed top-0 left-0 right-0 h-1 bg-accent origin-left z-50"
        style={{ scaleX }}
      />

      {/* Background Ambience (Subtle) */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-background to-background" />
        <div className="absolute top-0 inset-x-0 h-px bg-white/5" />
      </div>

      <div className="relative z-10 flex flex-col gap-24 pb-32">
        {/* --- HERO SECTION --- */}
        <section className="relative px-6 pt-28 lg:pt-36 flex flex-col items-center text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="max-w-4xl mx-auto"
          >
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/5 backdrop-blur-md text-xs font-medium text-muted-fg mb-8">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
              </span>
              v1.0 Public Beta
            </div>

            <h1 className="text-5xl sm:text-7xl font-bold tracking-tight text-white leading-[1.1] mb-8">
              Mission control for <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-br from-white via-white to-white/50">
                agentic development
              </span>.
            </h1>

            <p className="text-xl text-muted-fg leading-relaxed max-w-2xl mx-auto mb-10">
              ADE orchestrates your AI agents, tracks context across branches, and resolves conflicts before they happen.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-20">
              <LinkButton to="/download" size="lg" className="rounded-full px-8 h-12 text-base shadow-[0_0_20px_rgba(59,130,246,0.3)] bg-accent hover:bg-accent/90 text-white border-0">
                Download for macOS <ArrowRight className="ml-2 h-4 w-4" />
              </LinkButton>
              <LinkButton
                to={LINKS.prd}
                variant="secondary"
                size="lg"
                className="rounded-full px-8 h-12 text-base border-white/10 bg-white/5 hover:bg-white/10 text-white"
                target="_blank"
                rel="noreferrer"
              >
                Read the docs
              </LinkButton>
            </div>
          </motion.div>

          {/* App Visual */}
          <motion.div
            initial={{ opacity: 0, y: 50, rotateX: 10 }}
            animate={{ opacity: 1, y: 0, rotateX: 0 }}
            transition={{ duration: 1, delay: 0.3, ease: "easeOut" }}
            className="w-full max-w-6xl mx-auto perspective-[1200px]"
          >
            <AppScreenshot />
          </motion.div>
        </section>

        {/* --- PROBLEM / SOLUTION --- */}
        <section className="container mx-auto px-6 pt-20">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-3xl font-semibold mb-4 text-white">Stop wrestling with context.</h2>
            <p className="text-muted-fg text-lg">Running multiple agents in parallel used to mean chaos. ADE brings order to the storm.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              { icon: <GitBranch className="w-6 h-6 text-red-400" />, title: "Context Fragmentation", desc: "Forgetting what Agent A did while Agent B breaks the build." },
              { icon: <Zap className="w-6 h-6 text-yellow-400" />, title: "Merge Conflicts", desc: "Discovering overlapping changes only when it's too late." },
              { icon: <Terminal className="w-6 h-6 text-blue-400" />, title: "Lost Sessions", desc: "No record of intent or execution history across terminals." }
            ].map((item, i) => (
              <motion.div
                key={i}
                whileHover={{ y: -5 }}
                className="p-8 rounded-2xl bg-card border border-white/10 hover:border-white/20 hover:bg-white/[0.08] transition-all group"
              >
                <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mb-6 border border-white/5 group-hover:border-white/10 group-hover:bg-white/10 transition-colors">
                  {item.icon}
                </div>
                <h3 className="text-xl font-medium text-white mb-3">{item.title}</h3>
                <p className="text-muted-fg text-base leading-relaxed">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* --- INTERACTIVE DEMO --- */}
        <section className="container mx-auto px-6 py-24 border-t border-white/5 mt-20">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div className="order-2 lg:order-1 perspective-[1200px]">
              <CanvasDemo />
            </div>
            <div className="order-1 lg:order-2">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-accent/20 bg-accent/10 text-xs font-medium text-accent mb-6">
                <Zap className="w-3 h-3" />
                Interactive Demo
              </div>
              <h2 className="text-4xl sm:text-5xl font-bold mb-6 text-white tracking-tight">Merge without the CLI.</h2>
              <p className="text-muted-fg text-xl mb-8 leading-relaxed">
                ADE visualizes your workspace as a graph. Want to merge a feature branch?
                Just drag it onto main. We'll run the dry-run, check for conflicts, and handle the git ops.
              </p>
              <ul className="space-y-5">
                {[
                  "Visual branching topology",
                  "Drag-and-drop merges & rebases",
                  "Instant conflict detection",
                  "Undo with one click"
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-4 text-white/90 text-lg">
                    <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center">
                      <Check className="w-3.5 h-3.5 text-accent" />
                    </div>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* --- FEATURES GRID --- */}
        <section className="container mx-auto px-6 py-20">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-semibold text-white tracking-tight">Everything in one place.</h2>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <Card className="col-span-1 lg:col-span-2 p-8 bg-card border-white/10 hover:border-accent/40 transition-colors overflow-hidden relative group">
              <div className="relative z-10 max-w-md">
                <Layout className="w-8 h-8 text-accent mb-4" />
                <h3 className="text-2xl font-bold text-white mb-2">Lanes</h3>
                <p className="text-muted-fg text-lg">Parallel work, perfected. Spin up isolated worktrees for every agent task.</p>
              </div>
              <div className="absolute right-0 top-10 w-96 h-full opacity-30 group-hover:opacity-60 transition-opacity">
                {/* Abstract visual */}
                <div className="w-full h-full bg-gradient-to-l from-accent/20 to-transparent transform skew-x-12" />
              </div>
            </Card>

            <Card className="p-8 bg-card border-white/10 hover:border-purple-500/40 transition-colors group">
              <Box className="w-8 h-8 text-purple-400 mb-4" />
              <h3 className="text-xl font-bold text-white mb-2">Packs</h3>
              <p className="text-muted-fg text-base">Durable context. Checkpoints and history that survives session restarts.</p>
            </Card>

            <Card className="p-8 bg-card border-white/10 hover:border-green-500/40 transition-colors group">
              <Shield className="w-8 h-8 text-green-400 mb-4" />
              <h3 className="text-xl font-bold text-white mb-2">Safety</h3>
              <p className="text-muted-fg text-base">Local-first. Read-only cloud. Your code stays yours.</p>
            </Card>

            <Card className="col-span-1 lg:col-span-2 p-8 bg-card border-white/10 hover:border-orange-500/40 transition-colors">
              <div className="flex flex-col md:flex-row gap-8 items-center">
                <div className="flex-1">
                  <Terminal className="w-8 h-8 text-orange-400 mb-4" />
                  <h3 className="text-2xl font-bold text-white mb-2">Terminals</h3>
                  <p className="text-muted-fg text-lg">Rich, tracked sessions with full transcript history.</p>
                </div>
                {/* Mini terminal vis */}
                <div className="w-full md:w-64 h-32 bg-black/50 rounded-lg border border-white/10 p-3 font-mono text-xs text-muted-fg">
                  <div className="text-white">$ git status</div>
                  <div className="text-green-400">On branch main</div>
                  <div>nothing to commit, working tree clean</div>
                </div>
              </div>
            </Card>
          </div>
        </section>

        {/* --- DOWNLOAD CTA --- */}
        <section className="container mx-auto px-6 py-24 mb-10">
          <div className="relative rounded-[32px] overflow-hidden bg-card border border-white/10 p-16 text-center shadow-2xl">
            <div className="absolute inset-0 bg-gradient-to-br from-accent/10 via-purple-500/5 to-transparent blur-3xl" />

            <div className="relative z-10 max-w-3xl mx-auto">
              <h2 className="text-4xl sm:text-5xl font-bold mb-8 text-white">Ready to regain control?</h2>
              <p className="text-muted-fg text-xl mb-10">Join the developers who have stopped fighting their tools and started orchestrating them.</p>

              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <LinkButton to="/download" size="lg" className="w-full sm:w-auto rounded-full text-base h-14 px-10 bg-white text-black hover:bg-white/90 border-0 shadow-lg font-semibold">
                  Download for free
                </LinkButton>
                <LinkButton to={LINKS.github} variant="secondary" size="lg" className="w-full sm:w-auto rounded-full text-base h-14 px-10 border-white/10 bg-white/5 hover:bg-white/10 text-white">
                  View on GitHub
                </LinkButton>
              </div>
              <p className="mt-8 text-sm text-muted-fg/60">Local-first. Privacy respected.</p>
            </div>
          </div>
        </section>

        {/* --- FOOTER --- */}
        <footer className="border-t border-white/5 py-12 bg-[#050505]">
          <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-2 text-sm text-muted-fg">
              <span className="font-semibold text-white">ADE</span> © 2026
            </div>
            <div className="flex items-center gap-8 text-sm text-muted-fg">
              <a href={LINKS.prd} className="hover:text-white transition-colors">Documentation</a>
              <a href={LINKS.github} className="hover:text-white transition-colors">GitHub</a>
              <a href="/privacy" className="hover:text-white transition-colors">Privacy</a>
              <a href="/terms" className="hover:text-white transition-colors">Terms</a>
            </div>
          </div>
        </footer>
      </div>
    </Page>
  );
}
