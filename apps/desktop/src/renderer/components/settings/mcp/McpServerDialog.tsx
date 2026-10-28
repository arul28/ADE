import React, { useMemo, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { ADE_RESERVED_MCP_SERVER_NAMES } from "../../../../shared/callerMcpServers";
import {
  MCP_TRANSPORT_LABEL,
  isValidMcpFieldName,
  isValidMcpRegistryName,
  mcpSecretVaultKey,
  normalizeMcpRegistryServer,
  type McpRegistryServer,
  type McpRegistryTransport,
  type McpSecretField,
} from "../../../../shared/mcpRegistry";
import { parseMcpServerSnippet, type McpServerDefinition } from "../../../../shared/mcpServerImport";
import { Dialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { SettingsSegmented } from "../primitives/SettingsControls";
import { McpSecretWarnings } from "./McpSecretWarnings";
import type { McpSecretValue } from "./useMcpRegistry";

/**
 * Add or edit one MCP server.
 *
 * A server is a name plus either a command (with arguments and env variables)
 * or a URL (with headers). The values of those variables and headers are
 * secrets: this form sends them to the vault and the list only ever keeps their
 * names, so an edit shows a saved value as "Saved", never as text. Leaving a
 * saved value's box empty keeps it.
 *
 * The name is the key everything else hangs off (the vault items, the "off
 * here" lists, the tool names agents see), so it is set once and not edited.
 */

type FieldRow = { id: number; name: string; value: string };

type FormState = {
  name: string;
  transport: McpRegistryTransport;
  command: string;
  /** One argument per line: an argument may hold spaces, a line cannot be misread. */
  argsText: string;
  url: string;
  fields: FieldRow[];
};

const TRANSPORTS: ReadonlyArray<{ value: McpRegistryTransport; label: string }> =
  (Object.keys(MCP_TRANSPORT_LABEL) as McpRegistryTransport[]).map((value) => ({ value, label: MCP_TRANSPORT_LABEL[value] }));

const SNIPPET_PLACEHOLDER = '{ "mcpServers": { "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" } } }';

let nextFieldId = 1;

function fieldRows(values: Record<string, string>): FieldRow[] {
  return Object.entries(values).map(([name, value]) => ({ id: nextFieldId++, name, value }));
}

function formFromDefinition(definition: McpServerDefinition): FormState {
  return {
    name: definition.name,
    transport: definition.transport,
    command: definition.command ?? "",
    argsText: (definition.args ?? []).join("\n"),
    url: definition.url ?? "",
    fields: fieldRows(definition.transport === "stdio" ? definition.env : definition.headers),
  };
}

function formFromServer(server: McpRegistryServer | null): FormState {
  if (!server) return { name: "", transport: "stdio", command: "", argsText: "", url: "", fields: [] };
  const names = server.transport === "stdio" ? server.envNames : server.headerNames;
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    argsText: (server.args ?? []).join("\n"),
    url: server.url ?? "",
    fields: names.map((name) => ({ id: nextFieldId++, name, value: "" })),
  };
}

export function McpServerDialog({
  editing,
  existingNames,
  heldSecretKeys,
  onClose,
  onSave,
}: {
  /** The server being edited, or null to add one. */
  editing: McpRegistryServer | null;
  existingNames: readonly string[];
  /** Vault keys this computer holds, so an edit can say which values are saved. Null when unknown. */
  heldSecretKeys: ReadonlySet<string> | null;
  onClose: () => void;
  /** Resolves to null when saved, or a sentence to show in the dialog. */
  onSave: (server: McpRegistryServer, secrets: McpSecretValue[]) => Promise<string | null>;
}) {
  const [form, setForm] = useState<FormState>(() => formFromServer(editing));
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [snippet, setSnippet] = useState("");
  const [snippetNote, setSnippetNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Only a failed save (`failed: true`) is ADE's to hear about; the rest are
  // the form's own checks, which warn without a Report.
  const [error, setError] = useState<{ message: string; failed: boolean } | null>(null);

  const patch = (next: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...next }));
    setError(null);
  };
  const isCommand = form.transport === "stdio";
  const secretField: McpSecretField = isCommand ? "env" : "header";
  const name = form.name.trim();
  const argList = useMemo(
    () => form.argsText.split("\n").map((arg) => arg.trim()).filter(Boolean),
    [form.argsText],
  );

  const savedHere = (fieldName: string): boolean =>
    editing != null
    && (editing.transport === "stdio") === isCommand
    && (isCommand ? editing.envNames : editing.headerNames).includes(fieldName)
    && heldSecretKeys?.has(mcpSecretVaultKey(editing.name, secretField, fieldName)) === true;

  const problem = useMemo((): string | null => {
    if (!name) return "Give it a name.";
    if (!isValidMcpRegistryName(name)) return "The name can use letters, numbers, - and _.";
    if (ADE_RESERVED_MCP_SERVER_NAMES.includes(name)) return "ADE uses that name itself. Pick another.";
    if (!editing && existingNames.includes(name)) return `You already have a server named ${name}.`;
    if (isCommand && !form.command.trim()) return "Enter the command that starts it.";
    if (!isCommand && !/^https?:\/\/\S+$/i.test(form.url.trim())) return "Enter a URL that starts with http:// or https://.";
    const names = form.fields.map((field) => field.name.trim()).filter(Boolean);
    const bad = names.find((entry) => !isValidMcpFieldName(entry));
    if (bad) return `${bad} can use letters, numbers, - and _ only.`;
    if (new Set(names).size !== names.length) return "Two values have the same name.";
    return null;
  }, [editing, existingNames, form.command, form.fields, form.url, isCommand, name]);

  const fillFromSnippet = () => {
    const servers = parseMcpServerSnippet(snippet);
    const first = servers[0];
    if (!first) {
      setSnippetNote("No server found in that. Paste the JSON a server's own page gives you.");
      return;
    }
    setForm(formFromDefinition(first));
    setError(null);
    setSnippetNote(servers.length > 1 ? `That has ${servers.length} servers. This is the first, ${first.name}.` : null);
    setSnippetOpen(false);
  };

  const save = async () => {
    if (problem || saving) {
      setError(problem ? { message: problem, failed: false } : null);
      return;
    }
    const fields = form.fields.map((field) => ({ ...field, name: field.name.trim() })).filter((field) => field.name);
    const server = normalizeMcpRegistryServer({
      name,
      transport: form.transport,
      command: form.command,
      args: argList,
      url: form.url,
      envNames: isCommand ? fields.map((field) => field.name) : [],
      headerNames: isCommand ? [] : fields.map((field) => field.name),
      enabled: editing?.enabled ?? true,
    });
    if (!server) {
      setError({ message: "ADE can't save that server. Check its name and its command or URL.", failed: false });
      return;
    }
    setSaving(true);
    const outcome = await onSave(server, fields.map((field) => ({ field: secretField, name: field.name, value: field.value })));
    setSaving(false);
    if (outcome) setError({ message: outcome, failed: true });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={editing ? `Edit ${editing.name}` : "Add an MCP server"}
      size="md"
      maxHeight="min(720px, calc(100vh - 48px))"
      dismissible={!saving}
      testId="mcp-server-dialog"
      footerStart={error ? (
        <Banner
          layout="inline"
          style={{ minWidth: 0 }}
          model={{
            id: "mcp-server-dialog-error",
            tone: error.failed ? "error" : "warning",
            title: error.message,
            report: error.failed ? { surface: "mcp_server_save" } : false,
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}
      actions={[
        { label: editing ? "Save" : "Add", onClick: () => void save(), busy: saving, disabled: saving },
        { label: "Cancel", onClick: onClose, disabled: saving },
      ]}
    >
      <div className="ade-mcp-form">
        {!editing ? (
          <div className="ade-ap-field">
            <div>
              <button type="button" className="ade-modern-btn" data-variant="link" onClick={() => setSnippetOpen((prev) => !prev)}>
                {snippetOpen ? "Fill it in by hand" : "Paste JSON instead"}
              </button>
            </div>
            {snippetOpen ? (
              <>
                <textarea
                  className="ade-modern-field"
                  aria-label="MCP server JSON"
                  rows={6}
                  spellCheck={false}
                  placeholder={SNIPPET_PLACEHOLDER}
                  value={snippet}
                  onChange={(event) => setSnippet(event.target.value)}
                />
                <div>
                  <button type="button" className="ade-modern-btn" onClick={fillFromSnippet} disabled={!snippet.trim()}>
                    Fill the form
                  </button>
                </div>
              </>
            ) : null}
            {snippetNote ? <p className="ade-modern-muted">{snippetNote}</p> : null}
          </div>
        ) : null}

        <div className="ade-ap-field">
          <label htmlFor="mcp-server-name">Name</label>
          <input
            id="mcp-server-name"
            className="ade-modern-field"
            data-mono="true"
            value={form.name}
            disabled={editing != null}
            placeholder="context7"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => patch({ name: event.target.value })}
          />
          <p className="ade-modern-muted">
            {editing
              ? "The name can't be changed. To rename it, remove the server and add it again."
              : "Agents see its tools under this name. It can't be changed later."}
          </p>
        </div>

        <div className="ade-ap-field">
          <span className="ade-mcp-label">How ADE reaches it</span>
          <div>
            <SettingsSegmented
              ariaLabel="How ADE reaches it"
              value={form.transport}
              options={TRANSPORTS}
              onChange={(transport) => {
                // Env variables and headers are different things: switching
                // between a command and a URL starts their list again.
                const keepsFields = (transport === "stdio") === isCommand;
                patch({ transport, ...(keepsFields ? {} : { fields: [] }) });
              }}
            />
          </div>
        </div>

        {isCommand ? (
          <>
            <div className="ade-ap-field">
              <label htmlFor="mcp-server-command">Command</label>
              <input
                id="mcp-server-command"
                className="ade-modern-field"
                data-mono="true"
                value={form.command}
                placeholder="npx"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => patch({ command: event.target.value })}
              />
            </div>
            <div className="ade-ap-field">
              <label htmlFor="mcp-server-args">Arguments, one per line</label>
              <textarea
                id="mcp-server-args"
                className="ade-modern-field"
                rows={3}
                spellCheck={false}
                placeholder={"-y\n@upstash/context7-mcp"}
                value={form.argsText}
                onChange={(event) => patch({ argsText: event.target.value })}
              />
              <McpSecretWarnings server={{ transport: "stdio", args: argList }} where="args" />
            </div>
          </>
        ) : (
          <div className="ade-ap-field">
            <label htmlFor="mcp-server-url">URL</label>
            <input
              id="mcp-server-url"
              className="ade-modern-field"
              data-mono="true"
              value={form.url}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => patch({ url: event.target.value })}
            />
            <p className="ade-modern-muted">
              If it asks you to sign in with a browser, save it, then press Sign in on its row. ADE signs in once for every agent.
            </p>
            <McpSecretWarnings server={{ transport: form.transport, url: form.url }} where="url" />
          </div>
        )}

        <div className="ade-ap-field">
          <span className="ade-mcp-label">{isCommand ? "Environment variables" : "Headers"}</span>
          <p className="ade-modern-muted">
            Values are kept in your account vault, not in the list. Leave a saved one empty to keep it.
          </p>
          {form.fields.map((field) => (
            <div key={field.id} className="ade-mcp-pair">
              <input
                className="ade-modern-field"
                data-mono="true"
                aria-label={isCommand ? "Variable name" : "Header name"}
                placeholder={isCommand ? "API_KEY" : "Authorization"}
                value={field.name}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => patch({
                  fields: form.fields.map((entry) => (entry.id === field.id ? { ...entry, name: event.target.value } : entry)),
                })}
              />
              <input
                className="ade-modern-field"
                data-mono="true"
                type="password"
                autoComplete="off"
                aria-label={`Value of ${field.name || "this one"}`}
                placeholder={savedHere(field.name.trim()) ? "Saved" : "Value"}
                value={field.value}
                onChange={(event) => patch({
                  fields: form.fields.map((entry) => (entry.id === field.id ? { ...entry, value: event.target.value } : entry)),
                })}
              />
              <button
                type="button"
                className="ade-modern-btn"
                data-variant="ghost"
                data-icon="true"
                aria-label={`Remove ${field.name || "this one"}`}
                title="Remove"
                onClick={() => patch({ fields: form.fields.filter((entry) => entry.id !== field.id) })}
              >
                <X size={12} weight="bold" />
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="ade-modern-btn"
              onClick={() => patch({ fields: [...form.fields, { id: nextFieldId++, name: "", value: "" }] })}
            >
              <Plus size={12} weight="bold" /> {isCommand ? "Add a variable" : "Add a header"}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
