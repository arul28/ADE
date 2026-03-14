/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--color-bg)",
        fg: "var(--color-fg)",
        card: "var(--color-card)",
        "card-fg": "var(--color-card-fg)",
        muted: "var(--color-muted)",
        "muted-fg": "var(--color-muted-fg)",
        border: "var(--color-border)",
        accent: "var(--color-accent)",
        "accent-fg": "var(--color-accent-fg)",
        "surface-raised": "var(--color-surface-raised)",
        "surface-recessed": "var(--color-surface-recessed)",
        "surface-overlay": "var(--color-surface-overlay)",
        separator: "var(--color-separator)",
        "separator-active": "var(--color-separator-active)",
        glow: "var(--color-glow)"
      },
      borderRadius: {
        xl: "16px",
        lg: "12px",
        md: "8px",
        sm: "6px"
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
        serif: ["var(--font-serif)"]
      },
      boxShadow: {
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-hover)",
        float: "var(--shadow-float)",
        inset: "var(--shadow-inset)",
        separator: "var(--shadow-separator)",
        panel: "var(--shadow-panel)"
      }
    }
  },
  plugins: []
};
