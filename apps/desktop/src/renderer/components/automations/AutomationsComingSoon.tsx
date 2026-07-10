import { useNavigate } from "react-router-dom";
import { ArrowRight } from "@phosphor-icons/react";
import { Button } from "../ui/Button";

export function ProductionAutomationsComingSoon() {
  const navigate = useNavigate();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg text-fg">
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-8 px-6 py-12">
        <section className="flex max-w-2xl flex-col gap-4">
          <span className="inline-flex w-fit items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-fg/70">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-fg/50" aria-hidden />
            Disabled
          </span>
          <div>
            <h1 className="text-[26px] font-semibold leading-tight text-fg">Automations are disabled on this build.</h1>
            <p className="mt-3 max-w-[58ch] text-[13px] leading-6 text-muted-fg/75">
              This runtime was started with ADE_DISABLE_AUTOMATIONS set, so automation rules, webhook ingress, and agent
              automation commands are switched off. Unset the flag and restart ADE to turn them back on.
            </p>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button size="md" variant="primary" onClick={() => navigate("/lanes")}>
            Open lanes
            <ArrowRight size={13} weight="bold" />
          </Button>
        </div>
      </div>
    </div>
  );
}
