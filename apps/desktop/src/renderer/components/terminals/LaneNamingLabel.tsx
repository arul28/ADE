export function LaneNamingLabel({
  laneName,
  naming,
}: {
  laneName: string;
  naming: boolean;
}) {
  if (!naming) return <>{laneName}</>;

  return (
    <span className="inline-flex min-w-0 items-baseline" aria-label="Naming lane…">
      <span className="truncate">Naming lane</span>
      <span className="ade-lane-naming-dots shrink-0" aria-hidden>
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </span>
  );
}
