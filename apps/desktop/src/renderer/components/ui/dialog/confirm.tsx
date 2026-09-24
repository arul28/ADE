import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NoticeTone } from "../notice/noticeTones";
import { Dialog } from "./Dialog";

/**
 * `confirmDialog` / `promptDialog`: the app's replacement for `window.confirm`
 * and `window.prompt`. Callable from anywhere — a React handler, a hook, or a
 * plain module like `historyGitActions.ts` — and always rendered by the one
 * `<DialogHost />` mounted at the app root (one is mounted on demand when no
 * host exists, e.g. in the web client or a test).
 *
 * Requests raised while another dialog is open stack above it on the
 * `nestedDialog` layer; Radix hands focus to the newest one and back again.
 *
 * Never call `window.confirm`, `window.prompt` or `alert` in the renderer.
 */

export type ConfirmDialogOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Icon tile + confirm button tone. Defaults to `error` when destructive, else `accent`. */
  tone?: NoticeTone;
  /** Deletes, discards and resets: red confirm button. */
  destructive?: boolean;
  /** Show the tone icon tile. Default: shown when `tone` is set or `destructive`. */
  icon?: boolean;
  /**
   * Withdraw the question: aborting closes the dialog and resolves `false`.
   * For confirms that stop applying while open, or whose owner unmounts.
   */
  signal?: AbortSignal;
};

export type PromptDialogOptions = {
  title: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: NoticeTone;
  /**
   * Allow submitting an empty value (resolves `""`), as `window.prompt` did.
   * Default false: the confirm button stays disabled until there is text.
   */
  allowEmpty?: boolean;
  /** Return an error message to block submit, or null when the value is fine. */
  validate?: (value: string) => string | null | undefined;
};

type PromptRequest = {
  id: number;
  kind: "prompt";
  options: PromptDialogOptions;
  resolve: (value: string | null) => void;
  draft: { value: string; touched: boolean };
};

type Request =
  | { id: number; kind: "confirm"; options: ConfirmDialogOptions; resolve: (value: boolean) => void }
  | PromptRequest;

let nextId = 1;
let requests: Request[] = [];
const listeners = new Set<() => void>();
const hosts: Array<{ token: symbol; fallback: boolean }> = [];
let fallbackRoot: Root | null = null;
let fallbackContainer: HTMLElement | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return requests;
}

/** Drop a request; false when it was already settled. */
function remove(id: number): boolean {
  if (!requests.some((entry) => entry.id === id)) return false;
  requests = requests.filter((entry) => entry.id !== id);
  emit();
  if (requests.length === 0) removeFallbackHostWhenIdle();
  return true;
}

function removeFallbackHost() {
  const root = fallbackRoot;
  const container = fallbackContainer;
  fallbackRoot = null;
  fallbackContainer = null;
  root?.unmount();
  container?.remove();
}

function removeFallbackHostWhenIdle() {
  queueMicrotask(() => {
    if (requests.length === 0 && hosts.some((host) => !host.fallback)) removeFallbackHost();
  });
}

function ensureHost() {
  if (hosts.length > 0 || fallbackRoot || typeof document === "undefined") return;
  const container = document.createElement("div");
  container.setAttribute("data-ade-dialog-host", "");
  document.body.appendChild(container);
  fallbackContainer = container;
  const root = createRoot(container);
  fallbackRoot = root;
  root.render(<RegisteredDialogHost fallback />);
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const { signal } = options;
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const id = nextId++;
    const onAbort = () => {
      if (remove(id)) resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (value: boolean) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    requests = [...requests, { id, kind: "confirm", options, resolve: settle }];
    ensureHost();
    emit();
  });
}

export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    requests = [
      ...requests,
      {
        id: nextId++,
        kind: "prompt",
        options,
        resolve,
        draft: { value: options.defaultValue ?? "", touched: false },
      },
    ];
    ensureHost();
    emit();
  });
}

/** Test helper: cancel everything still open. */
export function __resetDialogRequestsForTests() {
  const pending = requests;
  requests = [];
  emit();
  for (const request of pending) {
    if (request.kind === "confirm") request.resolve(false);
    else request.resolve(null);
  }
  removeFallbackHost();
}

/**
 * Renders pending confirm/prompt requests. Mount once at the app root. If more
 * than one is mounted, only the first renders.
 */
export function DialogHost(): JSX.Element {
  return <RegisteredDialogHost fallback={false} />;
}

function RegisteredDialogHost({ fallback }: { fallback: boolean }): JSX.Element | null {
  const [token] = useState(() => Symbol("dialog-host"));
  const [isPrimary, setIsPrimary] = useState(false);
  useEffect(() => {
    const registration = { token, fallback };
    if (fallback) {
      hosts.push(registration);
    } else {
      const firstFallback = hosts.findIndex((host) => host.fallback);
      // Keep an active dialog on its current React root so focus and local
      // state stay intact. The app host takes over when the request settles.
      const insertAt = firstFallback >= 0 && requests.length === 0 ? firstFallback : hosts.length;
      hosts.splice(insertAt, 0, registration);
    }
    const update = () => setIsPrimary(hosts[0]?.token === token);
    update();
    const unsubscribe = subscribe(update);
    emit();
    if (!fallback && requests.length === 0) removeFallbackHostWhenIdle();
    return () => {
      const index = hosts.findIndex((host) => host.token === token);
      if (index >= 0) hosts.splice(index, 1);
      unsubscribe();
      emit();
      if (!fallback) {
        queueMicrotask(() => {
          if (requests.length > 0 && !hosts.some((host) => !host.fallback)) ensureHost();
        });
      }
    };
  }, [fallback, token]);
  const pending = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!isPrimary) return null;
  return (
    <>
      {pending.map((request) =>
        request.kind === "confirm" ? (
          <ConfirmDialogView
            key={request.id}
            options={request.options}
            onResult={(value) => {
              if (remove(request.id)) request.resolve(value);
            }}
          />
        ) : (
          <PromptDialogView
            key={request.id}
            request={request}
            onResult={(value) => {
              if (remove(request.id)) request.resolve(value);
            }}
          />
        ),
      )}
    </>
  );
}

function ConfirmDialogView({
  options,
  onResult,
}: {
  options: ConfirmDialogOptions;
  onResult: (confirmed: boolean) => void;
}): JSX.Element {
  const tone: NoticeTone = options.tone ?? (options.destructive ? "error" : "accent");
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onResult(false);
      }}
      role="alertdialog"
      layer="nestedDialog"
      size="sm"
      tone={tone}
      icon={(options.icon ?? Boolean(options.tone || options.destructive)) || undefined}
      title={options.title}
      description={options.message}
      hideClose
      actions={[
        { label: options.cancelLabel ?? "Cancel", variant: "secondary", onClick: () => onResult(false) },
        { label: options.confirmLabel ?? "OK", variant: "solid", autoFocus: true, onClick: () => onResult(true) },
      ]}
    />
  );
}

function PromptDialogView({
  request,
  onResult,
}: {
  request: PromptRequest;
  onResult: (value: string | null) => void;
}): JSX.Element {
  const { options, draft } = request;
  const [value, setValue] = useState(draft.value);
  const [touched, setTouched] = useState(draft.touched);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();
  const error = options.validate ? options.validate(value) ?? null : null;
  const empty = !options.allowEmpty && !value.trim();
  const blocked = empty || Boolean(error);
  const tone = options.tone ?? "accent";

  const submit = () => {
    draft.touched = true;
    setTouched(true);
    if (blocked) return;
    onResult(value);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onResult(null);
      }}
      layer="nestedDialog"
      size="sm"
      tone={tone}
      title={options.title}
      description={options.message}
      hideClose
      initialFocusRef={inputRef}
      actions={[
        { label: options.cancelLabel ?? "Cancel", variant: "secondary", onClick: () => onResult(null) },
        { label: options.confirmLabel ?? "OK", variant: "solid", disabled: blocked, onClick: submit },
      ]}
    >
      <input
        ref={inputRef}
        className="ade-dialog-input"
        value={value}
        placeholder={options.placeholder}
        aria-label={options.title}
        aria-invalid={touched && Boolean(error) ? true : undefined}
        aria-describedby={touched && error ? errorId : undefined}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          draft.value = event.target.value;
          draft.touched = true;
          setValue(event.target.value);
          setTouched(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {touched && error ? (
        <div id={errorId} role="alert" style={{ marginTop: 6, fontSize: 11.5, color: "var(--color-error)" }}>
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}
