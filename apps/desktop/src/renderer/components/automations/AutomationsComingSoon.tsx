import { useNavigate } from "react-router-dom";
import { ArrowRight } from "@phosphor-icons/react";

export function ProductionAutomationsComingSoon() {
  const navigate = useNavigate();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[#0D0F12] text-[#F6F8FA]">
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-8 px-6 py-12">
        <section className="flex max-w-2xl flex-col gap-4">
          <span className="inline-flex w-fit items-center gap-2 rounded-md border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[1px] text-cyan-100">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" aria-hidden />
            Disabled
          </span>
          <div>
            <h1 className="text-[26px] font-semibold leading-tight text-[#F6F8FA]">
              Automations are disabled on this build.
            </h1>
            <p className="mt-3 max-w-[58ch] text-[13px] leading-6 text-[#9EA7B3]">
              This runtime was started with ADE_DISABLE_AUTOMATIONS set, so
              automation rules, webhook ingress, and agent automation commands
              are switched off. Unset the flag and restart ADE to turn them
              back on.
            </p>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/lanes")}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-300 px-4 font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#081116] transition active:scale-[0.98]"
          >
            Open lanes
            <ArrowRight size={13} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}
