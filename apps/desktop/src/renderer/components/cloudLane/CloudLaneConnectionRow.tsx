import { useMemo, useState, type ReactNode } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { cloudCatalogOf, type CloudAccountState } from "../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { cloudTierOfMachine, cloudTierRateLabel, cloudTiers } from "../../../shared/cloudTiers";
import { formatAgo } from "../../lib/format";
import { adeCloudLaneLabel } from "../../state/adeCloudLaneIndex";
import { CloudMark, CloudSizeIcon } from "../remoteTargets/cloudBrand";
import { cloudLaneJobFor, useCloudLaneJobs } from "./cloudLaneStores";
import { cloudLaneLifeAvailable } from "./cloudLaneActions";
import "./cloudLane.css";

const STATE_TEXT: Record<CloudLaneMachine["state"], string> = {
  running: "Awake",
  asleep: "Asleep",
  stopped: "Asleep",
  starting: "Waking",
  stopping: "Going to sleep",
  deleting: "Deleting",
  error: "Needs a look",
};

/**
 * Connections › ADE Cloud: one small row per lane's computer. It names the
 * lane ("Cloud · fix-login"), its size, whether it is awake and when it
 * last ran; ADE connects to it by itself when the lane is used. "Details"
 * opens the machine's full row (connect, actions) for the rare case someone
 * needs it.
 */
export function CloudLaneConnectionRow({
  box,
  account,
  details,
}: {
  box: CloudLaneMachine;
  account: CloudAccountState | null;
  /** The machine's full row, shown under "Details". */
  details: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const tiers = useMemo(() => cloudTiers(cloudCatalogOf(account)), [account]);
  const tier = cloudTierOfMachine(box, tiers);
  const jobs = useCloudLaneJobs(cloudLaneLifeAvailable());
  const job = cloudLaneJobFor(jobs, { instanceId: box.instanceId, laneId: box.lane?.laneId ?? null });
  const changing = job != null && (job.phase === "waiting" || job.phase === "running");
  const laneName = box.lane?.laneName ?? box.name ?? box.instanceId;
  const awake = box.state === "running";
  const ran = awake ? "Running now" : box.lastActiveAtMs != null ? `Ran ${formatAgo(box.lastActiveAtMs, Date.now())}` : null;
  const sub = [tier ? `${tier.label}, ${cloudTierRateLabel(tier)}` : null, ran].filter(Boolean).join(". ");
  return (
    <div className="adecl-cx-row" data-cloud-lane-computer={box.instanceId}>
      <div className="adecl-cx-main">
        {tier ? <CloudSizeIcon tier={tier.id} size={18} /> : <CloudMark size={16} brand />}
        <div className="adecl-cx-name">
          <b title={adeCloudLaneLabel(laneName)}>{adeCloudLaneLabel(laneName)}</b>
          {sub ? <span>{sub}</span> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="adecl-cx-state" data-awake={awake ? "true" : "false"}>
            <i aria-hidden />
            {changing ? "Changing size" : STATE_TEXT[box.state]}
          </span>
          <button
            type="button"
            className="kit-btn kit-btn-ghost"
            data-size="xs"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} details for ${laneName}'s computer`}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <CaretDown size={11} /> : <CaretRight size={11} />}
            <span className="adecl-cx-details-label">Details</span>
          </button>
        </div>
      </div>
      {open ? <div className="adecl-cx-more">{details}</div> : null}
    </div>
  );
}
