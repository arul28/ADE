import { type ReactNode, useId, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";

type Props = {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  testId?: string;
};

export function CockpitDrawer({ title, summary, defaultOpen, children, testId }: Props) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const contentId = useId();
  return (
    <div className="rounded-md border border-white/[0.08] bg-white/[0.02]" data-testid={testId}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-fg/85"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <CaretRight
          size={11}
          className={cn("shrink-0 text-muted-fg/65 transition-transform", open ? "rotate-90" : "rotate-0")}
        />
        <span>{title}</span>
        {summary ? (
          <span className="ml-auto truncate text-[11px] font-normal text-muted-fg/65">{summary}</span>
        ) : null}
      </button>
      {open ? <div id={contentId} className="border-t border-white/[0.05] px-3 py-3">{children}</div> : null}
    </div>
  );
}
