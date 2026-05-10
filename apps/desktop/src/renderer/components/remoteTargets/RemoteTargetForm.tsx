import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import type { RemoteRuntimeTargetInput } from "../../../shared/types";

export type RemoteTargetFormPrefill = Partial<RemoteRuntimeTargetInput> & {
  key: string;
};

type RemoteTargetFormProps = {
  busy?: boolean;
  prefill?: RemoteTargetFormPrefill | null;
  onSubmit: (input: RemoteRuntimeTargetInput) => void | Promise<void>;
};

const fieldStyle: CSSProperties = {
  width: "100%",
  height: 38,
  borderRadius: 8,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(255,255,255,0.03)",
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  padding: "0 10px",
  outline: "none",
};

export function RemoteTargetForm({ busy = false, onSubmit, prefill = null }: RemoteTargetFormProps) {
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [sshUser, setSshUser] = useState("");
  const [port, setPort] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const prefillKey = prefill?.key ?? null;
  const prefillName = prefill?.name;
  const prefillHostname = prefill?.hostname;
  const prefillSshUser = prefill?.sshUser;
  const prefillPort = prefill?.port;
  const prefillSshKeyPath = prefill?.sshKeyPath;

  useEffect(() => {
    if (!prefill) return;
    if (prefillName !== undefined) setName(prefillName ?? "");
    if (prefillHostname !== undefined) setHostname(prefillHostname);
    if (prefillSshUser !== undefined) setSshUser(prefillSshUser ?? "");
    if (prefillPort !== undefined) setPort(prefillPort == null ? "" : String(prefillPort));
    if (prefillSshKeyPath !== undefined) setSshKeyPath(prefillSshKeyPath ?? "");
  }, [prefill, prefillHostname, prefillKey, prefillName, prefillPort, prefillSshKeyPath, prefillSshUser]);

  const canSubmit = useMemo(() => {
    if (!hostname.trim()) return false;
    if (!port.trim()) return true;
    return Number.parseInt(port, 10) > 0;
  }, [hostname, port]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    await onSubmit({
      name: name.trim() || null,
      hostname: hostname.trim(),
      sshUser: sshUser.trim() || null,
      port: port.trim() ? Number.parseInt(port, 10) : null,
      sshKeyPath: sshKeyPath.trim() || null,
    });
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={LABEL_STYLE}>Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Mac Studio"
            style={fieldStyle}
            disabled={busy}
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={LABEL_STYLE}>Host</span>
          <input
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="studio.local"
            style={fieldStyle}
            disabled={busy}
            required
          />
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 104px", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={LABEL_STYLE}>SSH user</span>
          <input
            value={sshUser}
            onChange={(event) => setSshUser(event.target.value)}
            placeholder="From SSH config"
            style={fieldStyle}
            disabled={busy}
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={LABEL_STYLE}>Port</span>
          <input
            value={port}
            onChange={(event) => setPort(event.target.value)}
            inputMode="numeric"
            placeholder="From SSH config"
            style={fieldStyle}
            disabled={busy}
          />
        </label>
      </div>
      <label style={{ display: "grid", gap: 6 }}>
        <span style={LABEL_STYLE}>SSH key path</span>
        <input
          value={sshKeyPath}
          onChange={(event) => setSshKeyPath(event.target.value)}
          placeholder="Optional, defaults to ssh-agent or your SSH config"
          style={fieldStyle}
          disabled={busy}
        />
      </label>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
          ADE connects over SSH and starts `ade rpc --stdio` on the target.
        </div>
        <button
          type="submit"
          disabled={!canSubmit || busy}
          style={{
            ...primaryButton({ height: 36, padding: "0 16px", fontSize: 12 }),
            opacity: canSubmit && !busy ? 1 : 0.55,
          }}
        >
          {busy ? "Connecting..." : "Connect"}
        </button>
      </div>
    </form>
  );
}

export function RemoteTargetEmptyAction({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={outlineButton({ height: 32, padding: "0 12px", fontSize: 12 })}>
      Add machine
    </button>
  );
}
