import type { JiraStatusCategory } from "../../../shared/types/jira";

export const JIRA_BRAND = {
  primary: "#1868DB",
  primaryBright: "#2684FF",
  primaryDeep: "#0C66E4",
  surface: "rgba(38, 132, 255, 0.10)",
  surfaceHover: "rgba(38, 132, 255, 0.16)",
  border: "rgba(38, 132, 255, 0.32)",
  borderSubtle: "rgba(38, 132, 255, 0.20)",
  text: "#DCEBFF",
  textMuted: "rgba(220, 235, 255, 0.65)",
} as const;

export const JIRA_STATUS_CATEGORY_COLOR: Record<JiraStatusCategory, string> = {
  new: "#626F86",
  indeterminate: "#1868DB",
  done: "#22A06B",
};

/** Simple Icons' canonical Jira mark path (viewBox 0 0 24 24). */
export const JIRA_LOGO_PATH =
  "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z";

export function JiraMark({ size = 14, className }: { size?: number | string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={JIRA_BRAND.primaryBright}
      aria-hidden="true"
      className={className}
      style={{ display: "block" }}
    >
      <path d={JIRA_LOGO_PATH} />
    </svg>
  );
}

export function JiraStatusIcon({ category, size = 12 }: { category: JiraStatusCategory; size?: number }) {
  const stroke = Math.max(1.4, size * 0.12);
  const inset = stroke / 2;
  const radius = size / 2 - inset;
  const center = size / 2;
  const color = JIRA_STATUS_CATEGORY_COLOR[category];

  if (category === "done") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
        <circle cx={center} cy={center} r={radius + inset} fill={color} />
        <path
          d={`M ${center - radius * 0.45} ${center} L ${center - radius * 0.1} ${center + radius * 0.38} L ${center + radius * 0.55} ${center - radius * 0.35}`}
          fill="none"
          stroke="#fff"
          strokeWidth={stroke * 1.1}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (category === "indeterminate") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
        <circle cx={center} cy={center} r={radius} fill="none" stroke={color} strokeWidth={stroke} />
        <path
          d={`M ${center} ${center - radius} A ${radius} ${radius} 0 0 1 ${center + radius} ${center}`}
          fill="none"
          stroke={color}
          strokeWidth={stroke * 2.2}
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
      <circle cx={center} cy={center} r={radius} fill="none" stroke={color} strokeWidth={stroke} />
    </svg>
  );
}
