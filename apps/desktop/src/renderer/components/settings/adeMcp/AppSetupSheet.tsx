/**
 * One app's setup, in a side sheet beside the ADE MCP page: how it connects,
 * numbered steps with the real menu paths and the account's address filled
 * in, what ADE's sign-in page asks, and the app's known gotchas.
 */
import { CheckCircle, Info, Key, UserCircle } from "@phosphor-icons/react";
import { Dialog } from "../../ui/dialog";
import { McpAppLogo, OTHER_APP_HINTS, KNOWN_APP_LABEL, type GalleryApp } from "./adeMcpApps";
import { CopyButton, SignInPreview, Snippet } from "./adeMcpParts";

export function AppSetupSheet({
  app,
  serverUrl,
  connectedCount,
  onClose,
  onUseToken,
}: {
  app: GalleryApp;
  serverUrl: string;
  /** Connections this app already has, so the sheet can say so. */
  connectedCount: number;
  onClose: () => void;
  onUseToken: () => void;
}) {
  const steps = app.steps(serverUrl);
  const tokenButton = app.token || app.tokenSnippet;
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      placement="right"
      width={540}
      title={app.id === "other" ? "Connect another app" : `Connect ${app.label}`}
      titleContent={(
        <div className="ade-amcp-sheet-head">
          <McpAppLogo app={app.id} size={40} />
          <div>
            <h2>{app.id === "other" ? "Connect another app" : `Connect ${app.label}`}</h2>
            <p>{app.subtitle}</p>
          </div>
        </div>
      )}
      panelClassName="ade-amcp-dialog ade-amcp-sheet"
      footerStart={tokenButton ? (
        <button type="button" className="ade-modern-btn" data-size="sm" data-variant="ghost" onClick={onUseToken}>
          <Key size={12} />
          {app.tokenAction ?? "Use a token instead"}
        </button>
      ) : null}
      actions={[{ label: "Done", variant: "solid", onClick: onClose }]}
    >
      <div className="ade-amcp-sheet-body">
        <div className="ade-amcp-ways" aria-label="How it connects">
          <span className="ade-amcp-way" data-on={app.signIn ? "true" : undefined}>
            <UserCircle size={13} weight="duotone" />
            Signs in with your ADE account
          </span>
          <span className="ade-amcp-way" data-on={app.token ? "true" : undefined}>
            <Key size={13} weight="duotone" />
            {app.token ? "Or uses a token" : "No tokens"}
          </span>
        </div>

        {connectedCount > 0 ? (
          <p className="ade-amcp-sheet-connected">
            <CheckCircle size={14} weight="fill" />
            {connectedCount === 1 ? "Already connected." : `Connected ${connectedCount} times.`} It's listed under Connections.
          </p>
        ) : null}

        <ol className="ade-ig-steps ade-amcp-steps">
          {steps.map((step, index) => (
            <li key={index} className="ade-ig-step">
              <span className="ade-ig-step-num">{index + 1}</span>
              <div className="ade-ig-step-main">
                <div className="ade-ig-step-head"><b>{step.title}</b></div>
                {step.detail ? <p className="ade-amcp-step-detail">{step.detail}</p> : null}
                {step.snippet ? <Snippet code={step.snippet.code} copyLabel={step.snippet.copyLabel} caption={step.snippet.caption} /> : null}
                {step.signIn ? <SignInPreview pageTitle={step.signIn.pageTitle} /> : null}
              </div>
            </li>
          ))}
        </ol>

        {app.id === "other" ? (
          <section className="ade-amcp-sheet-section">
            <span className="kit-eyebrow">Apps ADE knows</span>
            <div className="ade-ig-mini-rows">
              {OTHER_APP_HINTS.map((hint) => {
                const how = hint.how(serverUrl);
                return (
                  <div key={hint.app} className="ade-ig-mini-row ade-amcp-hint-row">
                    <McpAppLogo app={hint.app} size={20} />
                    <span className="ade-amcp-hint-text">{how.text}</span>
                    {how.copy ? <CopyButton value={how.copy} label={`Copy ${KNOWN_APP_LABEL[hint.app]} setup`} /> : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {app.notes?.length ? (
          <section className="ade-amcp-sheet-section">
            <span className="kit-eyebrow">If it doesn't work</span>
            {app.notes.map((note, index) => (
              <p key={index} className="ade-amcp-note">
                <Info size={13} />
                <span>{note}</span>
              </p>
            ))}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
