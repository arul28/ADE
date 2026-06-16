import type { CSSProperties } from "react";

/**
 * Social link-preview card, rendered at exactly 1200×630 and screenshotted to
 * /og-image.png. Mirrors the site hero — the competitor equation, the headline,
 * and the desktop + TUI + iPhone trio (hand-labelled), minus the install CTAs.
 */
const rainbow: CSSProperties = {
  background:
    "linear-gradient(90deg,#ff6b6b 0%,#feca57 18%,#48dbfb 38%,#1dd1a1 55%,#a78bfa 74%,#ff9ff3 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

const frame =
  "overflow-hidden border border-[color:var(--color-hairline-strong)] bg-[#07070b] ring-1 ring-white/[0.05]";

const hand: CSSProperties = {
  fontFamily: "'Caveat', cursive",
  color: "#efe6d0",
  fontWeight: 600,
};

const COMPETITORS = [
  "claude-code",
  "codex",
  "opencode",
  "t3-code",
  "cursor",
  "superset",
  "conductor",
  "factory",
  "paperclip",
  "github",
];

export function OgImage() {
  return (
    <div
      className="relative overflow-hidden font-sans"
      style={{ width: 1200, height: 630, background: "#0a0a0f" }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&display=swap');`}</style>

      {/* violet gradient wash */}
      <div
        className="absolute inset-0"
        style={{
          background: [
            "radial-gradient(ellipse 72% 62% at 50% 36%, rgba(124,58,237,0.34) 0%, transparent 70%)",
            "radial-gradient(ellipse 48% 50% at 10% 0%, rgba(167,139,250,0.10) 0%, transparent 70%)",
            "radial-gradient(ellipse 40% 36% at 92% 8%, rgba(99,102,241,0.12) 0%, transparent 72%)",
          ].join(", "),
        }}
      />
      {/* dot grid */}
      <div
        className="absolute inset-0"
        style={{
          opacity: 0.04,
          backgroundImage:
            "radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />

      {/* competitor equation — every tool = ADE (ADE much larger) */}
      <div
        className="absolute left-1/2 flex -translate-x-1/2 items-center justify-center"
        style={{ top: 22, gap: 8 }}
      >
        {COMPETITORS.map((slug, i) => (
          <div key={slug} className="flex items-center" style={{ gap: 8 }}>
            {i > 0 ? (
              <span className="font-serif" style={{ color: "rgba(239,230,208,0.4)", fontSize: 14 }}>
                +
              </span>
            ) : null}
            <div
              className="flex items-center justify-center overflow-hidden"
              style={{
                height: 28,
                width: 28,
                borderRadius: 7,
                border: "1px solid rgba(239,230,208,0.16)",
                background: "rgba(255,255,255,0.045)",
                padding: 3,
              }}
            >
              <img
                src={`/images/competitors/${slug}.webp`}
                alt=""
                style={{ height: "100%", width: "100%", objectFit: "contain" }}
              />
            </div>
          </div>
        ))}
        <span
          className="font-serif italic"
          style={{ color: "#a78bfa", fontSize: 26, margin: "0 10px 0 12px" }}
        >
          equals
        </span>
        <img
          src="/images/ade-dock-icon.webp"
          alt="ADE"
          style={{
            height: 86,
            width: 86,
            borderRadius: "24%",
            objectFit: "contain",
            filter: "drop-shadow(0 12px 36px rgba(124,58,237,0.7))",
          }}
        />
      </div>

      {/* headline */}
      <h1
        className="absolute left-1/2 w-full -translate-x-1/2 text-center font-serif"
        style={{
          top: 124,
          margin: 0,
          color: "#efe6d0",
          fontSize: 50,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
        }}
      >
        <em className="italic" style={{ color: "#a78bfa" }}>
          Every
        </em>{" "}
        AI coding tool.
        <br />
        <em className="italic" style={{ color: "#a78bfa" }}>
          One
        </em>{" "}
        app that runs <span style={rainbow}>everywhere</span>.
      </h1>

      {/* device trio — larger */}
      <div className="absolute left-1/2 -translate-x-1/2" style={{ top: 246, width: 800 }}>
        <div className="relative">
          {/* glow */}
          <div
            className="absolute inset-0"
            style={{
              margin: -44,
              background:
                "radial-gradient(ellipse 70% 62% at 50% 46%, rgba(124,58,237,0.42) 0%, rgba(124,58,237,0.1) 46%, transparent 78%)",
              filter: "blur(18px)",
            }}
          />

          {/* desktop — base */}
          <div
            className={`relative ${frame}`}
            style={{ borderRadius: 13, filter: "drop-shadow(0 30px 58px rgba(0,0,0,0.62))" }}
          >
            <img
              src="/images/hero/hero-desktop.webp"
              alt=""
              style={{ display: "block", width: "100%", height: "auto" }}
            />
          </div>

          {/* TUI — bottom-left, larger */}
          <div
            className={`absolute ${frame}`}
            style={{
              bottom: "17%",
              left: "-15%",
              width: "55%",
              borderRadius: 9,
              transform: "rotate(-2deg)",
              transformOrigin: "bottom left",
              filter: "drop-shadow(0 22px 40px rgba(0,0,0,0.66))",
            }}
          >
            <img
              src="/images/hero/hero-tui.webp"
              alt=""
              style={{ display: "block", width: "100%", height: "auto" }}
            />
          </div>

          {/* iPhone — bottom-right, larger */}
          <div
            className="absolute"
            style={{
              bottom: "7%",
              right: "-7%",
              width: "20%",
              transform: "rotate(3deg)",
              transformOrigin: "bottom right",
              filter: "drop-shadow(0 24px 44px rgba(124,58,237,0.45))",
            }}
          >
            <div
              className="relative overflow-hidden"
              style={{
                aspectRatio: "9 / 19.5",
                borderRadius: 26,
                border: "6px solid #0c0c12",
                background: "#000",
                boxShadow: "0 0 0 1px rgba(255,255,255,0.09)",
              }}
            >
              <div
                className="absolute left-1/2 -translate-x-1/2"
                style={{ top: 6, width: "40%", height: 11, borderRadius: 999, background: "#000", zIndex: 2 }}
              />
              <img
                src="/images/hero/hero-mobile.webp"
                alt=""
                style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* hand-drawn arrows */}
      <svg
        className="absolute inset-0"
        viewBox="0 0 1200 630"
        fill="none"
        style={{ pointerEvents: "none" }}
      >
        <defs>
          <marker id="ah" markerWidth="13" markerHeight="13" refX="7" refY="6" orient="auto">
            <path d="M1 1 L11 6 L1 11" stroke="#efe6d0" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        {/* Desktop — top-left label curves to the desktop's top-left corner */}
        <path
          d="M150 232 C 182 244, 198 250, 214 258"
          stroke="#efe6d0"
          strokeWidth="2.2"
          strokeLinecap="round"
          markerEnd="url(#ah)"
        />
        {/* TUI — label curves down to the TUI's top-left corner */}
        <path
          d="M78 320 C 90 336, 94 346, 100 356"
          stroke="#efe6d0"
          strokeWidth="2.2"
          strokeLinecap="round"
          markerEnd="url(#ah)"
        />
        {/* Mobile — top-right label curves down to the top of the phone */}
        <path
          d="M1066 232 C 1030 254, 1006 270, 982 288"
          stroke="#efe6d0"
          strokeWidth="2.2"
          strokeLinecap="round"
          markerEnd="url(#ah)"
        />
      </svg>

      {/* hand-written labels */}
      <span className="absolute" style={{ ...hand, left: 52, top: 196, fontSize: 33, transform: "rotate(-7deg)" }}>
        Desktop app
      </span>
      <span className="absolute" style={{ ...hand, left: 30, top: 284, fontSize: 33, transform: "rotate(-5deg)" }}>
        TUI
      </span>
      <span className="absolute" style={{ ...hand, right: 44, top: 192, fontSize: 33, transform: "rotate(6deg)" }}>
        Mobile app
      </span>
    </div>
  );
}
