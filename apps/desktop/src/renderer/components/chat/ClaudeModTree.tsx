import { useEffect, useState, type ReactNode } from "react";
import {
  safeClaudePluginUiHref,
  type ClaudePluginUiAction,
  type ClaudePluginUiElement,
  type ClaudePluginUiNode,
  type ClaudePluginUiPropValue,
  type ClaudePluginUiSite,
} from "../../../shared/claudePluginUi";
import { ChatMarkdown } from "./chatMarkdown";
import { boxStyle, textStyle } from "./claudeModUiStyle";

/**
 * Draws the element tree a mod returned for one render site. The host already
 * reduced the tree to known elements and props; an element this surface does
 * not know draws nothing.
 */
type ModTreeProps = {
  node: ClaudePluginUiNode;
  site: ClaudePluginUiSite;
  act: (action: ClaudePluginUiAction) => void;
  /** False once the Claude process that drew the tree is gone: nothing can be pressed. */
  live: boolean;
};

const str = (value: ClaudePluginUiPropValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A web link a mod may open, in the system browser. The window never navigates. */
function ModLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <a
      className="ade-mod-link"
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        void window.ade.app.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Links inside a mod's Markdown follow the mod link rule, not the chat's: a
 * transcript link may open a file or an ADE deeplink, and a mod must not.
 */
const MARKDOWN_OVERRIDES = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    const safe = safeClaudePluginUiHref(href);
    return safe ? <ModLink href={safe}>{children}</ModLink> : <span>{children}</span>;
  },
};

function ModChildren({ nodes, ...rest }: Omit<ModTreeProps, "node"> & { nodes: ClaudePluginUiNode[] | undefined }): ReactNode {
  // A mod's tree is positional, but a control keeps its own state (typed
  // text), so a control with a `key` is tracked by it, not by its place. A
  // mod may repeat a key among siblings; the count keeps React's keys unique.
  const seen = new Map<string, number>();
  return nodes?.map((child, index) => {
    const own = typeof child === "string" ? undefined : str(child.props.key);
    if (!own) return <ModTree key={index} node={child} {...rest} />;
    const nth = seen.get(own) ?? 0;
    seen.set(own, nth + 1);
    return <ModTree key={`key:${own}#${nth}`} node={child} {...rest} />;
  });
}

export function ModTree({ node, site, act, live }: ModTreeProps): ReactNode {
  if (typeof node === "string") return node;
  const { props, target } = node;
  const key = str(props.key);
  const children = <ModChildren nodes={node.children} site={site} act={act} live={live} />;
  switch (node.type) {
    case "Box":
      return <div style={boxStyle(props)}>{children}</div>;
    case "Text":
      return <span style={textStyle(props)}>{children}</span>;
    case "Button":
      return (
        <button
          type="button"
          className="ade-mod-button"
          data-variant={props.plain === true ? "plain" : props.variant === "primary" ? "primary" : "default"}
          data-dim={props.dimColor === true ? "true" : undefined}
          disabled={!live || !target}
          onClick={() => target && act({ kind: "press", target, key })}
        >
          {str(props.label) || (props.role === "dismiss" ? "×" : "")}
        </button>
      );
    case "Link": {
      const href = safeClaudePluginUiHref(props.href);
      const body = str(props.label) ?? (node.children?.length ? children : href);
      // A link this surface may not open draws as plain text, on one line like any label.
      return href ? <ModLink href={href}>{body}</ModLink> : <span className="ade-mod-plain-link">{body}</span>;
    }
    case "Code":
      return <pre className="ade-mod-code" data-wrap={props.wrap === true ? "true" : undefined}>{str(props.source) ?? ""}</pre>;
    case "Markdown":
      return (
        <div className="ade-mod-markdown" data-dim={props.dimColor === true ? "true" : undefined}>
          <ChatMarkdown componentOverrides={MARKDOWN_OVERRIDES}>{str(props.text) ?? ""}</ChatMarkdown>
        </div>
      );
    case "Input":
      return <ModInput element={node} site={site} act={act} live={live} />;
    case "Select": {
      const options = Array.isArray(props.options) ? props.options : [];
      const label = str(props.label);
      return (
        <label className="ade-mod-field">
          {label ? <span className="ade-mod-field-label">{label}</span> : null}
          <select
            className="ade-mod-select"
            value={str(props.value) ?? ""}
            disabled={!live || !target}
            onChange={(event) => target && act({ kind: "select", target, key, value: event.target.value, site })}
          >
            {options.map((option, index) => (
              // A mod may repeat a value; the place keeps React's keys unique.
              <option key={`${index}:${option.value}`} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      );
    }
    default:
      return null;
  }
}

function ModInput({ element, site, act, live }: Omit<ModTreeProps, "node"> & { element: ClaudePluginUiElement }): ReactNode {
  const { props, target } = element;
  const hostValue = str(props.value) ?? "";
  const label = str(props.label);
  const [value, setValue] = useState(hostValue);
  // The mod's own value wins when it changes (a submit it accepted or cleared).
  // A different field in the same place (another key, label or placeholder)
  // starts from its own value too: typed text never moves to another field.
  const field = `${str(props.key) ?? ""}|${label ?? ""}|${str(props.placeholder) ?? ""}`;
  useEffect(() => setValue(hostValue), [hostValue, field]);
  const disabled = !live || !target;
  return (
    <form
      className="ade-mod-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (target && !disabled) act({ kind: "input", target, key: str(props.key), value, site });
      }}
    >
      {label ? <span className="ade-mod-field-label">{label}</span> : null}
      <input
        className="ade-mod-input"
        type="text"
        value={value}
        placeholder={str(props.placeholder)}
        aria-label={label ?? str(props.placeholder) ?? "Mod input"}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="ade-mod-button" data-variant="default" disabled={disabled}>
        {str(props.submitLabel) ?? "Submit"}
      </button>
    </form>
  );
}
