import { ArrowClockwise } from "@phosphor-icons/react";
import { Banner } from "../ui/notice/Banner";

/**
 * The one place to update every machine that is behind. A row still has its
 * own Update button; this is the "all of them" action, shown only when there
 * is more than one.
 */
export function MachinesBehindBanner({
  count,
  targetVersion,
  busy,
  onUpdateAll,
}: {
  count: number;
  targetVersion: string | null;
  busy: boolean;
  onUpdateAll: () => void;
}) {
  return (
    <Banner
      testId="machines-behind-banner"
      model={{
        id: "machines-behind",
        tone: "accent",
        icon: <ArrowClockwise size={15} weight="bold" />,
        title: `${count} machines are behind`,
        detail: targetVersion
          ? `Update them to ${targetVersion}. You'll see what's running on each before anything restarts.`
          : "You'll see what's running on each before anything restarts.",
        busy,
        actions: busy ? [] : [{ label: "Update all", onClick: onUpdateAll, variant: "solid" }],
      }}
    />
  );
}
