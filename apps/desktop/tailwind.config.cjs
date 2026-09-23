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
        // index.css defines `--color-secondary` in both themes; without a token
        // the class compiles to nothing. `bg-secondary` is a rail button's
        // PRESSED state, so a toggled-on control showed no background at all.
        secondary: "var(--color-secondary)",
        // The bare token, which the product spells and the config did not
        // register: `--color-surface` exists in BOTH themes in index.css,
        // three `surface-*` variants were registered, and `surface` itself
        // was not — so `bg-surface` compiled to nothing and the two places
        // that use it rendered with no background at all.
        surface: "var(--color-surface)",
        "surface-raised": "var(--color-surface-raised)",
        "surface-recessed": "var(--color-surface-recessed)",
        "surface-overlay": "var(--color-surface-overlay)",
        separator: "var(--color-separator)",
        "separator-active": "var(--color-separator-active)",
        glow: "var(--color-glow)",
        // The status tones. index.css defines all four in both themes and the
        // config registered none, so TimelineEntry's twelve utilities
        // (`text-info`, `bg-info/10`, `border-info/20` and the same for
        // success, warning and error) compiled to nothing and every CTO
        // timeline entry rendered with no tone at all.
        info: "var(--color-info)",
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        error: "var(--color-error)"
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
