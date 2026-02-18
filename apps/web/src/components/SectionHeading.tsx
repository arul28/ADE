import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Badge } from "./Badge";

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  align = "left",
  size = "lg"
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  align?: "left" | "center";
  size?: "lg" | "md";
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        align === "center" && "items-center text-center",
        align === "left" && "items-start text-left"
      )}
    >
      {eyebrow ? <Badge size="sm">{eyebrow}</Badge> : null}
      <div className={cn("flex w-full items-end justify-between gap-6", align === "center" && "justify-center")}>
        <div className={cn("max-w-2xl", align === "center" && "mx-auto")}>
          <h2
            className={cn(
              "text-balance font-semibold tracking-tight text-fg",
              size === "lg" ? "text-3xl sm:text-4xl" : "text-2xl sm:text-3xl"
            )}
          >
            {title}
          </h2>
          {description ? (
            <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-fg sm:text-base">{description}</p>
          ) : null}
        </div>
        {action ? <div className={cn("hidden sm:block", align === "center" && "hidden")}>{action}</div> : null}
      </div>
    </div>
  );
}

