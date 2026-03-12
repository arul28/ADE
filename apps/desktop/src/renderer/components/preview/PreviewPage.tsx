import React from "react";
import { Sparkle, Robot, Users, Eye, Lightning, Code, Star, ArrowRight } from "@phosphor-icons/react";

const features = [
  {
    icon: Robot,
    title: "AI Code Review",
    description: "Instant, context-aware reviews powered by multi-model intelligence. Catch bugs before they ship.",
    color: "#A78BFA",
  },
  {
    icon: Lightning,
    title: "Smart Refactor",
    description: "One-click refactoring that understands your entire codebase. Rename, extract, restructure safely.",
    color: "#60A5FA",
  },
  {
    icon: Users,
    title: "Team Collaboration",
    description: "Real-time multiplayer editing with AI-assisted conflict resolution and shared context.",
    color: "#34D399",
  },
  {
    icon: Eye,
    title: "Live Preview",
    description: "See your changes render instantly as you type. Zero rebuild time, full hot-reload intelligence.",
    color: "#F472B6",
  },
];

export function PreviewPage() {
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg">
      <style>{`
        @keyframes gradient-shift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes orb-float-1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(30px, -40px) scale(1.05); }
          66% { transform: translate(-20px, 20px) scale(0.95); }
        }
        @keyframes orb-float-2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(-40px, 30px) scale(1.08); }
          66% { transform: translate(25px, -15px) scale(0.92); }
        }
        @keyframes orb-float-3 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(20px, 35px) scale(1.03); }
        }
        @keyframes shimmer {
          0% { opacity: 0.4; }
          50% { opacity: 0.8; }
          100% { opacity: 0.4; }
        }
        @keyframes badge-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(167, 139, 250, 0.4); }
          50% { box-shadow: 0 0 0 8px rgba(167, 139, 250, 0); }
        }
        @keyframes card-fadein {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .preview-gradient-bg {
          background: linear-gradient(-45deg, #09080C, #1a0a2e, #0d1547, #150d2a, #09080C);
          background-size: 400% 400%;
          animation: gradient-shift 12s ease infinite;
        }
        .orb-1 {
          animation: orb-float-1 18s ease-in-out infinite;
        }
        .orb-2 {
          animation: orb-float-2 22s ease-in-out infinite;
        }
        .orb-3 {
          animation: orb-float-3 16s ease-in-out infinite;
        }
        .shimmer-text {
          animation: shimmer 3s ease-in-out infinite;
        }
        .badge-pulse {
          animation: badge-pulse 2.5s ease-in-out infinite;
        }
        .feature-card {
          animation: card-fadein 0.5s ease forwards;
          opacity: 0;
        }
        .feature-card:nth-child(1) { animation-delay: 0.1s; }
        .feature-card:nth-child(2) { animation-delay: 0.2s; }
        .feature-card:nth-child(3) { animation-delay: 0.3s; }
        .feature-card:nth-child(4) { animation-delay: 0.4s; }
        .glass-card {
          background: rgba(24, 20, 35, 0.6);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(167, 139, 250, 0.12);
          transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
        }
        .glass-card:hover {
          background: rgba(24, 20, 35, 0.75);
          border-color: rgba(167, 139, 250, 0.28);
          transform: translateY(-2px);
        }
      `}</style>

      {/* Animated gradient background */}
      <div className="preview-gradient-bg absolute inset-0" />

      {/* Floating orbs */}
      <div className="orb-1 absolute left-[10%] top-[15%] h-72 w-72 rounded-full opacity-20"
        style={{ background: "radial-gradient(circle, #A78BFA 0%, #7C3AED 50%, transparent 70%)", filter: "blur(40px)" }} />
      <div className="orb-2 absolute bottom-[20%] right-[8%] h-96 w-96 rounded-full opacity-15"
        style={{ background: "radial-gradient(circle, #60A5FA 0%, #3B82F6 50%, transparent 70%)", filter: "blur(50px)" }} />
      <div className="orb-3 absolute bottom-[40%] left-[40%] h-48 w-48 rounded-full opacity-10"
        style={{ background: "radial-gradient(circle, #F472B6 0%, #EC4899 50%, transparent 70%)", filter: "blur(35px)" }} />

      {/* Content */}
      <div className="relative z-10 flex h-full flex-col items-center justify-center gap-12 px-8 py-12">

        {/* Header section */}
        <div className="flex flex-col items-center gap-5 text-center">
          {/* Badge */}
          <div className="badge-pulse inline-flex items-center gap-2 rounded-full px-4 py-1.5"
            style={{ background: "rgba(167, 139, 250, 0.15)", border: "1px solid rgba(167, 139, 250, 0.3)" }}>
            <Sparkle size={14} weight="fill" style={{ color: "#A78BFA" }} />
            <span className="text-xs font-semibold tracking-widest uppercase" style={{ color: "#A78BFA" }}>
              Coming Soon
            </span>
          </div>

          {/* Main headline */}
          <div>
            <h1 className="text-5xl font-bold tracking-tight text-fg" style={{ letterSpacing: "-0.02em" }}>
              What's Next
            </h1>
            <div className="shimmer-text mt-1 text-5xl font-bold tracking-tight"
              style={{ letterSpacing: "-0.02em", background: "linear-gradient(135deg, #A78BFA, #60A5FA, #F472B6)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
              in ADE
            </div>
          </div>

          <p className="max-w-md text-sm leading-relaxed" style={{ color: "var(--color-muted-fg)" }}>
            We're building the future of AI-native development. Here's a sneak peek at what's coming your way.
          </p>
        </div>

        {/* Feature cards grid */}
        <div className="grid w-full max-w-2xl grid-cols-2 gap-4">
          {features.map((feature) => (
            <div key={feature.title} className="glass-card feature-card flex flex-col gap-3 rounded-xl p-5">
              {/* Icon */}
              <div className="flex h-10 w-10 items-center justify-center rounded-lg"
                style={{ background: `${feature.color}18`, border: `1px solid ${feature.color}30` }}>
                <feature.icon size={20} weight="duotone" style={{ color: feature.color }} />
              </div>

              {/* Text */}
              <div className="flex flex-col gap-1">
                <div className="text-sm font-semibold text-fg">{feature.title}</div>
                <div className="text-xs leading-relaxed" style={{ color: "var(--color-muted-fg)" }}>
                  {feature.description}
                </div>
              </div>

              {/* Coming soon tag */}
              <div className="mt-auto flex items-center gap-1.5" style={{ color: feature.color, opacity: 0.7 }}>
                <Star size={11} weight="fill" />
                <span className="text-xs font-medium tracking-wide uppercase">Coming Soon</span>
              </div>
            </div>
          ))}
        </div>

        {/* Footer CTA */}
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-muted-fg)" }}>
            <Code size={13} />
            <span>Built with passion by the ADE team</span>
            <ArrowRight size={12} />
            <span style={{ color: "#A78BFA" }}>stay tuned</span>
          </div>
        </div>
      </div>
    </div>
  );
}
