import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Info } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

export function EmptyStateHint({ className }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <div
      className={cn(
        "rounded-xl border border-white/[0.06] bg-black/10 px-4 py-5 text-center",
        className,
      )}
    >
      <div className="text-sm font-semibold text-[#F5FAFF]">No automations yet</div>
      <div className="mt-2 text-[12px] leading-relaxed text-[#93A4B8]">
        Click <span className="text-[#F5FAFF]">+ New</span> to build one, browse{" "}
        <span className="text-[#F5FAFF]">Templates</span>, or{" "}
        <button
          type="button"
          onClick={() => navigate("/cto")}
          className="underline-offset-2 text-[#7DD3FC] hover:underline"
        >
          ask the CTO →
        </button>{" "}
        to draft one for you.
      </div>
    </div>
  );
}

export function CtoInfoChip() {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Info size={14} weight="regular" className="text-[#8FA1B8] hover:text-[#F5FAFF]" />
      {hover ? (
        <div
          className="absolute right-0 top-6 z-20 w-[260px] rounded-lg border border-white/[0.08] bg-[#0B121A] px-3 py-2 text-[11px] leading-relaxed text-[#C8D3E0] shadow-lg"
          role="tooltip"
        >
          Tip: the CTO can build automations for you. Open the CTO tab and describe what you want.
        </div>
      ) : null}
    </div>
  );
}
