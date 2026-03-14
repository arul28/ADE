import { cn } from "../../ui/cn";

type StatusDotProps = {
  color: string;
  pulse?: boolean;
  size?: "sm" | "md" | "lg";
};

const sizeMap = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
  lg: "h-3 w-3",
} as const;

export function StatusDot({ color, pulse, size = "md" }: StatusDotProps) {
  return (
    <span className="relative inline-flex items-center justify-center">
      {pulse && (
        <span
          className={cn("absolute inline-flex rounded-full opacity-75 animate-ping", sizeMap[size])}
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className={cn("relative inline-block rounded-full", sizeMap[size])}
        style={{ backgroundColor: color }}
      />
    </span>
  );
}
