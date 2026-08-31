import React from "react";

import { COLORS, SANS_FONT, primaryButton } from "../lanes/laneDesignTokens";
import {
  SettingsNumber,
  SettingsSecret,
  SettingsSelect,
  SettingsText,
  SettingsToggle,
} from "../settings/primitives";
import { InlineError, type VocabRenderContext } from "./vocabularyPrimitives";
import type { VocabField, VocabFormNode } from "../../../shared/plugins/vocabulary";

type FormValues = Record<string, string | number | boolean>;

/**
 * The starting values a form opens with.
 *
 * Every field is seeded, including the ones the schema left blank, because a
 * controlled input that starts `undefined` and becomes a string is React's
 * uncontrolled-to-controlled warning and a lost first keystroke.
 */
export function initialFormValues(fields: VocabField[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    if (field.value !== undefined) values[field.id] = field.value;
    else if (field.kind === "toggle") values[field.id] = false;
    else if (field.kind === "number") values[field.id] = field.min ?? 0;
    else values[field.id] = "";
  }
  return values;
}

export function VocabForm({
  node,
  context,
}: {
  node: VocabFormNode;
  context: VocabRenderContext;
}) {
  const [values, setValues] = React.useState<FormValues>(() => initialFormValues(node.fields));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  // The committed values as of right now. A commit reads this rather than
  // `values`, because a blur that follows the keystroke in the same tick would
  // otherwise dispatch the state React has not applied yet.
  const valuesRef = React.useRef(values);

  const applyAction = node.applyOnChange ?? null;

  /**
   * Send the whole values map without a button press.
   *
   * Fire-and-forget, following `segmented`'s `onChange`: the reader's edit is
   * already on screen and holding the control until a round trip finishes would
   * make an apply-on-change form slower than the Apply button it replaces. A
   * failure lands in the same inline error the submit path uses.
   */
  const apply = (next: FormValues) => {
    if (!applyAction) return;
    if (applyAction.confirm && !window.confirm(applyAction.confirm)) return;
    setError(null);
    void context.dispatch(applyAction, next).then(
      () => setSaved(true),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : "That action failed."),
    );
  };

  /**
   * `commit` separates a value CHANGING from a value being FINISHED.
   *
   * A toggle and a select finish the moment they change. A text, secret or
   * number field does not — committing per keystroke would invoke the plugin
   * once per letter — so those commit on blur or Enter instead.
   */
  const setValue = (id: string, value: string | number | boolean, commit: boolean) => {
    setSaved(false);
    const next = { ...valuesRef.current, [id]: value };
    valuesRef.current = next;
    setValues(next);
    if (commit) apply(next);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const action = node.submit?.onPress;
    if (!action) return;
    if (action.confirm && !window.confirm(action.confirm)) return;
    setPending(true);
    setError(null);
    try {
      await context.dispatch(action, valuesRef.current);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That action failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 14, minWidth: 0 }}>
      {node.fields.map((field) => (
        <VocabFormField
          key={field.id}
          field={field}
          value={values[field.id]}
          onChange={(next, commit) => setValue(field.id, next, commit && applyAction !== null)}
          onCommit={applyAction ? () => apply(valuesRef.current) : null}
          disabled={pending}
        />
      ))}
      {/* A form that applies as it is edited has no button to draw, and drawing
          one would say the opposite of what it does. The status line stays: an
          apply that failed still owes the reader a sentence. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {node.submit ? (
          <button
            type="submit"
            disabled={pending}
            style={{ ...primaryButton(), opacity: pending ? 0.55 : 1, cursor: pending ? "default" : "pointer" }}
            data-tour={`plugin:${context.pluginId}.submit-${node.submit.onPress.action}`}
          >
            {pending ? "Saving…" : node.submit.label}
          </button>
        ) : null}
        {error ? <InlineError message={error} /> : null}
        {saved && !error ? (
          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.success }}>Saved</span>
        ) : null}
      </div>
    </form>
  );
}

function VocabFormField({
  field,
  value,
  onChange,
  onCommit,
  disabled,
}: {
  field: VocabField;
  value: string | number | boolean | undefined;
  /** `commit` is true when this kind of control finishes on the change itself. */
  onChange: (value: string | number | boolean, commit: boolean) => void;
  /**
   * A typed field finishing: blur, or Enter. Null when the form has no
   * `applyOnChange` — Enter must then keep its ordinary meaning of submitting
   * the form.
   */
  onCommit: (() => void) | null;
  disabled: boolean;
}) {
  const controlId = `plugin-field-${field.id}`;
  const commitsOnBlur = onCommit !== null && field.kind !== "toggle" && field.kind !== "select";
  const control = (() => {
    switch (field.kind) {
      case "toggle":
        return (
          <SettingsToggle
            id={controlId}
            label={field.label}
            checked={value === true}
            onChange={(next) => onChange(next, true)}
            disabled={disabled}
          />
        );
      case "select":
        return (
          <SettingsSelect
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "string" ? value : (field.options?.[0]?.value ?? "")}
            options={(field.options ?? []).map((option) => ({
              value: option.value,
              label: option.label ?? option.value,
            }))}
            onChange={(next) => onChange(next, true)}
            disabled={disabled}
          />
        );
      case "number":
        return (
          <SettingsNumber
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "number" ? value : 0}
            onChange={(next) => onChange(next, false)}
            {...(field.min !== undefined ? { min: field.min } : {})}
            {...(field.max !== undefined ? { max: field.max } : {})}
            {...(field.step !== undefined ? { step: field.step } : {})}
            disabled={disabled}
          />
        );
      case "secret":
        return (
          <SettingsSecret
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "string" ? value : ""}
            onChange={(next) => onChange(next, false)}
            disabled={disabled}
          />
        );
      default:
        return (
          <SettingsText
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "string" ? value : ""}
            onChange={(next) => onChange(next, false)}
            {...(field.placeholder ? { placeholder: field.placeholder } : {})}
            disabled={disabled}
          />
        );
    }
  })();

  return (
    <div
      style={{ display: "grid", gap: 6, minWidth: 0 }}
      // A typed field finishes on blur or Enter, never per keystroke. Handled on
      // the wrapper rather than on each control because these events bubble, so
      // one pair here covers text, secret and number without giving the shared
      // settings primitives a second onChange contract to keep.
      {...(commitsOnBlur
        ? {
          onBlur: onCommit,
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === "Enter") {
              // Otherwise Enter also submits the surrounding form, which for an
              // apply-on-change form means two invokes for one keypress.
              event.preventDefault();
              onCommit();
            }
          },
        }
        : {})}
    >
      <label
        htmlFor={controlId}
        style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 500, color: COLORS.textSecondary }}
      >
        {field.label}
      </label>
      {control}
      {field.help ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>{field.help}</span>
      ) : null}
    </div>
  );
}
