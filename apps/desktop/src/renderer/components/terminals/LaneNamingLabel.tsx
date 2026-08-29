import { cn } from "../ui/cn";

export function NamingPendingLabel({
  text,
  naming,
  pendingLabel,
}: {
  text: string;
  naming: boolean;
  pendingLabel: string;
}) {
  if (!naming) return <>{text}</>;

  return (
    <span className="inline-flex min-w-0 items-baseline" aria-label={`${pendingLabel}…`}>
      <span className={cn("truncate ade-naming-pending")}>{pendingLabel}</span>
      <span className="ade-lane-naming-dots shrink-0" aria-hidden>
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </span>
  );
}

export function LaneNamingLabel({
  laneName,
  naming,
}: {
  laneName: string;
  naming: boolean;
}) {
  return <NamingPendingLabel text={laneName} naming={naming} pendingLabel="Naming lane" />;
}
