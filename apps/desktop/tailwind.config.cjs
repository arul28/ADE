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
        // `bg-surface` is used across the Apple feature (and the round-3 rule is
        // that every panel in it is opaque), but the scale only had the three
        // `surface-*` variants — so every `bg-surface` in the product compiled
        // to nothing and those panels rendered fully transparent. The variable
        // has been in `index.css` the whole time.
        // index.css has defined these in both themes all along; without a token
        // the class compiles to nothing. `bg-secondary` is a rail button's
        // PRESSED state, so a toggled-on control showed no background at all,
        // and the CTO timeline's info/success/warning/error text had no colour.
        secondary: "var(--color-secondary)",
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        info: "var(--color-info)",
        error: "var(--color-error)",
        surface: "var(--color-surface)",
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
