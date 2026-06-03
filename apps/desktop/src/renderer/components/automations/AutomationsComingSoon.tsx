import { useNavigate } from "react-router-dom";
import { ArrowRight, GitBranch, Robot, Sparkle } from "@phosphor-icons/react";

const PREVIEW_ITEMS = [
  {
    icon: GitBranch,
    title: "Linear and GitHub triggers",
    body: "External-event automations need a production-ready delivery path before they ship.",
  },
  {
    icon: Robot,
    title: "Short agent workflows",
    body: "The goal is a compact flow: trigger, prompt, action, and result without heavy setup.",
  },
  {
    icon: Sparkle,
    title: "Internal testing only",
    body: "Dev builds keep the prototype available while packaged builds stay honest.",
  },
] as const;

export function ProductionAutomationsComingSoon() {
  const navigate = useNavigate();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[#0D0F12] text-[#F6F8FA]">
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-8 px-6 py-12">
        <section className="flex max-w-2xl flex-col gap-4">
          <span className="inline-flex w-fit items-center gap-2 rounded-md border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[1px] text-cyan-100">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" aria-hidden />
            Coming soon
          </span>
          <div>
            <h1 className="text-[26px] font-semibold leading-tight text-[#F6F8FA]">
              Automations are paused in production.
            </h1>
            <p className="mt-3 max-w-[58ch] text-[13px] leading-6 text-[#9EA7B3]">
              The prototype is still available in dev builds, but packaged ADE
              will not expose automation triggers, webhook ingress, or agent
              automation commands until the delivery path is real.
            </p>
          </div>
        </section>

        <div className="grid gap-3 md:grid-cols-3">
          {PREVIEW_ITEMS.map(({ icon: Icon, title, body }) => (
            <article key={title} className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-4">
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md border border-cyan-300/25 bg-cyan-300/10 text-cyan-200">
                <Icon size={15} weight="duotone" />
              </div>
              <div className="text-[13px] font-semibold text-[#F6F8FA]">{title}</div>
              <p className="mt-1 text-[12px] leading-5 text-[#9EA7B3]">{body}</p>
            </article>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/lanes")}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-300 px-4 font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#081116] transition active:scale-[0.98]"
          >
            Open lanes
            <ArrowRight size={13} weight="bold" />
          </button>
          <span className="text-[11px] text-[#7D8794]">
            Use lanes, PRs, Linear sync, and proof flows while Automations bakes.
          </span>
        </div>
      </div>
    </div>
  );
}
