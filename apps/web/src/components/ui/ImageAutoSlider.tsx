const SCREENSHOTS = [
  { src: "/images/screenshots/agent-chat.png", alt: "Agent chat" },
  { src: "/images/screenshots/cto.png", alt: "CTO agent" },
  { src: "/images/screenshots/files.png", alt: "File explorer" },
  { src: "/images/screenshots/git history.png", alt: "Git history" },
  { src: "/images/screenshots/lanes.png", alt: "Lanes" },
  { src: "/images/screenshots/linear-sync.png", alt: "Linear sync" },
  { src: "/images/screenshots/multi-tasking.png", alt: "Multi-tasking" },
  { src: "/images/screenshots/prs.png", alt: "Pull requests" },
  { src: "/images/screenshots/run.png", alt: "Process runner" },
  { src: "/images/screenshots/workspacegraph.png", alt: "Workspace graph" },
];

const FEATURES = [
  { src: "/images/features/agent-chat.png", alt: "Agent chat feature" },
  { src: "/images/features/cto.png", alt: "CTO feature" },
  { src: "/images/features/files.png", alt: "Files feature" },
  { src: "/images/features/git history.png", alt: "Git history feature" },
  { src: "/images/features/linear-sync.png", alt: "Linear sync feature" },
  { src: "/images/features/modelconfig.png", alt: "Model config" },
  { src: "/images/features/multi-tasking.png", alt: "Multi-tasking feature" },
  { src: "/images/features/prs.png", alt: "Pull requests feature" },
  { src: "/images/features/run.png", alt: "Run feature" },
  { src: "/images/features/terminals.png", alt: "Terminals" },
  { src: "/images/features/workspacegraph.png", alt: "Workspace graph feature" },
];

const ALL_IMAGES = [...SCREENSHOTS, ...FEATURES];

export function ImageAutoSlider() {
  // Duplicate the array for seamless infinite loop
  const doubled = [...ALL_IMAGES, ...ALL_IMAGES];

  return (
    <>
      <style>{`
        @keyframes autoslide {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .autoslide-track {
          animation: autoslide 180s linear infinite;
        }
        .autoslide-mask {
          mask-image: linear-gradient(
            to right,
            transparent 0%,
            black 8%,
            black 92%,
            transparent 100%
          );
          -webkit-mask-image: linear-gradient(
            to right,
            transparent 0%,
            black 8%,
            black 92%,
            transparent 100%
          );
        }
      `}</style>

      <div
        className="autoslide-mask relative w-full overflow-hidden py-4"
        role="region"
        aria-label="ADE product screenshots"
      >
        <div className="autoslide-track flex w-max items-center gap-5 sm:gap-6">
          {doubled.map((img, i) => (
            <div
              key={`${img.src}-${i}`}
              className="shrink-0 w-[42rem] h-[26rem] md:w-[56rem] md:h-[34rem] lg:w-[72rem] lg:h-[44rem] overflow-hidden rounded-xl border border-border/50 transition-transform duration-300 hover:scale-[1.02]"
            >
              <img
                src={img.src}
                alt={img.alt}
                className="h-full w-full object-cover object-top"
                draggable={false}
                loading={i < 3 ? "eager" : "lazy"}
                fetchPriority={i === 0 ? "high" : undefined}
                decoding="async"
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
