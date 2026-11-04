/**
 * Add one server from ADE's catalogue, from Settings › Integrations.
 *
 * The definition is the catalogue's, so the person reads what runs and types
 * only the key it needs. A server that signs in through the browser is added,
 * then signed in, the way its row on the MCP servers page does it; the token
 * goes to the account vault, so every machine finds it.
 */
import React, { useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import {
  mcpCatalogueSecretValue,
  mcpCatalogueServer,
  type McpCatalogueEntry,
} from "../../../../shared/mcpCatalogue";
import type { McpSecretField } from "../../../../shared/mcpRegistry";
import { mcpServerRunsLabel, mcpServerRunsLine } from "../../../../shared/mcpServerRequest";
import { Dialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { showToast } from "../../app/toast/toastStore";
import { SolidLogo } from "../providers/ProviderHero";
import { integrationThemeVars } from "../integrations/integrationBrand";
import { mcpCatalogueBrand } from "./mcpCatalogueBrand";
import "../../chat/integrationConnectCard.css";
import "../../chat/mcpServerCard.css";
import type { McpRegistryApi, McpSecretValue } from "./useMcpRegistry";

function openUrl(url: string): void {
  void window.ade?.app?.openExternal?.(url);
}

export function McpCatalogueAddDialog({
  entry,
  registry,
  onClose,
  onAdded,
}: {
  entry: McpCatalogueEntry;
  registry: Pick<McpRegistryApi, "saveServer" | "signIn" | "cancelSignIn">;
  onClose: () => void;
  onAdded: () => void;
}) {
  const brand = mcpCatalogueBrand(entry);
  const server = mcpCatalogueServer(entry);
  const field: McpSecretField = server.transport === "stdio" ? "env" : "header";
  const signsIn = entry.auth === "oauth";
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<"idle" | "saving" | "signing-in">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "idle";

  const add = async () => {
    setError(null);
    setPhase("saving");
    const secrets: McpSecretValue[] = (entry.secrets ?? [])
      .map((secret) => ({ field, name: secret.name, value: mcpCatalogueSecretValue(entry, secret.name, (values[secret.name] ?? "").trim()) }))
      .filter((secret) => secret.value.length > 0);
    const saveError = await registry.saveServer(server, secrets, "create");
    if (saveError) {
      setPhase("idle");
      setError(saveError);
      return;
    }
    if (!signsIn) {
      showToast({ tone: "success", title: `Added ${entry.name}`, message: "New chats get it from now on." });
      onAdded();
      return;
    }
    setPhase("signing-in");
    const result = await registry.signIn(server);
    if (result.ok) {
      showToast({ tone: "success", title: `Added ${entry.name}`, message: "Signed in. New chats get it, on every computer." });
    } else {
      showToast({
        tone: result.cancelled ? "info" : "warning",
        title: `Added ${entry.name}, not signed in`,
        message: result.cancelled ? "Sign in from its row in Integrations › MCP servers." : result.message,
      });
    }
    onAdded();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (next) return;
        if (phase === "signing-in") registry.cancelSignIn(server.name);
        onClose();
      }}
      title={`Add ${entry.name}`}
      size="sm"
      dismissible={phase !== "saving"}
      testId="mcp-catalogue-dialog"
      footerStart={error ? (
        <Banner layout="inline" style={{ minWidth: 0 }} model={{ id: "mcp-catalogue-error", tone: "error", title: error }} />
      ) : null}
      actions={[
        {
          label: phase === "signing-in" ? "Waiting for the browser…" : signsIn ? `Continue with ${entry.name}` : "Add",
          onClick: () => void add(),
          busy,
          disabled: busy,
        },
        { label: "Cancel", onClick: onClose, disabled: phase === "saving" },
      ]}
    >
      <div className="ade-ix-dialog" style={integrationThemeVars(brand.accent)}>
        <div className="ade-ix-dialog-hero" style={brand.banner}>
          <SolidLogo spec={{ ...brand.logo, size: 34 }} straight />
          <div className="ade-ix-dialog-id">
            <span className="ade-ix-dialog-name">{entry.name}</span>
            <span className="ade-ix-dialog-by">By {entry.publisher}</span>
          </div>
        </div>
        <p className="ade-ix-dialog-desc">{entry.description}</p>
        <div className="ade-mcpc-runs">
          <span className="ade-mcpc-runs-label">{mcpServerRunsLabel(server)}</span>
          <code className="ade-mcpc-runs-line">{mcpServerRunsLine(server)}</code>
        </div>
        {(entry.secrets ?? []).map((secret, index) => (
          <label key={secret.name} className="ade-ap-field">
            <span className="ade-ap-field-label">{secret.label}</span>
            <input
              className="ade-ap-input"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              autoFocus={index === 0}
              disabled={busy}
              placeholder={secret.name}
              value={values[secret.name] ?? ""}
              onChange={(event) => setValues((prev) => ({ ...prev, [secret.name]: event.target.value }))}
              onKeyDown={(event) => { if (event.key === "Enter" && !busy) void add(); }}
            />
          </label>
        ))}
        <div className="ade-ix-dialog-links">
          {entry.tokenUrl && entry.secrets?.length ? (
            <button type="button" className="ade-icc-link" onClick={() => openUrl(entry.tokenUrl!)}>
              Get a key <ArrowSquareOut size={10} weight="bold" />
            </button>
          ) : null}
          <button type="button" className="ade-icc-link ade-icc-link-dim" onClick={() => openUrl(entry.docsUrl)}>
            {entry.name}'s docs <ArrowSquareOut size={10} weight="bold" />
          </button>
        </div>
      </div>
    </Dialog>
  );
}
