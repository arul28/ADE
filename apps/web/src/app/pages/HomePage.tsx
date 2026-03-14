import { motion, useScroll, useTransform } from "framer-motion";
import { ArrowRight, BookOpen, Download, Github, Shield, Terminal, GitMerge, LayoutGrid, Zap } from "lucide-react";
import { useRef } from "react";
import { LinkButton } from "../../components/LinkButton";
import { Page } from "../../components/Page";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");
  const scrollRef = useRef(null);
  const { scrollYProgress } = useScroll();
  const scaleX = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return (
    <Page className="overflow-x-hidden bg-bg text-fg font-sans min-h-screen">
      
      {/* --- SCROLL PROGRESS --- */}
      <motion.div
        className="fixed top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent to-accent-2 origin-left z-[100]"
        style={{ scaleX }}
      />

      {/* --- FLOATING HEADER --- */}
      <header className="fixed top-0 left-0 right-0 z-50 px-6 py-4 flex justify-between items-center bg-black/40 backdrop-blur-2xl border-b border-white/5">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="ADE Logo" className="w-8 h-8 text-accent mix-blend-screen" />
          <span className="font-bold text-xl tracking-tight text-white">ADE</span>
          <span className="ml-2 px-2 py-0.5 rounded-full bg-accent/10 border border-accent/20 text-accent text-[10px] font-mono font-semibold tracking-widest uppercase">
            v1.0 Beta
          </span>
        </div>
        <div className="flex items-center gap-6">
          <a href={LINKS.github} target="_blank" rel="noreferrer" className="text-sm font-medium text-muted-fg hover:text-white transition-colors flex items-center gap-2">
            <Github className="w-4 h-4" /> GitHub
          </a>
          <a href={LINKS.docs} target="_blank" rel="noreferrer" className="text-sm font-medium text-muted-fg hover:text-white transition-colors flex items-center gap-2">
            <BookOpen className="w-4 h-4" /> Docs
          </a>
          <LinkButton to="/download" className="h-10 px-5 rounded-full text-sm font-semibold bg-white text-black hover:bg-white/90 shadow-[0_0_20px_rgba(255,255,255,0.15)] transition-all hover:scale-105">
            Download free 
          </LinkButton>
        </div>
      </header>

      {/* --- MAIN CANVAS --- */}
      <div className="relative pt-32 pb-32">
        
        {/* Massive Animated Background Gradients */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
           <motion.div 
             animate={{ 
               scale: [1, 1.1, 1],
               opacity: [0.3, 0.4, 0.3],
               x: [0, 100, 0],
             }}
             transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
             className="absolute -top-[20%] -right-[10%] w-[800px] h-[800px] rounded-full bg-accent/20 blur-[120px]" 
           />
           <motion.div 
             animate={{ 
               scale: [1, 1.2, 1],
               opacity: [0.2, 0.3, 0.2],
               x: [0, -100, 0],
             }}
             transition={{ duration: 20, repeat: Infinity, ease: "linear", delay: 2 }}
             className="absolute top-[20%] -left-[10%] w-[600px] h-[600px] rounded-full bg-indigo-500/10 blur-[150px]" 
           />
        </div>

        {/* --- HERO SECTION --- */}
        <div className="relative z-10 container mx-auto px-6 text-center max-w-5xl mb-32">
            <motion.div 
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            >
              <h1 className="text-6xl sm:text-7xl md:text-[90px] font-bold tracking-tight text-white leading-[1.05] mb-8">
                Orchestrate your <br/>
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-accent/90 to-accent-2">AI agents.</span>
              </h1>
              
              <p className="text-xl sm:text-2xl md:text-3xl text-muted-fg font-light max-w-3xl mx-auto leading-relaxed mb-12">
                ADE is a local-first desktop environment built to tame parallel coding agents. Isolate tasks into lanes, track every terminal command, and resolve conflicts before they break main.
              </p>

              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                 <LinkButton 
                  to="/download" 
                  size="lg" 
                  className="w-full sm:w-auto rounded-full px-10 h-16 text-lg bg-accent text-accent-fg hover:bg-accent/90 shadow-[0_0_40px_rgba(167,139,250,0.3)] font-semibold transition-all hover:scale-105"
                >
                  <Download className="mr-3 h-6 w-6" /> Download for macOS
                </LinkButton>
                 <LinkButton
                  to={LINKS.docs}
                  variant="secondary"
                  size="lg"
                  className="w-full sm:w-auto rounded-full px-10 h-16 text-lg border-white/10 bg-surface/50 hover:bg-surface text-white backdrop-blur-md transition-all font-medium"
                >
                  <BookOpen className="mr-3 h-5 w-5 opacity-70" /> View Documentation
                </LinkButton>
              </div>
            </motion.div>

            {/* 3D App Mockup Placeholder */}
            <motion.div
              initial={{ opacity: 0, y: 100, rotateX: 10, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, rotateX: 0, scale: 1 }}
              transition={{ duration: 1.2, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="mt-24 w-full perspective-[2000px]"
            >
               <div className="relative rounded-[24px] overflow-hidden ade-floating-pane aspect-[16/10] shadow-[0_40px_100px_-20px_rgba(0,0,0,1)] float-slow border-accent/20">
                 
                 {/* Mock App Header */}
                 <div className="absolute top-0 w-full h-12 bg-black/40 backdrop-blur-md border-b border-white/10 flex items-center px-4 z-20">
                    <div className="flex gap-2">
                       <div className="w-3 h-3 rounded-full bg-red-500/80" />
                       <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                       <div className="w-3 h-3 rounded-full bg-green-500/80" />
                    </div>
                    <div className="mx-auto text-xs font-mono text-muted-fg/70 bg-white/5 px-24 py-1 rounded">ade-desktop-v1.0-alpha</div>
                 </div>

                 {/* Mock Content */}
                 <div className="absolute inset-0 bg-surface/40 flex items-center justify-center z-10">
                     <div className="text-center p-12 bg-black/50 backdrop-blur-xl border border-white/5 rounded-3xl">
                       <LayoutGrid className="w-16 h-16 text-accent/50 mx-auto mb-6" />
                       <p className="text-white text-xl font-medium mb-2">Workspace Overview</p>
                       <p className="text-muted-fg font-mono text-sm max-w-sm mx-auto">Drop an actual high-res 16:10 screenshot of the ADE Desktop App interface here.</p>
                     </div>
                 </div>
               </div>
            </motion.div>
        </div>

        {/* --- ALTERNATING FEATURE SECTIONS --- */}
        <div className="container mx-auto px-6 max-w-6xl space-y-32">
           
           {/* Feature 1: Lanes */}
           <div className="flex flex-col lg:flex-row items-center gap-16">
              <div className="flex-1 space-y-6">
                 <div className="w-16 h-16 rounded-3xl bg-accent/10 flex items-center justify-center border border-accent/20">
                   <GitMerge className="w-8 h-8 text-accent" />
                 </div>
                 <h2 className="text-4xl md:text-5xl font-bold text-white tracking-tight leading-tight">
                   Parallel worktrees. <br/> <span className="text-muted-fg">Zero conflicts.</span>
                 </h2>
                 <p className="text-xl text-muted-fg leading-relaxed">
                   Every task is isolated in its own git-backed lane. Agents can build, install dependencies, and run failing tests simultaneously without ever stepping on your main branch.
                 </p>
                 <ul className="space-y-4 pt-4">
                   {["Isolated git worktrees per agent.", "Conflict resolution before merging.", "Visual tree history mapping."].map((item, i) => (
                     <li key={i} className="flex items-center gap-3 text-white text-lg font-medium">
                       <Zap className="w-5 h-5 text-accent" /> {item}
                     </li>
                   ))}
                 </ul>
              </div>
              <div className="flex-1 w-full relative">
                 <div className="absolute inset-0 bg-accent/20 blur-[100px] rounded-full pointer-events-none" />
                 <div className="relative ade-floating-pane rounded-[24px] aspect-square flex flex-col overflow-hidden shadow-2xl">
                    <div className="ade-floating-pane-header">
                      <span className="ade-pane-title">lane-inspector.tsx</span>
                    </div>
                    <div className="flex-1 p-8 bg-surface/50 flex flex-col gap-4">
                        <div className="p-4 rounded-xl border border-white/10 bg-black/40 flex justify-between items-center">
                           <div>
                              <div className="text-white font-medium">Mission: Add Auth</div>
                              <div className="text-muted-fg text-xs font-mono mt-1">Status: Running Tests...</div>
                           </div>
                           <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                             <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                           </div>
                        </div>
                        <div className="p-4 rounded-xl border border-white/5 bg-black/20 flex justify-between items-center opacity-50">
                           <div>
                              <div className="text-white font-medium">Mission: Refactor API</div>
                              <div className="text-muted-fg text-xs font-mono mt-1">Status: Complete</div>
                           </div>
                           <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                             <div className="w-2 h-2 rounded-full bg-green-500" />
                           </div>
                        </div>
                    </div>
                 </div>
              </div>
           </div>

           {/* Feature 2: Terminal / CTO */}
           <div className="flex flex-col lg:flex-row-reverse items-center gap-16">
              <div className="flex-1 space-y-6">
                 <div className="w-16 h-16 rounded-3xl bg-blue-500/10 flex items-center justify-center border border-blue-500/20">
                   <Terminal className="w-8 h-8 text-blue-400" />
                 </div>
                 <h2 className="text-4xl md:text-5xl font-bold text-white tracking-tight leading-tight">
                   Rich terminal sessions. <br/> <span className="text-muted-fg">Total visibility.</span>
                 </h2>
                 <p className="text-xl text-muted-fg leading-relaxed">
                   Every command, every output, and every intent is recorded. Your CTO agent delegates complex requirements into manageable steps trackable via specific terminal views.
                 </p>
                 <ul className="space-y-4 pt-4">
                   {["Multi-terminal split views.", "Real-time execution cost tracking.", "Interactive process intervention."].map((item, i) => (
                     <li key={i} className="flex items-center gap-3 text-white text-lg font-medium">
                       <Zap className="w-5 h-5 text-blue-400" /> {item}
                     </li>
                   ))}
                 </ul>
              </div>
              <div className="flex-1 w-full relative">
                 <div className="absolute inset-0 bg-blue-500/15 blur-[100px] rounded-full pointer-events-none" />
                 <div className="relative ade-floating-pane border-blue-500/20 rounded-[24px] aspect-square flex flex-col overflow-hidden shadow-2xl">
                    <div className="ade-floating-pane-header border-blue-500/10 bg-blue-500/5">
                      <span className="ade-pane-title">terminal.tsx</span>
                    </div>
                    <div className="flex-1 p-6 bg-[#09080C] font-mono text-[13px] leading-relaxed flex flex-col gap-2">
                        <div className="text-muted-fg opacity-50">Last login: {new Date().toLocaleDateString()} on ttys001</div>
                        <div className="flex gap-2 text-white">
                           <span className="text-blue-400">~/ade-project $</span> ade agent cto prompt "Set up authentication"
                        </div>
                        <div className="text-green-400">✅ CTO Activated. Planning execution...</div>
                        <div className="text-muted-fg">↳ Creating new lane: feat/setup-auth</div>
                        <div className="text-muted-fg">↳ Spawning 2 worker agents...</div>
                        <div className="text-accent mt-4">Worker 1 (Frontend): Generating login components...</div>
                    </div>
                 </div>
              </div>
           </div>

        </div>

        {/* --- BOTTOM CTA --- */}
        <div className="container mx-auto px-6 max-w-5xl mt-40">
           <div className="relative rounded-[40px] p-16 md:p-24 text-center overflow-hidden border border-white/10 shadow-2xl group">
             {/* Dynamic background effect */}
             <div className="absolute inset-0 bg-surface" />
             <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-accent/20 via-transparent to-transparent opacity-80 group-hover:opacity-100 transition-opacity duration-1000" />
             
             <Shield className="w-16 h-16 text-white mx-auto mb-8 relative z-10" />
             <h2 className="text-5xl md:text-6xl font-bold text-white mb-6 tracking-tight relative z-10">
               Build locally. Stay private.
             </h2>
             <p className="text-xl md:text-2xl text-muted-fg max-w-2xl mx-auto mb-12 relative z-10 font-light">
               Your source code and context packs never leave your machine. Models interact with logic via strictly isolated read-only orchestrations.
             </p>
             
             <div className="relative z-10 flex flex-col sm:flex-row justify-center gap-6">
                <LinkButton 
                  to="/download" 
                  size="lg" 
                  className="rounded-full px-12 h-16 text-lg font-semibold bg-white text-black hover:bg-white/90 shadow-xl transition-transform hover:scale-105"
                >
                  Download complete package
                </LinkButton>
             </div>
           </div>
        </div>

      </div>
    </Page>
  );
}
