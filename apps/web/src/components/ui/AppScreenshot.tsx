import { motion } from "framer-motion";
import { Terminal, GitBranch, Search, Menu, X, Minus, Square, Play, MoreHorizontal, FileCode, Folder } from "lucide-react";
import { cn } from "../../lib/cn";

export function AppScreenshot() {
    return (
        <div className="relative group perspective-[1200px]">
            {/* Glow Effect */}
            <div className="absolute inset-0 bg-accent/20 blur-[80px] rounded-full opacity-0 group-hover:opacity-30 transition-opacity duration-1000" />

            {/* App Window */}
            <motion.div
                initial={{ y: 50, rotateX: 5, opacity: 0 }}
                animate={{ y: 0, rotateX: 0, opacity: 1 }}
                transition={{ duration: 1, ease: "easeOut" }}
                className="relative bg-[#0d0d0d] rounded-xl border border-white/10 shadow-2xl overflow-hidden flex flex-col h-[500px] w-full max-w-4xl mx-auto"
            >
                {/* Title Bar */}
                <div className="h-10 border-b border-white/5 flex items-center justify-between px-4 bg-white/[0.02]">
                    <div className="flex items-center gap-2">
                        <div className="flex gap-1.5">
                            <div className="w-3 h-3 rounded-full bg-[#FF5F57]" />
                            <div className="w-3 h-3 rounded-full bg-[#FEBC2E]" />
                            <div className="w-3 h-3 rounded-full bg-[#28C840]" />
                        </div>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1 bg-white/5 rounded-md text-xs text-muted-fg font-medium border border-white/5 shadow-inner">
                        <ShieldIcon className="w-3 h-3" /> ADE / apps / web
                    </div>
                    <div className="w-16" /> {/* Spacer */}
                </div>

                <div className="flex-1 flex overflow-hidden">
                    {/* Sidebar (Lanes) */}
                    <div className="w-64 border-r border-white/5 bg-[#0a0a0a] flex flex-col">
                        <div className="p-3 border-b border-white/5">
                            <div className="flex items-center gap-2 text-xs font-semibold text-muted-fg uppercase tracking-wider mb-2">
                                Active Lanes
                            </div>
                            <div className="flex flex-col gap-1">
                                <LaneItem name="main" status="clean" active />
                                <LaneItem name="feat/auth-flow" status="modified" />
                                <LaneItem name="fix/crash-129" status="ahead" />
                            </div>
                        </div>
                        <div className="p-3">
                            <div className="flex items-center gap-2 text-xs font-semibold text-muted-fg uppercase tracking-wider mb-2">
                                Open Files
                            </div>
                            <div className="flex flex-col gap-1">
                                <FileItem name="HomePage.tsx" active />
                                <FileItem name="globals.css" />
                                <FileItem name="package.json" />
                            </div>
                        </div>
                    </div>

                    {/* Main Area (Editor & Terminal) */}
                    <div className="flex-1 flex flex-col bg-[#0d0d0d]">
                        {/* Editor Tabs */}
                        <div className="flex items-center border-b border-white/5 bg-[#0a0a0a]">
                            <TabItem name="HomePage.tsx" active />
                            <TabItem name="globals.css" />
                        </div>

                        {/* Editor Content */}
                        <div className="flex-1 p-6 font-mono text-sm leading-relaxed text-gray-400 overflow-hidden relative">
                            {/* Line Numbers */}
                            <div className="absolute left-0 top-6 bottom-0 w-12 text-right pr-4 text-white/20 select-none hidden sm:block">
                                {Array.from({ length: 20 }).map((_, i) => <div key={i}>{i + 1}</div>)}
                            </div>

                            <div className="sm:ml-12">
                                <div className="text-purple-400">import</div> <span className="text-white">{"{"} motion {"}"}</span> <div className="text-purple-400">from</div> <span className="text-green-400">"framer-motion"</span>;<br />
                                <div className="text-purple-400">import</div> <span className="text-white">{"{"} Page {"}"}</span> <div className="text-purple-400">from</div> <span className="text-green-400">"../../components/Page"</span>;<br />
                                <br />
                                <div className="text-purple-400">export function</div> <span className="text-yellow-300">HomePage</span>() {"{"}<br />
                                &nbsp;&nbsp;<span className="text-blue-400">useDocumentTitle</span>(<span className="text-green-400">"Mission Control"</span>);<br />
                                <br />
                                &nbsp;&nbsp;<div className="text-purple-400">return</div> (<br />
                                &nbsp;&nbsp;&nbsp;&nbsp;&lt;<span className="text-yellow-300">Page</span> <span className="text-blue-300">className</span>=<span className="text-green-400">"overflow-hidden"</span>&gt;<br />
                                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&lt;<span className="text-yellow-300">HeroSection</span> /&gt;<br />
                                &nbsp;&nbsp;&nbsp;&nbsp;&lt;/<span className="text-yellow-300">Page</span>&gt;<br />
                                &nbsp;&nbsp;);<br />
                                {"}"}
                                <motion.div
                                    animate={{ opacity: [1, 0, 1] }}
                                    transition={{ duration: 1, repeat: Infinity }}
                                    className="inline-block w-2.5 h-5 bg-accent ml-1 align-middle"
                                />
                            </div>
                        </div>

                        {/* Bottom Panel (Terminal) */}
                        <div className="h-32 border-t border-white/5 bg-[#080808] flex flex-col">
                            <div className="flex items-center justify-between px-4 h-8 border-b border-white/5 bg-white/[0.02]">
                                <div className="flex items-center gap-4 text-xs">
                                    <span className="text-accent border-b border-accent h-full flex items-center px-1">Terminal</span>
                                    <span className="text-muted-fg">Output</span>
                                    <span className="text-muted-fg">Problems</span>
                                </div>
                                <div className="flex gap-2">
                                    <Play className="w-3 h-3 text-green-500" />
                                    <X className="w-3 h-3 text-muted-fg" />
                                </div>
                            </div>
                            <div className="flex-1 p-3 font-mono text-xs text-gray-400 overflow-hidden">
                                <div className="flex gap-2">
                                    <span className="text-green-500">➜</span>
                                    <span className="text-blue-400">~/ADE</span>
                                    <span className="text-white">npm run dev</span>
                                </div>
                                <div className="mt-1 text-white/50">
                                    &nbsp;&nbsp;VITE v4.5.3	<span className="text-green-500">ready in 240 ms</span>
                                </div>
                                <div className="mt-1">
                                    &nbsp;&nbsp;<span className="text-white">➜</span>  <span className="text-white">Local:</span>   <span className="text-blue-400 underline">http://localhost:5173/</span>
                                </div>
                                <div className="mt-1">
                                    &nbsp;&nbsp;<span className="text-white">➜</span>  <span className="text-white">Network:</span> use --host to expose
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}

function LaneItem({ name, status, active }: any) {
    return (
        <div className={cn(
            "flex items-center justify-between px-3 py-1.5 rounded-md text-sm cursor-pointer hover:bg-white/5",
            active ? "bg-accent/10 text-accent font-medium border border-accent/20" : "text-muted-fg"
        )}>
            <div className="flex items-center gap-2">
                <GitBranch className={cn("w-3.5 h-3.5", active ? "text-accent" : "text-muted-fg")} />
                {name}
            </div>
            {status === 'ahead' && <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
            {status === 'modified' && <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" />}
        </div>
    )
}

function FileItem({ name, active }: any) {
    return (
        <div className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer hover:bg-white/5",
            active ? "text-fg" : "text-muted-fg"
        )}>
            <FileCode className="w-3.5 h-3.5 opacity-70" />
            {name}
        </div>
    )
}

function TabItem({ name, active }: any) {
    return (
        <div className={cn(
            "px-4 py-2 text-xs font-medium border-r border-white/5 cursor-pointer flex items-center gap-2",
            active ? "bg-[#0d0d0d] text-accent border-t-2 border-t-accent" : "bg-[#0a0a0a] text-muted-fg border-t-2 border-t-transparent hover:bg-[#0d0d0d]"
        )}>
            {name}
            {active && <X className="w-3 h-3 ml-1 opacity-50 hover:opacity-100" />}
        </div>
    )
}

function ShieldIcon({ className }: any) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
    )
}
