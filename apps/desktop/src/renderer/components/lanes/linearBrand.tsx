export const LINEAR_BRAND = {
  primary: "#5E6AD2",
  primaryBright: "#7B8AF0",
  primaryDeep: "#4752B5",
  surface: "rgba(94, 106, 210, 0.10)",
  surfaceHover: "rgba(94, 106, 210, 0.16)",
  border: "rgba(94, 106, 210, 0.32)",
  borderSubtle: "rgba(94, 106, 210, 0.20)",
  text: "#C7CDF5",
  textMuted: "rgba(199, 205, 245, 0.65)",
} as const;

export function LinearMark({ size = 14, className }: { size?: number | string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className={className}
      style={{ display: "block" }}
    >
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  );
}

const STATE_COLORS = {
  backlog: "#94A3B8",
  unstarted: "#94A3B8",
  started: "#F2C94C",
  completed: "#5E6AD2",
  canceled: "#94A3B8",
  triage: "#F2994A",
} as const;

type StateType = keyof typeof STATE_COLORS;

export function LinearStateIcon({
  stateType,
  size = 14,
}: {
  stateType: string;
  size?: number;
}) {
  const type = (Object.prototype.hasOwnProperty.call(STATE_COLORS, stateType) ? stateType : "unstarted") as StateType;
  const color = STATE_COLORS[type];
  const stroke = Math.max(1.4, size * 0.12);
  const inset = stroke / 2;
  const r = size / 2 - inset;
  const center = size / 2;
  const dashArray = `${stroke * 1.7} ${stroke * 1.4}`;

  if (type === "backlog") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={dashArray}
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (type === "unstarted" || type === "triage") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
        <circle cx={center} cy={center} r={r} fill="none" stroke={color} strokeWidth={stroke} />
      </svg>
    );
  }

  if (type === "started") {
    const innerR = r - stroke * 0.6;
    const sweep = `M ${center} ${center} L ${center} ${center - innerR} A ${innerR} ${innerR} 0 0 1 ${center + innerR} ${center} Z`;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
        <circle cx={center} cy={center} r={r} fill="none" stroke={color} strokeWidth={stroke} />
        <path d={sweep} fill={color} />
      </svg>
    );
  }

  if (type === "completed") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
        <circle cx={center} cy={center} r={r + inset} fill={color} />
        <path
          d={`M ${center - r * 0.45} ${center} L ${center - r * 0.1} ${center + r * 0.38} L ${center + r * 0.55} ${center - r * 0.35}`}
          fill="none"
          stroke="#0C0B10"
          strokeWidth={stroke * 1.1}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // canceled
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
      <circle cx={center} cy={center} r={r + inset} fill={color} opacity="0.9" />
      <path
        d={`M ${center - r * 0.45} ${center - r * 0.45} L ${center + r * 0.45} ${center + r * 0.45} M ${center - r * 0.45} ${center + r * 0.45} L ${center + r * 0.45} ${center - r * 0.45}`}
        stroke="#0C0B10"
        strokeWidth={stroke * 1.1}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function LinearPriorityIcon({
  priority,
  size = 14,
}: {
  /** Linear priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low. */
  priority: number;
  size?: number;
}) {
  const dim = "rgba(148, 163, 184, 0.40)";
  const strong = "#C7CDF5";

  if (priority === 1) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
        <rect x={size * 0.12} y={size * 0.12} width={size * 0.76} height={size * 0.76} rx={size * 0.18} fill="#EB5757" />
        <rect x={size * 0.45} y={size * 0.28} width={size * 0.10} height={size * 0.32} rx={size * 0.05} fill="#fff" />
        <rect x={size * 0.45} y={size * 0.65} width={size * 0.10} height={size * 0.10} rx={size * 0.05} fill="#fff" />
      </svg>
    );
  }

  if (priority === 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
        <rect x={size * 0.18} y={size * 0.46} width={size * 0.64} height={size * 0.10} rx={size * 0.05} fill={dim} />
      </svg>
    );
  }

  // 2 = high (3 bars), 3 = medium (2 bars), 4 = low (1 bar)
  const filledBars = priority === 2 ? 3 : priority === 3 ? 2 : 1;
  const barWidth = size * 0.18;
  const barGap = size * 0.10;
  const totalWidth = barWidth * 3 + barGap * 2;
  const startX = (size - totalWidth) / 2;
  const heights = [size * 0.32, size * 0.55, size * 0.78];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
      {[0, 1, 2].map((i) => {
        const h = heights[i]!;
        const filled = i < filledBars;
        return (
          <rect
            key={i}
            x={startX + i * (barWidth + barGap)}
            y={size - h - size * 0.12}
            width={barWidth}
            height={h}
            rx={size * 0.04}
            fill={filled ? strong : dim}
          />
        );
      })}
    </svg>
  );
}
