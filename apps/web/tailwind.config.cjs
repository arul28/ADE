/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx,html}"],
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
        "accent-2": "hsl(var(--accent-2))",
        "accent-fg": "hsl(var(--accent-fg))"
      },
      borderRadius: {
        xl: "var(--radius-xl)",
        lg: "var(--radius-lg)",
        md: "var(--radius-md)"
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      boxShadow: {
        "glass-sm": "0 8px 30px rgba(0,0,0,0.06)",
        "glass-md": "0 20px 60px rgba(0,0,0,0.12)"
      }
    }
  },
  plugins: []
};
