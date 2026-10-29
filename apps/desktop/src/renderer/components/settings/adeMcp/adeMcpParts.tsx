/** Small pieces the ADE MCP page, its setup sheet and its token dialog share. */
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Copy } from "@phosphor-icons/react";

/** Copy a value; says "Copied" for a moment. `onCopied` runs after the copy lands. */
export function CopyButton({
  value,
  label,
  children = "Copy",
  onCopied,
  tone,
}: {
  value: string;
  /** The accessible name: what is copied. */
  label: string;
  children?: string;
  onCopied?: () => void;
  tone?: "primary";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className="ade-modern-btn"
      data-size="sm"
      data-tone={tone}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          onCopied?.();
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1_500);
        }).catch(() => undefined);
      }}
    >
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
      {copied ? "Copied" : children}
    </button>
  );
}

/** A block of text to paste somewhere, with its Copy button. */
export function Snippet({
  code,
  copyLabel,
  caption,
  onCopied,
  secret = false,
}: {
  code: string;
  copyLabel: string;
  caption?: string;
  onCopied?: () => void;
  /** Holds a token: keep it out of spellcheck and autofill. */
  secret?: boolean;
}) {
  const multiline = code.includes("\n");
  return (
    <div className="ade-amcp-snippet" data-multiline={multiline ? "true" : undefined}>
      {caption ? <span className="ade-amcp-snippet-caption">{caption}</span> : null}
      <pre className="ade-amcp-snippet-code" spellCheck={false} data-secret={secret ? "true" : undefined}>{code}</pre>
      <span className="ade-amcp-snippet-copy">
        <CopyButton value={code} label={copyLabel} onCopied={onCopied} />
      </span>
    </div>
  );
}

/**
 * What the person sees on ADE's sign-in page: sign in, pick the access, Allow.
 * `pageTitle` names the page when the app shows it under a name of its own.
 */
export function SignInPreview({ pageTitle }: { pageTitle?: string }) {
  return (
    <div className="ade-amcp-signin">
      <span className="ade-amcp-signin-caption">
        {pageTitle ? <>ADE's page, titled <b>{pageTitle}</b>, opens:</> : "ADE's sign-in page opens:"}
      </span>
      <div className="ade-amcp-signin-flow">
        <span>Sign in to ADE</span>
        <ArrowRight size={11} aria-hidden />
        <span>Pick <b>Read &amp; write</b> or <b>Read only</b></span>
        <ArrowRight size={11} aria-hidden />
        <span><b>Allow</b></span>
      </div>
    </div>
  );
}
