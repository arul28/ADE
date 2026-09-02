import { useEffect, useRef } from "react";

export function isInjectableCloudSecretName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !trimmed.toUpperCase().startsWith("CURSOR_");
}

/**
 * Secret checkboxes for the Cursor Cloud Advanced menu.
 * Names only — values stay in the encrypted project secret store.
 */
export function CursorCloudSecretsList({
  availableNames,
  selectedNames,
  remember,
  onSelectedNamesChange,
  onRememberChange,
}: {
  availableNames: string[];
  selectedNames: string[];
  remember: boolean;
  onSelectedNamesChange: (names: string[]) => void;
  onRememberChange: (remember: boolean) => void;
}) {
  const selected = new Set(selectedNames);
  const injectableNames = [...new Set(availableNames.filter(isInjectableCloudSecretName))];
  const allSelected = injectableNames.length > 0 && injectableNames.every((name) => selected.has(name));
  const partiallySelected = injectableNames.some((name) => selected.has(name)) && !allSelected;
  const selectAllRef = useRef<HTMLInputElement>(null);

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
          onChange={(event) => onRememberChange(event.target.checked)}
          className="h-3 w-3 accent-violet-400"
        />
        Remember for this lane
      </label>
    </div>
  );
}
