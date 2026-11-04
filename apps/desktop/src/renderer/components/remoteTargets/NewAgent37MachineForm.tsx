import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, Check, CircleNotch, Minus } from "@phosphor-icons/react";
import {
  AGENT37_KINDS,
  AGENT37_SHAPES,
  agent37ChoiceBlocker,
  agent37HourlyUsd,
  describeAgent37TemplateStatus,
  agent37Shape,
  formatAgent37HourlyPrice,
  type Agent37CreateMachineResult,
  type Agent37CreateProgress,
  type Agent37MachineKind,
  type Agent37ShapeId,
  type Agent37Status,
} from "../../../shared/agent37";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { Banner } from "../ui/notice";
import { captureError } from "../../../shared/sentry/capture";
import { Agent37Mark, AGENT37_NAME } from "./agent37Brand";
import { agent37RetryLabel, useAgent37Template } from "./useAgent37Template";

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `a37-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * "New Agent37 machine" in Add a computer: pick a box or a VM and a size, see
 * plainly what it can and cannot do and what an hour costs, and make it. The
 * box signs in to this account on its own; the caller connects to it when
 * `onCreated` hands back its machine key.
 *
 * Account-level: the box is made on the account's Agent37 workspace and joins
 * the ADE account, so nothing here takes a pin.
 */
export function NewAgent37MachineForm({
  status,
  onCreated,
}: {
  status: Agent37Status;
  onCreated: (result: Agent37CreateMachineResult) => void;
}) {
  const [kind, setKind] = useState<Agent37MachineKind>("box");
  const [shapeId, setShapeId] = useState<Agent37ShapeId>("2x4");
  const [name, setName] = useState(`${AGENT37_NAME} box`);
  const [progress, setProgress] = useState<Agent37CreateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<string | null>(null);
  /** The person pressed Cancel: the failure that follows is their choice, not an error. */
  const cancelledRef = useRef(false);
  const runningRef = useRef(false);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const template = useAgent37Template(true);

  const running = progress != null && progress.stage !== "done" && progress.stage !== "failed";
  runningRef.current = running;
  const shape = agent37Shape(shapeId) ?? AGENT37_SHAPES[0]!;
  const blocker = agent37ChoiceBlocker(status, kind, shape);
  // Create waits for a template it can make the box from; an older one that
  // is being updated still works.
  const templateReady = template.status?.usable === true;
  const templateNote = templateReady && template.status?.state !== "building"
    ? null
    : template.status && template.status.state !== "idle"
      ? describeAgent37TemplateStatus(template.status)
      : "Checking ADE's machine template…";

  // Closing the dialog mid-create cancels it, and main deletes the box it
  // made, so nothing is left billing. A box that already signed in is kept.
  useEffect(() => () => {
    const requestId = requestRef.current;
    if (requestId && runningRef.current) {
      // Main also cancels when this window goes away; a failure here is still worth knowing.
      void window.ade.agent37?.cancelCreate(requestId).catch((error: unknown) => {
        captureError(error, { fingerprint: ["agent37", "cancel_on_close"], handled: true });
      });
    }
  }, []);

  useEffect(() => {
    const bridge = window.ade.agent37;
    if (!bridge) return;
    return bridge.onCreateProgress((next) => {
      if (next.requestId !== requestRef.current) return;
      setProgress(next);
      if (next.stage === "failed") setError(next.error ?? next.message);
      if (next.stage === "done" && next.result) onCreatedRef.current(next.result);
    });
  }, []);

  const prices = useMemo(() => {
    const out: Record<string, string> = {};
    for (const spec of AGENT37_KINDS) {
      for (const candidate of AGENT37_SHAPES) {
        out[`${spec.kind}:${candidate.id}`] = formatAgent37HourlyPrice(agent37HourlyUsd(spec.kind, candidate));
      }
    }
    return out;
  }, []);

  const create = async () => {
    const bridge = window.ade.agent37;
    if (!bridge || running || blocker || !templateReady) return;
    const requestId = newRequestId();
    requestRef.current = requestId;
    cancelledRef.current = false;
    setError(null);
    setProgress({ requestId, stage: "creating", message: `Asking ${AGENT37_NAME} for the machine…` });
    try {
      const started = await bridge.createMachine(requestId, { kind, shape: shapeId, name });
      if (!started.started) {
        setProgress(null);
        setError("ADE couldn't start making the machine.");
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
    setProgress((current) => current ? { ...current, message: "Cancelling and deleting the box…" } : current);
    void window.ade.agent37?.cancelCreate(requestId).catch((cancelError: unknown) => {
      cancelledRef.current = false;
      setError(`ADE couldn't cancel: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`);
    });
  };

  return (
    <div className="ade-a37-form" style={{ display: "grid", gap: 12 }}>
      <div role="radiogroup" aria-label="Machine type" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {AGENT37_KINDS.map((spec) => {
          const selected = kind === spec.kind;
          return (
            <button
              key={spec.kind}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={running}
              className="ade-cx-way"
              data-selected={selected ? "true" : undefined}
              onClick={() => setKind(spec.kind)}
              style={{
                alignItems: "flex-start",
                textAlign: "left",
                outline: selected ? "2px solid var(--color-accent, #F25F29)" : undefined,
              }}
            >
              <span className="ade-cx-way-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Agent37Mark size={14} strokeWidth={selected ? 24 : 12.46} /> {spec.label}
                <span style={{ marginLeft: "auto", fontWeight: 400, opacity: 0.75 }}>
                  from {prices[`${spec.kind}:2x4`]}
                </span>
              </span>
              <span className="ade-cx-way-detail">{spec.summary}</span>
              <span style={{ display: "grid", gap: 2, marginTop: 6, fontSize: 11.5 }}>
                {spec.can.map((line) => (
                  <span key={line} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <Check size={11} weight="bold" color="var(--color-success, #3FB950)" /> {line}
                  </span>
                ))}
                {spec.cannot.map((line) => (
                  <span key={line} style={{ display: "flex", gap: 6, alignItems: "center", opacity: 0.75 }}>
                    <Minus size={11} weight="bold" /> {line}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <div role="radiogroup" aria-label="Size" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {AGENT37_SHAPES.map((candidate) => {
          const selected = shapeId === candidate.id;
          const unavailable = agent37ChoiceBlocker(status, kind, candidate) != null;
          return (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${candidate.cpu} CPUs, ${candidate.memoryGb} GB memory`}
              disabled={running}
              className="ade-cx-way"
              onClick={() => setShapeId(candidate.id)}
              style={{
                padding: "8px 6px",
                textAlign: "center",
                opacity: unavailable ? 0.55 : 1,
                outline: selected ? "2px solid var(--color-accent, #F25F29)" : undefined,
              }}
            >
              <span className="ade-cx-way-label">{candidate.cpu} CPU · {candidate.memoryGb} GB</span>
              <span className="ade-cx-way-detail">{prices[`${kind}:${candidate.id}`]}</span>
            </button>
          );
        })}
      </div>

      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
        <span>Name</span>
        <input
          value={name}
          maxLength={60}
          disabled={running}
          onChange={(event) => setName(event.target.value)}
          aria-label="Machine name"
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
        {shape.cpu} CPUs, {shape.memoryGb} GB memory, {shape.diskGb} GB disk. About {prices[`${kind}:${shape.id}`]} while it runs; asleep, only the disk bills.
        {status.balanceUsd != null ? ` Your ${AGENT37_NAME} wallet has $${status.balanceUsd.toFixed(2)}.` : ""}
      </div>

      {blocker ? (
        <Banner layout="inline" model={{ id: "agent37-blocker", tone: "warning", icon: <Agent37Mark size={16} />, title: blocker }} />
      ) : null}

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
            ? { id: "agent37-create-cancelled", tone: "info", icon: <Agent37Mark size={16} />, title: error }
            : {
                id: "agent37-create-failed",
                tone: "error",
                icon: <Agent37Mark size={16} />,
                title: "ADE couldn't make the machine",
                detail: error,
                report: { surface: "agent37_create_machine", code: "agent37_create_failed", technicalDetail: error },
              }}
        />
      ) : null}

      {template.loadError && !template.status && !running && progress?.stage !== "done" ? (
        <Banner
          layout="inline"
          model={{
            id: "agent37-template-unreadable",
            tone: "error",
            icon: <Agent37Mark size={16} />,
            title: "ADE couldn't check its machine template",
            detail: template.loadError,
            actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: template.retry }],
            report: { surface: "agent37_create_machine", code: "agent37_template_status_failed", technicalDetail: template.loadError },
          }}
        />
      ) : template.status?.state === "failed" && !running && progress?.stage !== "done" ? (
        <Banner
          layout="inline"
          model={{
            id: "agent37-template-failed",
            tone: "warning",
            icon: <Agent37Mark size={16} />,
            title: templateNote ?? describeAgent37TemplateStatus(template.status),
            detail: template.status.nextRetryAt ? agent37RetryLabel(template.status.nextRetryAt) : undefined,
            actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: template.retry }],
          }}
        />
      ) : templateNote && !running && progress?.stage !== "done" ? (
        <div role="status" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
          <CircleNotch size={14} className="animate-spin" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            {templateNote}
            {!templateReady ? " You can wait here; Make box turns on when it's ready." : ""}
          </span>
        </div>
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
          disabled={running || blocker != null || !templateReady || progress?.stage === "done"}
          onClick={() => void create()}
        >
          {running ? <CircleNotch size={13} className="animate-spin" /> : <Agent37Mark size={13} />}
          {running ? "Making the machine…" : `Make ${kind === "vm" ? "VM" : "box"}`}
        </button>
      </div>
    </div>
  );
}
