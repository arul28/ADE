import { AnimatePresence, motion, useAnimation } from "framer-motion";
import { GitBranch, GitMerge, Check, AlertCircle } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/cn";

interface NodeProps {
    id: string;
    label: string;
    type: "main" | "feature";
    x: number;
    y: number;
    onDragEnd?: (id: string, point: { x: number; y: number }) => void;
    status?: "idle" | "merging" | "merged";
}

export function CanvasDemo() {
    const [nodes, setNodes] = useState<NodeProps[]>([
        { id: "main", label: "main", type: "main", x: 0, y: 0 },
        { id: "feat-a", label: "feat/auth-flow", type: "feature", x: -150, y: 120 },
        { id: "feat-b", label: "feat/ui-redesign", type: "feature", x: 150, y: 120 },
    ]);
    const [mergeStatus, setMergeStatus] = useState<"merging" | "success" | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);

    useEffect(() => {
        return () => {
            timerRefs.current.forEach(clearTimeout);
            timerRefs.current = [];
        };
    }, []);

    const handleDragEnd = (id: string, point: { x: number; y: number }) => {
        if (!containerRef.current) return;

        const distance = Math.sqrt(point.x * point.x + point.y * point.y);

        if (distance < 100) {
            // Clear any lingering timers from a previous merge
            timerRefs.current.forEach(clearTimeout);
            timerRefs.current = [];

            // Trigger Merge
            setMergeStatus("merging");
            timerRefs.current.push(setTimeout(() => {
                setMergeStatus("success");
                setNodes(prev => prev.map(n => n.id === id ? { ...n, status: "merged" } : n));

                timerRefs.current.push(setTimeout(() => {
                    setMergeStatus(null);
                    timerRefs.current.push(setTimeout(() => {
                        setNodes(prev => prev.map(n => n.id === id ? { ...n, status: "idle", x: n.id === 'feat-a' ? -150 : 150, y: 120 } : n));
                    }, 2000));
                }, 2000));
            }, 1500));
        }
    };

    return (
        <div className="relative w-full h-[600px] bg-black/80 rounded-3xl overflow-hidden border border-white/10 shadow-2xl flex items-center justify-center select-none group">
            <div ref={containerRef} className="relative w-full h-full flex items-center justify-center">
                {/* Grid Background */}
                <div className="absolute inset-0 opacity-20 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />

                {/* Main Branch Line (Visual) */}
                <div className="absolute top-0 bottom-0 w-px bg-white/10" />

                {/* Nodes */}
                {nodes.map((node) => (
                    <DraggableNode
                        key={node.id}
                        {...node}
                        onDragEnd={handleDragEnd}
                        isTarget={node.type === 'main'}
                    />
                ))}

                {/* Merge Toast/Status */}
                <AnimatePresence>
                    {mergeStatus && (
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="absolute top-8 px-4 py-2 bg-white/10 backdrop-blur-md border border-white/10 rounded-full flex items-center gap-2 text-sm font-medium z-50"
                        >
                            {mergeStatus === 'merging' && (
                                <>
                                    <GitMerge className="w-4 h-4 animate-spin" />
                                    <span>Simulating Merge...</span>
                                </>
                            )}
                            {mergeStatus === 'success' && (
                                <>
                                    <Check className="w-4 h-4 text-green-400" />
                                    <span>Merged Successfully</span>
                                </>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>

                <div className="absolute bottom-6 text-muted-fg text-xs">
                    Try dragging a feature branch onto main to merge.
                </div>
            </div>
        </div>
    );
}

function DraggableNode({ id, label, type, x, y, onDragEnd, isTarget, status }: any) {
    const controls = useAnimation();

    useEffect(() => {
        if (status === 'idle') {
            controls.start({ x, y, scale: 1, opacity: 1 });
        } else if (status === 'merging') {
            controls.start({ x: 0, y: 0, scale: 0.5, opacity: 0 });
        } else if (status === 'merged') {
            controls.start({ opacity: 0, scale: 0 });
        }
    }, [status, x, y, controls]);

    return (
        <motion.div
            drag={!isTarget && status !== 'merged'}
            dragConstraints={{ left: -300, right: 300, top: -200, bottom: 200 }}
            dragElastic={0.1}
            whileDrag={{ scale: 1.1, cursor: "grabbing" }}
            animate={controls}
            initial={{ x, y }}
            onDragEnd={(e, info) => {
                if (!isTarget && onDragEnd) {
                    // Calculate roughly where we are relative to center
                    // We can use the drag info's offset or point. 
                    // Let's passed the offset which is relative to start `x,y`.
                    // To get absolute position relative to center: 
                    const currentX = x + info.offset.x;
                    const currentY = y + info.offset.y;
                    onDragEnd(id, { x: currentX, y: currentY });

                    // Snap back if not merged (handled by parent logic normally, but for demo we animate back if condition fails)
                    // Note: The parent logic above handles the success case. 
                    // Ideally we'd need a callback to know if it succeeded to snap back. 
                    // For this demo, let's just visually snap back if user releases far away.
                    const dist = Math.sqrt(currentX * currentX + currentY * currentY);
                    if (dist >= 100 && status !== 'merged') {
                        controls.start({ x, y });
                    }
                }
            }}
            className={cn(
                "absolute flex items-center gap-3 px-4 py-3 rounded-xl border shadow-xl backdrop-blur-md cursor-grab active:cursor-grabbing z-10 w-48",
                isTarget
                    ? "bg-black/50 border-white/20 z-0 cursor-default"
                    : "bg-card/80 border-white/10 hover:border-accent/50"
            )}
        >
            <div className={cn(
                "w-10 h-10 rounded-full flex items-center justify-center border",
                type === 'main' ? "bg-white/10 border-white/20" : "bg-accent/10 border-accent/20"
            )}>
                <GitBranch className={cn("w-5 h-5", type === 'main' ? "text-white/70" : "text-accent")} />
            </div>
            <div className="flex flex-col">
                <span className="text-xs text-muted-fg font-mono uppercase tracking-wider">{type}</span>
                <span className="text-sm font-semibold text-fg">{label}</span>
            </div>

            {/* Connecting Line (Visual Mockup for Feature Branches) */}
            {!isTarget && (
                <svg className="absolute top-1/2 right-full w-24 h-[2px] overflow-visible -z-10 pointer-events-none opacity-20">
                    <line x1="0" y1="0" x2="100" y2="0" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
                </svg>
            )}
        </motion.div>
    )
}
