import { motion } from "framer-motion";

export function HeroVisual() {
    return (
        <div className="relative flex items-center justify-center w-full h-full min-h-[400px] lg:min-h-[600px] pointer-events-none select-none">
            {/* Abstract Background Blurs */}
            <motion.div
                animate={{
                    scale: [1, 1.2, 1],
                    opacity: [0.3, 0.5, 0.3],
                    rotate: [0, 45, 0],
                }}
                transition={{
                    duration: 15,
                    repeat: Infinity,
                    ease: "easeInOut",
                }}
                className="absolute top-1/4 -right-10 w-96 h-96 bg-accent/20 rounded-full blur-[100px]"
            />
            <motion.div
                animate={{
                    scale: [1, 1.1, 1],
                    opacity: [0.3, 0.6, 0.3],
                    x: [0, -50, 0],
                }}
                transition={{
                    duration: 12,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: 2,
                }}
                className="absolute bottom-1/4 -left-10 w-80 h-80 bg-accent-2/20 rounded-full blur-[80px]"
            />

            {/* Main Visual: The Stack / Lanes Metaphor */}
            <div className="relative w-full max-w-2xl aspect-[16/10] perspective-[1200px]">
                {/* Base Grid Plane */}
                <motion.div
                    initial={{ opacity: 0, rotateX: 60, y: 100 }}
                    animate={{ opacity: 1, rotateX: 60, y: 0 }}
                    transition={{ duration: 1.5, ease: "easeOut" }}
                    className="absolute inset-0 bg-gradient-to-t from-accent/5 to-transparent border border-white/10 rounded-xl transform-gpu"
                    style={{ transformStyle: "preserve-3d" }}
                >
                    <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:40px_40px]" />
                </motion.div>

                {/* Floating Cards / Lanes */}
                <div className="absolute inset-0 flex items-center justify-center transform-gpu preserve-3d">
                    <FloatingCard
                        delay={0.2}
                        z={50}
                        className="w-[60%] h-[70%] bg-card/80 backdrop-blur-xl border border-white/20 rounded-2xl shadow-glass-lg flex flex-col p-4"
                    >
                        <div className="flex items-center gap-3 mb-4 border-b border-white/10 pb-2">
                            <div className="w-3 h-3 rounded-full bg-red-400/80" />
                            <div className="w-3 h-3 rounded-full bg-yellow-400/80" />
                            <div className="w-3 h-3 rounded-full bg-green-400/80" />
                        </div>
                        <div className="space-y-3 flex-1">
                            <div className="w-3/4 h-3 bg-white/10 rounded animate-pulse" />
                            <div className="w-1/2 h-3 bg-white/10 rounded animate-pulse delay-75" />
                            <div className="w-full h-32 bg-black/20 rounded-lg mt-4 border border-white/5" />
                        </div>
                    </FloatingCard>

                    <FloatingCard
                        delay={0.4}
                        z={0}
                        className="absolute top-10 -right-12 w-[40%] h-[50%] bg-card/60 backdrop-blur-md border border-white/10 rounded-xl shadow-glass-md p-3"
                        initial={{ x: 100, opacity: 0 }}
                    >
                        <div className="w-full h-full bg-accent/5 rounded animate-pulse" />
                    </FloatingCard>

                    <FloatingCard
                        delay={0.6}
                        z={-50}
                        className="absolute -bottom-5 -left-12 w-[40%] h-[50%] bg-card/60 backdrop-blur-md border border-white/10 rounded-xl shadow-glass-md p-3"
                        initial={{ x: -100, opacity: 0 }}
                    >
                        <div className="w-full h-full bg-accent-2/5 rounded animate-pulse" />
                    </FloatingCard>
                </div>
            </div>
        </div>
    );
}

function FloatingCard({ className, children, delay, z, initial }: any) {
    return (
        <motion.div
            initial={initial || { opacity: 0, y: 50, z: z }}
            animate={{ opacity: 1, y: 0, z: z }}
            transition={{ duration: 1, delay, ease: "easeOut" }}
            className={className}
            style={{
                transform: `translateZ(${z}px)`,
            }}
        >
            <motion.div
                animate={{ y: [-5, 5, -5] }}
                transition={{ duration: 6, repeat: Infinity, ease: "easeInOut", delay: delay * 2 }}
                className="w-full h-full"
            >
                {children}
            </motion.div>
        </motion.div>
    );
}
