/**
 * Add one server from ADE's catalogue, from Settings › Integrations.
 *
 * The definition is the catalogue's, so the person reads what runs and types
 * only the key it needs. A server that signs in through the browser signs in
 * first, the way the chat's MCP server card does it, and is added only when
 * the sign-in finishes; the token goes to the account vault, so every machine
 * finds it.
 */
import React, { useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import {
  mcpCatalogueSecretValue,
  mcpCatalogueServer,
  type McpCatalogueEntry,
} from "../../../../shared/mcpCatalogue";
import type { McpSecretField } from "../../../../shared/mcpRegistry";
import { Dialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { showToast } from "../../app/toast/toastStore";
import { SolidLogo } from "../providers/ProviderHero";
import { integrationThemeVars } from "../integrations/integrationBrand";
import { openExternalUrl } from "../../../lib/openExternal";
import { CardFieldInput } from "../../chat/composerCardParts";
import { mcpCatalogueBrand } from "./mcpCatalogueBrand";
import { McpRunsLine } from "./McpRunsLine";
import type { McpRegistryApi, McpSecretValue } from "./useMcpRegistry";
import "../integrations/integrationPage.css";

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
  const [phase, setPhase] = useState<"idle" | "signing-in" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "idle";

  const add = async () => {
    setError(null);
    if (signsIn) {
      // Signed in first: a sign-in that fails or is cancelled adds nothing.
      setPhase("signing-in");
      const result = await registry.signIn(server);
      if (!result.ok) {
        setPhase("idle");
        if (!result.cancelled) setError(result.message);
        return;
      }
    }
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
    showToast({
      tone: "success",
      title: `Added ${entry.name}`,
      message: signsIn ? "Signed in. New chats get it, on every computer." : "New chats get it from now on.",
    });
    onAdded();
  };

  // Closing stops a sign-in that is still waiting for the browser.
  const close = () => {
    if (phase === "signing-in") registry.cancelSignIn(server.name);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => { if (!next) close(); }}
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
        { label: "Cancel", onClick: close, disabled: phase === "saving" },
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
        <McpRunsLine server={server} />
        {(entry.secrets ?? []).map((secret, index) => (
          <label key={secret.name} className="ade-ap-field">
            <span className="ade-ap-field-label">{secret.label}</span>
            <CardFieldInput
              kind="secret"
              label={secret.label}
              placeholder={secret.name}
              value={values[secret.name] ?? ""}
              onChange={(next) => setValues((prev) => ({ ...prev, [secret.name]: next }))}
              onSubmit={() => { if (!busy) void add(); }}
              disabled={busy}
              autoFocus={index === 0}
              testId={`mcp-catalogue-field-${secret.name}`}
            />
          </label>
        ))}
        <div className="ade-ix-dialog-links">
          {entry.tokenUrl && entry.secrets?.length ? (
            <button type="button" className="ade-ig-link" onClick={() => openExternalUrl(entry.tokenUrl)}>
              Get a key <ArrowSquareOut size={10} weight="bold" />
            </button>
          ) : null}
          <button type="button" className="ade-ig-link" data-dim="true" onClick={() => openExternalUrl(entry.docsUrl)}>
            {entry.name}'s docs <ArrowSquareOut size={10} weight="bold" />
          </button>
        </div>
      </div>
    </Dialog>
  );
}
