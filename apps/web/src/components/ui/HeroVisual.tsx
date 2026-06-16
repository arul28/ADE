import { motion } from "framer-motion";

const SLIDES = [
    { src: "/images/hero/hero-tui.png", alt: "ADE Code TUI — terminal Work chat" },
    { src: "/images/hero/hero-desktop.png", alt: "ADE on macOS — desktop workspace" },
    { src: "/images/hero/hero-mobile.png", alt: "ADE on iOS — mobile companion" },
] as const;

export function HeroVisual() {
    return (
        <div
            className="hero-splash-carousel relative w-full min-h-[260px] select-none py-6 sm:min-h-[300px] sm:py-8"
            role="region"
            aria-label="ADE product screenshots"
        >
            <motion.div
                aria-hidden="true"
                animate={{
                    scale: [1, 1.15, 1],
                    opacity: [0.2, 0.4, 0.2],
                    rotate: [0, 40, 0],
                }}
                transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
                className="pointer-events-none absolute -right-16 top-1/4 h-80 w-80 rounded-full bg-accent/12 blur-[100px]"
            />
            <motion.div
                aria-hidden="true"
                animate={{
                    scale: [1, 1.08, 1],
                    opacity: [0.2, 0.45, 0.2],
                    x: [0, -40, 0],
                }}
                transition={{ duration: 14, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
                className="pointer-events-none absolute -left-16 bottom-1/4 h-72 w-72 rounded-full bg-accent-2/12 blur-[90px]"
            />

            <div className="relative w-full overflow-hidden">
                <div className="flex w-max gap-5 sm:gap-8 animate-splash-marquee-ltr">
                    {[...SLIDES, ...SLIDES].map((slide, i) => (
                        <SplashSlide key={`${slide.src}-${i}`} src={slide.src} alt={slide.alt} />
                    ))}
                </div>
            </div>
        </div>
    );
}

function SplashSlide({ src, alt }: { src: string; alt: string }) {
    return (
        <div className="shrink-0 w-[min(78vw,520px)] sm:w-[min(72vw,560px)] lg:w-[min(68vw,600px)]">
            <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg sm:rounded-xl">
                <img
                    src={src}
                    alt={alt}
                    className="absolute inset-0 h-full w-full object-cover object-top"
                    draggable={false}
                    loading="eager"
                    decoding="async"
                />
            </div>
        </div>
    );
}
