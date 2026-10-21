import { useId } from "react";

/** ADE's tour cursor: a violet arrow with a light edge and a soft glow, a size up from the system one. */
export function AdeTourCursorArt() {
  const gradientId = `ade-tour-cursor-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
      <defs>
        <linearGradient id={gradientId} x1="4" y1="3" x2="18" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#C4B5FD" />
          <stop offset="0.55" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#6D28D9" />
        </linearGradient>
      </defs>
      <path
        d="M3.6 3.2 L3.6 23.4 Q3.6 24.6 4.6 23.9 L9.3 19.6 L12.9 27.1 Q13.3 27.9 14.1 27.5 L16.8 26.3 Q17.6 25.9 17.2 25.1 L13.7 17.8 L20.3 17.4 Q21.5 17.3 20.6 16.5 L4.8 2.6 Q3.6 1.7 3.6 3.2 Z"
        fill={`url(#${gradientId})`}
        stroke="#FFFFFF"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
