import { Key, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { LaneDialogShell } from "../lanes/LaneDialogShell";
import { INPUT_CLASS_NAME, LABEL_CLASS_NAME, SECTION_CLASS_NAME } from "../lanes/laneDialogTokens";

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok" } | { kind: "error"; message: string };

export function CredentialsPromptDialog({
  open,
  vmName,
  defaultUsername = "ade",
  onOpenChange,
  onSave,
  onTestConnection,
}: {
  open: boolean;
  vmName: string | null;
  defaultUsername?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (args: { username: string; password: string }) => Promise<void>;
  /** Optional connection test hook — when omitted, the dialog skips testing and Save is always enabled once both fields are filled. */
  onTestConnection?: (args: { username: string; password: string }) => Promise<void>;
}) {
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUsername(defaultUsername);
      setPassword("");
      setTest({ kind: "idle" });
      setSaveError(null);
    }
  }, [open, defaultUsername]);

  const canTest = Boolean(username.trim() && password);
  const requireTest = Boolean(onTestConnection);
  const canSave = canTest && !busy && (!requireTest || test.kind === "ok");

  const runTest = useCallback(async () => {
    if (!onTestConnection || !canTest) return;
    setTest({ kind: "testing" });
    try {
      await onTestConnection({ username: username.trim(), password });
      setTest({ kind: "ok" });
    } catch (error) {
      setTest({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [canTest, onTestConnection, password, username]);

  const runSave = useCallback(async () => {
    if (!canSave) return;
    setBusy(true);
    setSaveError(null);
    try {
      await onSave({ username: username.trim(), password });
      onOpenChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [canSave, onOpenChange, onSave, password, username]);

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Save VM credentials"
      description={
        vmName
          ? `Used by ADE to SSH into ${vmName} and install the agent runtime. Stored in macOS Keychain.`
          : "Used by ADE to SSH into the Mac VM and install the agent runtime. Stored in macOS Keychain."
      }
      icon={Key}
      widthClassName="w-[min(520px,calc(100vw-24px))]"
      busy={busy}
    >
      <div className="space-y-4">
        <section className={SECTION_CLASS_NAME}>
          <div className="text-sm text-muted-fg">
            Use the Mac account you created during first-boot setup. The default username is <code className="font-mono text-fg">ade</code>.
          </div>
        </section>

        <section className={SECTION_CLASS_NAME}>
          <label className="block">
            <span className={LABEL_CLASS_NAME}>Username</span>
            <input
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setTest({ kind: "idle" });
              }}
              autoFocus
              autoComplete="username"
              disabled={busy}
              className={INPUT_CLASS_NAME}
            />
          </label>
        </section>

        <section className={SECTION_CLASS_NAME}>
          <label className="block">
            <span className={LABEL_CLASS_NAME}>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setTest({ kind: "idle" });
              }}
              autoComplete="current-password"
              disabled={busy}
              className={INPUT_CLASS_NAME}
            />
          </label>
        </section>

        {test.kind === "error" ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            <WarningCircle size={16} className="mt-0.5 shrink-0" />
            <span>{test.message}</span>
          </div>
        ) : null}
        {test.kind === "ok" ? (
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            Connection succeeded. Save to continue.
          </div>
        ) : null}
        {saveError ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            <WarningCircle size={16} className="mt-0.5 shrink-0" />
            <span>{saveError}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          {onTestConnection ? (
            <Button
              variant="outline"
              onClick={() => void runTest()}
              disabled={!canTest || test.kind === "testing" || busy}
            >
              {test.kind === "testing" ? "Testing..." : "Test connection"}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void runSave()}
            disabled={!canSave}
          >
            {busy ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </LaneDialogShell>
  );
}
