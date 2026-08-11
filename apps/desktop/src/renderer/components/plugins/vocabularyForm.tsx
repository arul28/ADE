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

  const setValue = (id: string, value: string | number | boolean) => {
    setSaved(false);
    setValues((previous) => ({ ...previous, [id]: value }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (node.submit.onPress.confirm && !window.confirm(node.submit.onPress.confirm)) return;
    setPending(true);
    setError(null);
    try {
      await context.dispatch(node.submit.onPress, values);
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
          onChange={(next) => setValue(field.id, next)}
          disabled={pending}
        />
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="submit"
          disabled={pending}
          style={{ ...primaryButton(), opacity: pending ? 0.55 : 1, cursor: pending ? "default" : "pointer" }}
          data-tour={`plugin:${context.pluginId}.submit-${node.submit.onPress.action}`}
        >
          {pending ? "Saving…" : node.submit.label}
        </button>
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
  disabled,
}: {
  field: VocabField;
  value: string | number | boolean | undefined;
  onChange: (value: string | number | boolean) => void;
  disabled: boolean;
}) {
  const controlId = `plugin-field-${field.id}`;
  const control = (() => {
    switch (field.kind) {
      case "toggle":
        return (
          <SettingsToggle
            id={controlId}
            label={field.label}
            checked={value === true}
            onChange={onChange}
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
            onChange={onChange}
            disabled={disabled}
          />
        );
      case "number":
        return (
          <SettingsNumber
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "number" ? value : 0}
            onChange={onChange}
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
            onChange={onChange}
            disabled={disabled}
          />
        );
      default:
        return (
          <SettingsText
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "string" ? value : ""}
            onChange={onChange}
            {...(field.placeholder ? { placeholder: field.placeholder } : {})}
            disabled={disabled}
          />
        );
    }
  })();

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
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
