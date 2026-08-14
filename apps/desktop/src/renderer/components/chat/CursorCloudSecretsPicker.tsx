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
  const injectableNames = availableNames.filter(isInjectableCloudSecretName);

  const toggleName = (name: string) => {
    if (selected.has(name)) {
      onSelectedNamesChange(selectedNames.filter((entry) => entry !== name));
      return;
    }
    onSelectedNamesChange([...selectedNames, name]);
  };

  return (
    <div>
      <p className="px-2 pb-1 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg/55">
        Attach ADE secrets
      </p>
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
