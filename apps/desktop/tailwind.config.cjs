/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(var(--bg))",
        fg: "hsl(var(--fg))",
        card: "hsl(var(--card))",
        "card-fg": "hsl(var(--card-fg))",
        muted: "hsl(var(--muted))",
        "muted-fg": "hsl(var(--muted-fg))",
        border: "hsl(var(--border))",
        accent: "hsl(var(--accent))",
        "accent-fg": "hsl(var(--accent-fg))",
        "surface-raised": "var(--color-surface-raised)",
        "surface-recessed": "var(--color-surface-recessed)",
        "surface-overlay": "var(--color-surface-overlay)",
        separator: "var(--color-separator)",
        "separator-active": "var(--color-separator-active)",
        glow: "var(--color-glow)"
      },
      borderRadius: {
        xl: "var(--radius-xl)",
        lg: "var(--radius-lg)",
        md: "var(--radius-md)",
        sm: "var(--radius-sm)"
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
