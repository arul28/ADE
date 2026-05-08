import { ArrowRight } from "@phosphor-icons/react";

type Props = {
  onContinue: () => void;
};

export function StepWelcome({ onContinue }: Props) {
  return (
    <section
      data-testid="wizard-step-welcome"
      className="flex flex-col items-center gap-6 text-center"
    >
      <div
        aria-hidden="true"
        className="flex w-full justify-center"
        style={{
          animation:
            "ade-wizard-illo-in-forward 360ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <MacInsideMacIllustration />
      </div>
      <span
        className="uppercase tracking-[0.16em]"
        style={{
          fontSize: 10.5,
          color: "var(--color-accent, #A78BFA)",
          fontWeight: 600,
        }}
      >
        macOS VM
      </span>
      <h1
        className="font-semibold"
        style={{
          fontSize: 26,
          letterSpacing: "-0.01em",
          margin: 0,
          lineHeight: 1.15,
        }}
      >
        Run a real macOS, just for this lane
      </h1>
      <p
        className="max-w-[480px]"
        style={{
          fontSize: 14,
          lineHeight: 1.6,
          color: "var(--color-muted-fg, #B7B6C3)",
          margin: 0,
        }}
      >
        We&rsquo;ll walk you through installing macOS once, then save a snapshot
        so future lanes spin up a clean machine in seconds.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          data-wizard-primary="true"
          aria-label="Get started with macOS VM setup"
          onClick={onContinue}
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#A78BFA)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-popup-bg,#141022)]"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 600,
            padding: "9px 18px",
            background: "var(--color-accent, #A78BFA)",
            color: "var(--color-accent-fg, #0B0620)",
            border: "1px solid transparent",
            borderRadius: 8,
            cursor: "pointer",
            boxShadow: "0 4px 14px -4px rgba(167, 139, 250, 0.55)",
          }}
        >
          Get started
          <ArrowRight size={14} weight="bold" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

const ACCENT = "var(--color-accent, #A78BFA)";
const ACCENT_SOFT = "rgba(167, 139, 250, 0.18)";
const INK = "var(--color-fg, #F0F0F2)";
const LINE = "rgba(255, 255, 255, 0.18)";
const SURFACE = "rgba(255, 255, 255, 0.04)";

function MacInsideMacIllustration() {
  return (
    <svg
      viewBox="0 0 320 180"
      width="320"
      height="180"
      role="img"
      aria-label="A Mac running another Mac inside it"
      style={{ maxWidth: "100%", height: "auto" }}
    >
      <defs>
        <radialGradient id="macvm-glow" cx="50%" cy="40%" r="65%">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.32" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="macvm-screen" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(20, 16, 34, 0.95)" />
          <stop offset="100%" stopColor="rgba(28, 22, 48, 0.95)" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="320" height="180" fill="url(#macvm-glow)" />

      {/* Outer Mac (host) — display + chin + stand */}
      <g>
        {/* Display bezel */}
        <rect
          x="46"
          y="22"
          width="228"
          height="120"
          rx="10"
          ry="10"
          fill="rgba(255,255,255,0.05)"
          stroke={LINE}
          strokeWidth="1"
        />
        {/* Screen */}
        <rect
          x="54"
          y="30"
          width="212"
          height="100"
          rx="3"
          ry="3"
          fill="url(#macvm-screen)"
          stroke="rgba(255,255,255,0.06)"
        />
        {/* Camera notch */}
        <circle cx="160" cy="29.5" r="1.5" fill={LINE} />
        {/* Chin */}
        <rect x="46" y="142" width="228" height="6" rx="3" fill="rgba(255,255,255,0.06)" stroke={LINE} />
        {/* Stand */}
        <path
          d="M150 148 L170 148 L173 162 L147 162 Z"
          fill="rgba(255,255,255,0.05)"
          stroke={LINE}
        />
        <rect x="135" y="161" width="50" height="3" rx="1.5" fill="rgba(255,255,255,0.06)" stroke={LINE} />
      </g>

      {/* Menu bar inside the host screen */}
      <g>
        <rect x="54" y="30" width="212" height="9" fill="rgba(255,255,255,0.04)" />
        <circle cx="61" cy="34.5" r="1.6" fill="#ff5f56" opacity="0.7" />
        <circle cx="68" cy="34.5" r="1.6" fill="#ffbd2e" opacity="0.7" />
        <circle cx="75" cy="34.5" r="1.6" fill="#27c93f" opacity="0.7" />
        <rect x="92" y="33" width="22" height="3" rx="1.5" fill={LINE} />
        <rect x="120" y="33" width="14" height="3" rx="1.5" fill={LINE} />
        <rect x="140" y="33" width="10" height="3" rx="1.5" fill={LINE} />
      </g>

      {/* Inner Mac (guest) — animated breathing */}
      <g
        style={{
          transformOrigin: "160px 84px",
          animation: "ade-macvm-breath 4s ease-in-out infinite",
        }}
      >
        <rect
          x="98"
          y="50"
          width="124"
          height="68"
          rx="6"
          ry="6"
          fill={SURFACE}
          stroke={LINE}
        />
        <rect
          x="103"
          y="55"
          width="114"
          height="54"
          rx="2"
          fill="rgba(15, 12, 28, 0.95)"
          stroke="rgba(255,255,255,0.06)"
        />
        {/* Inner-inner Mac (recursion) */}
        <g
          style={{
            transformOrigin: "160px 82px",
            animation: "ade-macvm-spin 12s linear infinite",
          }}
        >
          <rect
            x="130"
            y="64"
            width="60"
            height="36"
            rx="3"
            fill={ACCENT_SOFT}
            stroke="rgba(167,139,250,0.45)"
          />
          {/* Apple-ish dot in the middle to suggest a guest desktop */}
          <circle cx="160" cy="82" r="4" fill={ACCENT}>
            <animate
              attributeName="r"
              values="3.5;5;3.5"
              dur="2.4s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.85;1;0.85"
              dur="2.4s"
              repeatCount="indefinite"
            />
          </circle>
        </g>
      </g>

      {/* Loop arrow — virtualization "snapshot then clone" cue */}
      <g
        style={{
          transformOrigin: "292px 92px",
          animation: "ade-macvm-spin 6s linear infinite",
        }}
        opacity="0.7"
      >
        <circle
          cx="292"
          cy="92"
          r="14"
          fill="none"
          stroke={ACCENT}
          strokeWidth="1.2"
          strokeDasharray="4 3"
        />
        <path
          d="M306 92 L302 88 M306 92 L302 96"
          stroke={ACCENT}
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />
      </g>

      {/* Status pulse dot — shows "running" */}
      <g transform="translate(70, 124)">
        <circle r="3" fill="rgb(110, 231, 183)">
          <animate
            attributeName="opacity"
            values="1;0.4;1"
            dur="1.6s"
            repeatCount="indefinite"
          />
        </circle>
        <text
          x="8"
          y="3.5"
          fontFamily="inherit"
          fontSize="7.5"
          fill={INK}
          opacity="0.7"
        >
          running
        </text>
      </g>

      <style>{`
        @keyframes ade-macvm-breath {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.025); }
        }
        @keyframes ade-macvm-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </svg>
  );
}
