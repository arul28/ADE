import React from "react";

import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import {
  SettingsNumber,
  SettingsSecret,
  SettingsSelect,
  SettingsText,
  SettingsToggle,
} from "../settings/primitives/SettingsControls";
import {
  invokePluginAction,
  readPluginConfig,
  writePluginConfig,
} from "../../lib/pluginRuntimeBridge";
import type { PluginManifestSetting } from "../../../shared/plugins/manifest";

/**
 * A plugin's settings, rendered from its manifest.
 *
 * Built on the same controls as ADE's own Settings, which carries their design
 * law with it: no draft state and no Save button. Every change persists on
 * change and flashes; a plugin form that behaved differently from the Settings
 * form two clicks away would be its own bug report.
 *
 * The values are optimistic and reverted on failure. A settings row that waits
 * on a round trip before moving reads as broken, and one that stays moved after
 * a rejection is worse — it claims something was saved that was not.
 *
 * `select` options may be static or produced by a plugin action. The action
 * form is fetched once per mount and degrades to the stored value alone, so a
 * plugin whose process is down shows the current setting instead of an empty
 * dropdown that would silently rewrite it on the next interaction.
 */

type Values = Record<string, unknown>;

/** What a setting can hold. `null` means "back to the manifest's default". */
type SettingValue = string | number | boolean | null;

export function PluginConfigForm({
  pluginId,
  settings,
}: {
  pluginId: string;
  settings: readonly PluginManifestSetting[];
}) {
  const [values, setValues] = React.useState<Values>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [savedKey, setSavedKey] = React.useState<string | null>(null);
  const [dynamicOptions, setDynamicOptions] = React.useState<Record<string, { value: string; label: string }[]>>({});

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await readPluginConfig(pluginId);
      if (cancelled) return;
      setValues(stored);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  React.useEffect(() => {
    let cancelled = false;
    const actions = settings
      .map((setting) => setting.optionsAction)
      .filter((action): action is string => Boolean(action));
    if (actions.length === 0) return;
    void (async () => {
      const results = await Promise.all(actions.map(async (action) => {
        try {
          const result = await invokePluginAction(pluginId, action);
          const options = Array.isArray(result)
            ? result.flatMap((entry) => {
              if (typeof entry === "string") return [{ value: entry, label: entry }];
              if (entry && typeof entry === "object" && "value" in entry) {
                const record = entry as { value: unknown; label?: unknown };
                const value = typeof record.value === "string" ? record.value : null;
                if (!value) return [];
                return [{ value, label: typeof record.label === "string" ? record.label : value }];
              }
              return [];
            })
            : [];
          return [action, options] as const;
        } catch {
          return [action, []] as const;
        }
      }));
      if (cancelled) return;
      setDynamicOptions(Object.fromEntries(results));
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId, settings]);

  const save = (key: string, value: SettingValue, previous: unknown) => {
    setValues((current) => ({ ...current, [key]: value }));
    setError(null);
    void writePluginConfig(pluginId, key, value)
      .then(() => {
        setSavedKey(key);
        window.setTimeout(() => setSavedKey((current) => (current === key ? null : current)), 1400);
      })
      .catch((cause: unknown) => {
        setValues((current) => ({ ...current, [key]: previous }));
        setError(cause instanceof Error ? cause.message : "That setting didn’t save.");
      });
  };

  if (loading) {
    return (
      <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textDim }}>Loading settings…</span>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }} data-tour="plugin:marketplace.config">
      {settings.map((setting) => (
        <div key={setting.key} style={{ display: "grid", gap: 5 }}>
          <label
            htmlFor={`plugin-setting-${setting.key}`}
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 8,
              fontFamily: SANS_FONT,
              fontSize: 11.5,
              color: COLORS.textSecondary,
            }}
          >
            {setting.label}
            {savedKey === setting.key ? (
              <span style={{ fontSize: 10.5, color: COLORS.success }}>Saved</span>
            ) : null}
          </label>
          <SettingControl
            setting={setting}
            value={values[setting.key]}
            options={setting.optionsAction ? dynamicOptions[setting.optionsAction] : undefined}
            onChange={(next) => save(setting.key, next, values[setting.key])}
          />
          {setting.description ? (
            <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim, lineHeight: 1.5 }}>
              {setting.description}
            </span>
          ) : null}
        </div>
      ))}
      {error ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.warning }}>{error}</span>
      ) : null}
    </div>
  );
}

function SettingControl({
  setting,
  value,
  options,
  onChange,
}: {
  setting: PluginManifestSetting;
  value: unknown;
  options: { value: string; label: string }[] | undefined;
  onChange: (value: SettingValue) => void;
}) {
  const id = `plugin-setting-${setting.key}`;
  switch (setting.kind) {
    case "toggle":
      return (
        <SettingsToggle
          id={id}
          label={setting.label}
          checked={typeof value === "boolean" ? value : setting.default === true}
          onChange={onChange}
        />
      );
    case "number":
      return (
        <SettingsNumber
          id={id}
          ariaLabel={setting.label}
          value={typeof value === "number" ? value : typeof setting.default === "number" ? setting.default : 0}
          onChange={onChange}
        />
      );
    case "secret":
      return (
        <SettingsSecret
          id={id}
          ariaLabel={setting.label}
          // Secrets are write-only: the host returns a marker, never the value.
          value={typeof value === "string" && value !== "__stored__" ? value : ""}
          hasStoredValue={value === "__stored__"}
          onChange={onChange}
          width="100%"
        />
      );
    case "select": {
      const list = options ?? setting.options ?? [];
      const current = typeof value === "string"
        ? value
        : typeof setting.default === "string" ? setting.default : (list[0]?.value ?? "");
      if (list.length === 0) {
        // No options to choose from is not an empty dropdown — it is a plugin
        // that cannot answer right now. Show the value rather than a control
        // whose only move would blank it.
        return (
          <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textDim }}>
            {current || "No options available"}
          </span>
        );
      }
      return (
        <SettingsSelect
          id={id}
          ariaLabel={setting.label}
          value={current}
          options={list}
          onChange={onChange}
        />
      );
    }
    case "text":
    default:
      return (
        <SettingsText
          id={id}
          ariaLabel={setting.label}
          value={typeof value === "string" ? value : typeof setting.default === "string" ? setting.default : ""}
          onChange={onChange}
          width="100%"
        />
      );
  }
}
