import { useEffect, useRef, useState } from "react";
import { Check, CircleNotch } from "@phosphor-icons/react";
import {
  CLOUD_FULL_COMPUTER_LABEL,
  CLOUD_SHAPES,
  cloudHoursRate,
  cloudShapeById,
  cloudShapeRunsAndroid,
  formatCloudHoursRate,
  type CloudCreateMachineResult,
  type CloudCreateProgress,
  type CloudMachineKind,
  type CloudShapeId,
} from "../../../shared/adeCloud";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { Banner } from "../ui/notice";
import { captureError } from "../../../shared/sentry/capture";
import { CloudMark, ADE_CLOUD_NAME } from "./cloudBrand";
import { SettingsToggle } from "../settings/primitives/SettingsControls";

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `cloud-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * "New cloud computer" in Add a computer: pick a size, and whether it is a
 * full computer (Android, Docker), see how fast it uses hours, and make it.
 * It signs in to this account on its own; the caller connects to it when
 * `onCreated` hands back its machine key.
 *
 * Account-level: the box is made on the account's ADE Cloud and joins
 * the ADE account, so nothing here takes a pin.
 */
export function NewCloudMachineForm({
  onCreated,
}: {
  onCreated: (result: CloudCreateMachineResult) => void;
}) {
  const [kind, setKind] = useState<CloudMachineKind>("box");
  const [shapeId, setShapeId] = useState<CloudShapeId>("2x4");
  const [name, setName] = useState(`${ADE_CLOUD_NAME} computer`);
  const [progress, setProgress] = useState<CloudCreateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<string | null>(null);
  /** The person pressed Cancel: the failure that follows is their choice, not an error. */
  const cancelledRef = useRef(false);
  const runningRef = useRef(false);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;

  const running = progress != null && progress.stage !== "done" && progress.stage !== "failed";
  runningRef.current = running;
  const shape = cloudShapeById(shapeId);
  // Closing the dialog mid-create cancels it, and main deletes the computer it
  // made, so nothing is left running. One that already signed in is kept.
  useEffect(() => () => {
    const requestId = requestRef.current;
    if (requestId && runningRef.current) {
      // Main also cancels when this window goes away; a failure here is still worth knowing.
      void window.ade.cloud?.cancelCreate(requestId).catch((error: unknown) => {
        captureError(error, { fingerprint: ["cloud", "cancel_on_close"], handled: true });
      });
    }
  }, []);

  useEffect(() => {
    const bridge = window.ade.cloud;
    if (!bridge) return;
    return bridge.onCreateProgress((next) => {
      if (next.requestId !== requestRef.current) return;
      setProgress(next);
      if (next.stage === "failed") setError(next.error ?? next.message);
      if (next.stage === "done" && next.result) onCreatedRef.current(next.result);
    });
  }, []);

  const create = async () => {
    const bridge = window.ade.cloud;
    if (!bridge || running) return;
    const requestId = newRequestId();
    requestRef.current = requestId;
    cancelledRef.current = false;
    setError(null);
    setProgress({ requestId, stage: "creating", message: `Asking ${ADE_CLOUD_NAME} for the computer…` });
    try {
      const started = await bridge.createMachine(requestId, { kind, shape: shapeId, name });
      if (!started.started) {
        setProgress(null);
        setError("ADE couldn't start making the computer.");
      }
    } catch (startError) {
      setProgress(null);
      setError(startError instanceof Error ? startError.message : String(startError));
    }
  };

  const cancel = () => {
    const requestId = requestRef.current;
    if (!requestId || !running) return;
    cancelledRef.current = true;
    setProgress((current) => current ? { ...current, message: "Cancelling and deleting the computer…" } : current);
    void window.ade.cloud?.cancelCreate(requestId).catch((cancelError: unknown) => {
      cancelledRef.current = false;
      setError(`ADE couldn't cancel: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`);
    });
  };

  return (
    <div className="ade-cloud-form" style={{ display: "grid", gap: 12 }}>
      <div role="radiogroup" aria-label="Size" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {CLOUD_SHAPES.map((candidate) => {
          const selected = shapeId === candidate.id;
          return (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${candidate.label}: ${candidate.cpu} CPUs, ${candidate.memoryGb} GB memory`}
              disabled={running}
              className="ade-cx-way"
              onClick={() => setShapeId(candidate.id)}
              style={{
                padding: "8px 6px",
                textAlign: "center",
                outline: selected ? "2px solid var(--color-accent, #F25F29)" : undefined,
              }}
            >
              <span className="ade-cx-way-label">{candidate.label}</span>
              <span className="ade-cx-way-detail">{candidate.cpu} CPU · {candidate.memoryGb} GB</span>
              <span className="ade-cx-way-detail">{formatCloudHoursRate(cloudHoursRate(kind, candidate.id))}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
        <span style={{ display: "grid", gap: 2 }}>
          <span>{CLOUD_FULL_COMPUTER_LABEL}</span>
          <span style={{ opacity: 0.7 }}>
            {kind === "vm" && !cloudShapeRunsAndroid(shapeId)
              ? "Docker works. Android needs Medium or bigger."
              : "Its own Linux kernel. Uses hours faster."}
          </span>
        </span>
        <SettingsToggle
          checked={kind === "vm"}
          disabled={running}
          label={CLOUD_FULL_COMPUTER_LABEL}
          onChange={(full) => setKind(full ? "vm" : "box")}
        />
      </div>

      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
        <span>Name</span>
        <input
          value={name}
          maxLength={60}
          disabled={running}
          onChange={(event) => setName(event.target.value)}
          aria-label="Computer name"
          style={{
            width: "100%",
            height: 34,
            borderRadius: 8,
            border: `1px solid ${COLORS.border}`,
            background: COLORS.cardBg,
            color: COLORS.textPrimary,
            fontFamily: SANS_FONT,
            fontSize: 12,
            padding: "0 10px",
            outline: "none",
          }}
        />
      </label>

      <div style={{ fontSize: 12, opacity: 0.8 }}>
        {shape.label}: {shape.cpu} CPUs, {shape.memoryGb} GB memory. Uses {formatCloudHoursRate(cloudHoursRate(kind, shape.id))} while it runs, none while it sleeps.
      </div>

      {progress && progress.stage !== "failed" ? (
        <div role="status" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
          {progress.stage === "done" && progress.result?.joined !== false
            ? <Check size={14} weight="bold" color="var(--color-success, #3FB950)" />
            : <CircleNotch size={14} className="animate-spin" />}
          {progress.message}
        </div>
      ) : null}

      {error ? (
        <Banner
          layout="inline"
          model={cancelledRef.current
            ? { id: "cloud-create-cancelled", tone: "info", icon: <CloudMark size={16} />, title: error }
            : {
                id: "cloud-create-failed",
                tone: "error",
                icon: <CloudMark size={16} />,
                title: "ADE couldn't make the computer",
                detail: error,
                report: { surface: "cloud_create_machine", code: "cloud_create_failed", technicalDetail: error },
              }}
        />
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {running ? (
          <button type="button" className="ade-modern-btn" data-variant="ghost" onClick={cancel}>
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          className="ade-cx-add-btn"
          data-size="lg"
          disabled={running || progress?.stage === "done"}
          onClick={() => void create()}
        >
          {running ? <CircleNotch size={13} className="animate-spin" /> : <CloudMark size={13} />}
          {running ? "Making the computer…" : "Make computer"}
        </button>
      </div>
    </div>
  );
}
