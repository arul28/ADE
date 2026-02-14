export function ArchitectureDiagram({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 980 360"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="ADE architecture: main process, renderer UI, and read-only hosted agent"
    >
      <defs>
        <linearGradient id="ade-arch-bg" x1="140" y1="40" x2="860" y2="320" gradientUnits="userSpaceOnUse">
          <stop stopColor="rgba(27,118,255,0.10)" />
          <stop offset="1" stopColor="rgba(85,211,255,0.10)" />
        </linearGradient>
        <linearGradient id="ade-arch-acc" x1="220" y1="120" x2="780" y2="260" gradientUnits="userSpaceOnUse">
          <stop stopColor="#55D3FF" />
          <stop offset="1" stopColor="#1B76FF" />
        </linearGradient>
      </defs>

      <rect x="18" y="18" width="944" height="324" rx="26" fill="url(#ade-arch-bg)" stroke="rgba(0,0,0,0.08)" />

      <g>
        <rect x="64" y="92" width="264" height="176" rx="22" fill="rgba(255,255,255,0.72)" stroke="rgba(0,0,0,0.10)" />
        <text x="90" y="132" fontSize="16" fill="rgba(0,0,0,0.72)" fontFamily="var(--font-sans)">
          Main Process (Trusted)
        </text>
        <text x="90" y="160" fontSize="13" fill="rgba(0,0,0,0.55)" fontFamily="var(--font-sans)">
          Filesystem + Git + PTY + Jobs
        </text>
        <text x="90" y="184" fontSize="13" fill="rgba(0,0,0,0.55)" fontFamily="var(--font-sans)">
          Pack materialization + checkpoints
        </text>
        <text x="90" y="208" fontSize="13" fill="rgba(0,0,0,0.55)" fontFamily="var(--font-sans)">
          Local database + atomic writes
        </text>
      </g>

      <g>
        <rect x="358" y="92" width="264" height="176" rx="22" fill="rgba(255,255,255,0.72)" stroke="rgba(0,0,0,0.10)" />
        <text x="384" y="132" fontSize="16" fill="rgba(0,0,0,0.72)" fontFamily="var(--font-sans)">
          Renderer UI (Untrusted)
        </text>
        <text x="384" y="160" fontSize="13" fill="rgba(0,0,0,0.55)" fontFamily="var(--font-sans)">
          React app shell + pages
        </text>
        <text x="384" y="184" fontSize="13" fill="rgba(0,0,0,0.55)" fontFamily="var(--font-sans)">
          No direct file/process access
        </text>
        <text x="384" y="208" fontSize="13" fill="rgba(0,0,0,0.55)" fontFamily="var(--font-sans)">
          Typed IPC calls only
        </text>
      </g>

      <g>
        <rect x="652" y="92" width="264" height="176" rx="22" fill="rgba(255,255,255,0.72)" stroke="rgba(0,0,0,0.10)" />
        <text x="678" y="132" fontSize="16" fill="rgba(0,0,0,0.72)" fontFamily="var(--font-sans)">
          Hosted Agent (Read-Only)
        </text>
        <text x="678" y="160" fontSize="13" fill="rgba(0,0,0,0.55)" fontFamily="var(--font-sans)">
          Narrative packs + summaries
        </text>
        <text x="678" y="184" fontSize="13" fill="rgba(0,0,0,0.55)" fontFamily="var(--font-sans)">
          Conflict resolution proposals
        </text>
        <text x="678" y="208" fontSize="13" fill="rgba(0,0,0,0.55)" fontFamily="var(--font-sans)">
          Returns diffs for review
        </text>
      </g>

      <path
        d="M332 180h18m0 0l-8-8m8 8l-8 8"
        stroke="url(#ade-arch-acc)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
      <path
        d="M626 180h18m0 0l-8-8m8 8l-8 8"
        stroke="url(#ade-arch-acc)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />

      <text x="360" y="300" fontSize="12" fill="rgba(0,0,0,0.45)" fontFamily="var(--font-mono)">
        IPC boundary • context isolation • least privilege
      </text>
    </svg>
  );
}

