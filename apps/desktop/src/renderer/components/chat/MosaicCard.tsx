import React, { useCallback, useMemo, useState } from "react";
import { Check } from "@phosphor-icons/react";

import { cn } from "../ui/cn";
import { useChatChromeTint } from "./chatAppearance";
import { HighlightedCode } from "./CodeHighlighter";
import {
  MOSAIC_FENCE_LANGUAGE,
  parseMosaicCard,
  serializeMosaicSubmission,
  type MosaicCardSpec,
  type MosaicValues,
} from "../../../shared/chatMosaic";

/**
 * Session-lifetime record of submitted card values, keyed by cardKey. The
 * transcript list is virtualized, so a card unmounts on scroll; this map lets a
 * re-mounted card restore its "Answered" state without re-sending. Not persisted
 * across app restarts — that's intentional.
 */
const submittedValuesByCardKey = new Map<string, MosaicValues>();

function initialValues(spec: MosaicCardSpec): MosaicValues {
  const values: MosaicValues = {};
  for (const element of spec.elements) {
    switch (element.type) {
      case "select":
        if (element.value !== undefined) values[element.id] = element.value;
        break;
      case "multiselect":
        values[element.id] = element.values ?? [];
        break;
      case "number":
        values[element.id] = element.value ?? element.min ?? 0;
        break;
      case "input":
        values[element.id] = element.value ?? "";
        break;
      // approval has no pre-selected default.
      default:
        break;
    }
  }
  return values;
}

export const MosaicCard = React.memo(function MosaicCard({
  source,
  cardKey,
  onSubmit,
  disabled = false,
}: {
  source: string;
  cardKey: string;
  onSubmit?: (submission: { text: string; displayText: string }) => void | Promise<void>;
  disabled?: boolean;
}) {
  const chromeTint = useChatChromeTint();
  const neu = chromeTint === "neutral";
  const spec = useMemo(() => parseMosaicCard(source), [source]);

  const [values, setValues] = useState<MosaicValues>(() => {
    const persisted = submittedValuesByCardKey.get(cardKey);
    if (persisted) return persisted;
    return spec ? initialValues(spec) : {};
  });
  const [submitted, setSubmitted] = useState<boolean>(() => submittedValuesByCardKey.has(cardKey));
  const [busy, setBusy] = useState(false);

  const setValue = useCallback((id: string, value: string | string[] | number) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  const toggleMultiselect = useCallback((id: string, optionValue: string) => {
    setValues((prev) => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      const next = current.includes(optionValue)
        ? current.filter((v) => v !== optionValue)
        : [...current, optionValue];
      return { ...prev, [id]: next };
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!spec || submitted || busy) return;
    setBusy(true);
    const submission = serializeMosaicSubmission(spec, values);
    submittedValuesByCardKey.set(cardKey, values);
    try {
      await onSubmit?.(submission);
      setSubmitted(true);
    } catch {
      // Sending failed — drop the latch so the user can retry.
      submittedValuesByCardKey.delete(cardKey);
    } finally {
      setBusy(false);
    }
  }, [spec, submitted, busy, values, cardKey, onSubmit]);

  // Parse failure → render exactly what the transcript renders today.
  if (!spec) {
    return <HighlightedCode code={source} language={MOSAIC_FENCE_LANGUAGE} />;
  }

  const controlsDisabled = disabled || submitted || busy;

  const accentBorder = neu
    ? "border-white/14"
    : "border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)]";
  const accentBorderStrong = neu
    ? "border-white/32"
    : "border-[color:color-mix(in_srgb,var(--chat-accent)_55%,transparent)]";
  const accentBg = neu
    ? "bg-white/[0.1]"
    : "bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)]";
  const accentBgHover = neu
    ? "hover:border-white/22 hover:bg-white/[0.06]"
    : "hover:border-[color:color-mix(in_srgb,var(--chat-accent)_35%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_8%,transparent)]";
  const accentText = neu
    ? "text-white/88"
    : "text-[color:color-mix(in_srgb,var(--chat-accent)_82%,white_18%)]";
  const labelText = neu ? "text-white/62" : "text-fg/58";
  const mutedText = neu ? "text-white/45" : "text-fg/45";
  const bodyText = neu ? "text-white/85" : "text-fg/85";
  const indicatorActive = neu
    ? "border-white/70 bg-white/85 text-black"
    : "border-[color:color-mix(in_srgb,var(--chat-accent)_80%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_85%,transparent)] text-black";
  const indicatorIdle = neu
    ? "border-white/30 bg-transparent text-transparent"
    : "border-[color:color-mix(in_srgb,var(--chat-accent)_35%,transparent)] bg-transparent text-transparent";
  const fieldClass = cn(
    "w-full rounded-[max(0px,calc(var(--chat-radius-card)-8px))] border bg-black/20 px-3 py-2 text-[length:calc(var(--chat-font-size)*12.5/14)] outline-none transition-colors disabled:pointer-events-none disabled:opacity-50",
    "border-[color:var(--chat-block-border)]",
    neu
      ? "text-white/90 placeholder:text-white/35 focus:border-white/25"
      : "text-fg/90 placeholder:text-fg/35 focus:border-[color:color-mix(in_srgb,var(--chat-accent)_45%,transparent)]",
  );
  const optionRowClass = (active: boolean) =>
    cn(
      "group flex w-full items-center gap-2.5 rounded-[max(0px,calc(var(--chat-radius-card)-6px))] border px-3 py-2 text-left transition-colors disabled:pointer-events-none disabled:opacity-50",
      active ? cn(accentBorderStrong, accentBg) : cn(accentBorder, accentBgHover),
    );

  const renderLabel = (label: string | undefined) =>
    label ? (
      <div className={cn("mb-1.5 text-[length:calc(var(--chat-font-size)*11.5/14)] font-medium", labelText)}>
        {label}
      </div>
    ) : null;

  return (
    <div
      className={cn(
        "my-3 rounded-[max(0px,calc(var(--chat-radius-card)-4px))] border bg-[var(--chat-block-bg)] p-4",
        "border-[color:var(--chat-block-border)]",
      )}
    >
      {spec.title ? (
        <div className={cn("mb-3 font-mono text-[10px] font-bold uppercase tracking-widest", mutedText)}>
          {spec.title}
        </div>
      ) : null}

      <div className="flex flex-col gap-3.5">
        {spec.elements.map((element, index) => {
          switch (element.type) {
            case "text":
              return (
                <p
                  key={index}
                  className={cn("text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.6]", bodyText)}
                >
                  {element.text}
                </p>
              );

            case "table":
              return (
                <div
                  key={index}
                  className="overflow-hidden rounded-[max(0px,calc(var(--chat-radius-card)-8px))] border border-[color:var(--chat-block-border)]"
                >
                  {element.rows.map((row, rowIndex) => (
                    <div
                      key={rowIndex}
                      className="flex items-start gap-3 border-b border-[color:var(--chat-block-border)] px-3 py-1.5 last:border-b-0"
                    >
                      <span
                        className={cn(
                          "w-[34%] flex-none font-mono text-[length:calc(var(--chat-font-size)*11/14)] uppercase tracking-wide",
                          mutedText,
                        )}
                      >
                        {row.key}
                      </span>
                      <span className={cn("min-w-0 flex-1 text-[length:calc(var(--chat-font-size)*12.5/14)]", bodyText)}>
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
              );

            case "select": {
              const current = values[element.id];
              return (
                <div key={index}>
                  {renderLabel(element.label)}
                  <div role="radiogroup" aria-label={element.label ?? element.id} className="flex flex-col gap-1.5">
                    {element.options.map((option) => {
                      const active = current === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={controlsDisabled}
                          className={optionRowClass(active)}
                          onClick={() => setValue(element.id, option.value)}
                        >
                          <span
                            className={cn(
                              "inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border transition-colors",
                              active ? indicatorActive : indicatorIdle,
                            )}
                          >
                            {active ? <span className="block h-1.5 w-1.5 rounded-full bg-black" /> : null}
                          </span>
                          <span
                            className={cn(
                              "flex-1 text-[length:calc(var(--chat-font-size)*12.5/14)] font-medium",
                              neu ? "text-white/90" : "text-fg/90",
                            )}
                          >
                            {option.label ?? option.value}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }

            case "multiselect": {
              const current = Array.isArray(values[element.id]) ? (values[element.id] as string[]) : [];
              return (
                <div key={index}>
                  {renderLabel(element.label)}
                  <div role="group" aria-label={element.label ?? element.id} className="flex flex-col gap-1.5">
                    {element.options.map((option) => {
                      const active = current.includes(option.value);
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="checkbox"
                          aria-checked={active}
                          disabled={controlsDisabled}
                          className={optionRowClass(active)}
                          onClick={() => toggleMultiselect(element.id, option.value)}
                        >
                          <span
                            className={cn(
                              "inline-flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border transition-colors",
                              active ? indicatorActive : indicatorIdle,
                            )}
                          >
                            {active ? <Check size={10} weight="bold" /> : null}
                          </span>
                          <span
                            className={cn(
                              "flex-1 text-[length:calc(var(--chat-font-size)*12.5/14)] font-medium",
                              neu ? "text-white/90" : "text-fg/90",
                            )}
                          >
                            {option.label ?? option.value}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }

            case "number": {
              const raw = values[element.id];
              const current = typeof raw === "number" ? raw : (element.min ?? 0);
              const isSlider = element.min !== undefined && element.max !== undefined;
              return (
                <div key={index}>
                  {renderLabel(element.label)}
                  {isSlider ? (
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={element.min}
                        max={element.max}
                        step={element.step ?? 1}
                        value={current}
                        disabled={controlsDisabled}
                        onChange={(e) => setValue(element.id, Number(e.target.value))}
                        className="min-w-0 flex-1 disabled:opacity-50"
                        style={{ accentColor: neu ? "#ffffff" : "var(--chat-accent)" }}
                      />
                      <span
                        className={cn(
                          "w-12 flex-none text-right font-mono text-[length:calc(var(--chat-font-size)*12/14)] tabular-nums",
                          bodyText,
                        )}
                      >
                        {current}
                      </span>
                    </div>
                  ) : (
                    <input
                      type="number"
                      min={element.min}
                      max={element.max}
                      step={element.step ?? 1}
                      value={current}
                      disabled={controlsDisabled}
                      onChange={(e) => setValue(element.id, Number(e.target.value))}
                      className={cn(fieldClass, "font-mono tabular-nums")}
                    />
                  )}
                </div>
              );
            }

            case "input": {
              const current = typeof values[element.id] === "string" ? (values[element.id] as string) : "";
              return (
                <div key={index}>
                  {renderLabel(element.label)}
                  <input
                    type="text"
                    value={current}
                    placeholder={element.placeholder}
                    maxLength={element.maxLength}
                    disabled={controlsDisabled}
                    onChange={(e) => setValue(element.id, e.target.value)}
                    className={fieldClass}
                  />
                </div>
              );
            }

            case "approval": {
              const current = values[element.id];
              const approveActive = current === "approve";
              const denyActive = current === "deny";
              return (
                <div key={index}>
                  {renderLabel(element.label)}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      className={cn(
                        "inline-flex flex-1 items-center justify-center rounded-[max(0px,calc(var(--chat-radius-card)-6px))] border px-3 py-2 text-[length:calc(var(--chat-font-size)*12.5/14)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                        approveActive ? cn(accentBorderStrong, accentBg, accentText) : cn(accentBorder, accentText, accentBgHover),
                      )}
                      onClick={() => setValue(element.id, "approve")}
                    >
                      {element.approveLabel ?? "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      className={cn(
                        "inline-flex flex-1 items-center justify-center rounded-[max(0px,calc(var(--chat-radius-card)-6px))] border px-3 py-2 text-[length:calc(var(--chat-font-size)*12.5/14)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                        "border-[color:var(--chat-block-border)]",
                        denyActive
                          ? neu
                            ? "bg-white/[0.08] text-white/85"
                            : "bg-white/[0.05] text-fg/85"
                          : cn(mutedText, "hover:bg-black/20"),
                      )}
                      onClick={() => setValue(element.id, "deny")}
                    >
                      {element.denyLabel ?? "Deny"}
                    </button>
                  </div>
                </div>
              );
            }

            default:
              return null;
          }
        })}
      </div>

      <div className="mt-4 flex items-center">
        {submitted ? (
          <span className={cn("inline-flex items-center gap-1.5 text-[length:calc(var(--chat-font-size)*11.5/14)] font-medium", mutedText)}>
            <Check size={12} weight="bold" /> Answered
          </span>
        ) : (
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => void handleSubmit()}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[var(--chat-radius-pill)] border px-3.5 py-1.5 text-[length:calc(var(--chat-font-size)*12/14)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
              accentBorderStrong,
              accentBg,
              accentText,
              neu
                ? "hover:bg-white/[0.16]"
                : "hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)]",
            )}
          >
            {spec.submitLabel ?? "Submit"}
          </button>
        )}
      </div>
    </div>
  );
});
