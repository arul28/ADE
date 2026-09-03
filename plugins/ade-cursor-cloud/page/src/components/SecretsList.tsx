/**
 * Secret checkboxes for the launch form.
 *
 * `CursorCloudSecretsPicker.tsx` moved, unchanged in every visible respect: the
 * `Attach ADE secrets` heading, the `Select all` row with its indeterminate
 * state and its mono count, the mono truncated name per row, the
 * `No project secrets to inject.` line and the `Remember for this lane` footer.
 *
 * **Names only.** A secret VALUE never reaches this page. The compiled version
 * could at least have asked the main process for one; a guest cannot, and must
 * not be able to. The child resolves the names against the encrypted project
 * store at launch time and hands the values to Cursor, so the only thing that
 * crosses the bridge in either direction is a list of strings a reader could
 * already read off the Secrets settings page.
 *
 * That is why nothing here logs, and why `availableNames` is the ONLY secret
 * input: give this component a value and it would render it.
 */

import React, { useEffect, useRef } from "react";

import { isInjectableCloudSecretName } from "../lib/cursorCloud";

export function SecretsList({
  availableNames,
  selectedNames,
  remember,
  disabled,
  onSelectedNamesChange,
  onRememberChange,
}: {
  availableNames: string[];
  selectedNames: string[];
  remember: boolean;
  disabled?: boolean;
  onSelectedNamesChange: (names: string[]) => void;
  onRememberChange: (remember: boolean) => void;
}): React.ReactElement {
  const selected = new Set(selectedNames);
  const injectableNames = [...new Set(availableNames.filter(isInjectableCloudSecretName))];
  const allSelected = injectableNames.length > 0 && injectableNames.every((name) => selected.has(name));
  const partiallySelected = injectableNames.some((name) => selected.has(name)) && !allSelected;
  const selectAllRef = useRef<HTMLInputElement>(null);

  // `indeterminate` is a DOM property with no attribute, so it cannot be set in
  // JSX and has to be written after every render that could change it.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = partiallySelected;
  }, [partiallySelected]);

  const toggleName = (name: string) => {
    if (selected.has(name)) {
      onSelectedNamesChange(selectedNames.filter((entry) => entry !== name));
      return;
    }
    onSelectedNamesChange([...selectedNames, name]);
  };

  const toggleAll = () => {
    if (allSelected) {
      const injectableSet = new Set(injectableNames);
      onSelectedNamesChange(selectedNames.filter((name) => !injectableSet.has(name)));
      return;
    }
    onSelectedNamesChange([...new Set([...selectedNames, ...injectableNames])]);
  };

  return (
    <div>
      <p className="px-2 pb-1 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg/55">
        Attach ADE secrets
      </p>
      {injectableNames.length > 0 ? (
        <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 font-sans text-[11px] font-medium text-fg/90 hover:bg-white/[0.06]">
          <input
            ref={selectAllRef}
            type="checkbox"
            role="menuitemcheckbox"
            aria-label="Select all attachable secrets"
            checked={allSelected}
            disabled={disabled}
            onChange={toggleAll}
            className="h-3 w-3 accent-violet-400"
          />
          <span>Select all</span>
          <span className="ml-auto font-mono text-[10px] text-muted-fg/55">{injectableNames.length}</span>
        </label>
      ) : null}
      <div className="max-h-40 overflow-y-auto">
        {injectableNames.length === 0 ? (
          <p className="px-2 py-1.5 font-sans text-[11px] text-muted-fg/70">
            No project secrets to inject.
          </p>
        ) : injectableNames.map((name) => {
          const checked = selected.has(name);
          return (
            <label
              key={name}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 font-sans text-[11px] text-fg/90 hover:bg-white/[0.06]"
            >
              <input
                type="checkbox"
                role="menuitemcheckbox"
                aria-label={name}
                checked={checked}
                disabled={disabled}
                onChange={() => toggleName(name)}
                className="h-3 w-3 accent-violet-400"
              />
              <span className="min-w-0 truncate font-mono text-[11px]">{name}</span>
            </label>
          );
        })}
      </div>
      <label className="flex cursor-pointer items-center gap-2 border-t border-white/[0.06] px-2 py-2 font-sans text-[11px] text-muted-fg/85 hover:bg-white/[0.04]">
        <input
          type="checkbox"
          aria-label="Remember for this lane"
          checked={remember}
          disabled={disabled}
          onChange={(event) => onRememberChange(event.target.checked)}
          className="h-3 w-3 accent-violet-400"
        />
        Remember for this lane
      </label>
    </div>
  );
}
