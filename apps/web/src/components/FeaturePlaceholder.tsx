import { cn } from "../lib/cn";

export function FeaturePlaceholder({ colorClass }: { colorClass: string }) {
  const bgClass = colorClass.replace("text-", "bg-");
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[#0a0a0f]">
      <div
        className={cn(
          "absolute -right-10 -top-10 h-32 w-32 rounded-full opacity-20 blur-[40px]",
          bgClass,
        )}
      />
      <div
        className={cn(
          "absolute -bottom-10 -left-10 h-32 w-32 rounded-full opacity-10 blur-[40px]",
          bgClass,
        )}
      />

      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-white/5 bg-white/[0.02] px-3">
        <div className="h-1.5 w-1.5 rounded-full bg-white/20" />
        <div className="h-1.5 w-1.5 rounded-full bg-white/20" />
        <div className="h-1.5 w-1.5 rounded-full bg-white/20" />
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex w-full items-center gap-3">
          <div className="h-8 w-8 shrink-0 rounded-lg bg-white/5" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2 w-1/3 rounded-full bg-white/10" />
            <div className="h-2 w-1/4 rounded-full bg-white/5" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-2 rounded-lg border border-white/5 bg-white/[0.01] p-3">
          <div className="h-1.5 w-full rounded-full bg-white/5" />
          <div className="h-1.5 w-[90%] rounded-full bg-white/5" />
          <div className="h-1.5 w-[95%] rounded-full bg-white/5" />
          <div className="h-1.5 w-[80%] rounded-full bg-white/5" />
          <div
            className={cn(
              "mt-auto h-1.5 w-[40%] rounded-full opacity-40",
              bgClass,
            )}
          />
        </div>
      </div>
    </div>
  );
}
