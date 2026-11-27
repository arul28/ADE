/**
 * `ade-ui` — ADE's local ESLint plugin for the shared UI primitives.
 *
 * Every banner, toast, confirm/prompt, modal and top-bar sheet in the renderer
 * renders through one primitive (components/ui/notice, components/ui/dialog,
 * components/app/toast, components/app/HeaderSheet) and stacks on one scale
 * (components/ui/zLayers.ts). These rules flag code that goes around them.
 * One more, `no-legacy-brand-name`, flags the former product name "ADE" in
 * user-facing copy (docs/brand/README.md).
 *
 * They are registered as warnings in eslint.config.mjs; `scripts/lint-ratchet.mjs`
 * (`npm run lint:ci`) fails CI only when a file's count for one of these rules
 * grows past `lint-baseline.json`. They live in a plugin, not in
 * `no-restricted-syntax`, so they never collide with the per-directory
 * `no-restricted-syntax` blocks (flat config replaces, not merges, a rule's
 * options when two blocks configure the same rule).
 *
 * Guide: docs/design/notices.md
 */

import path from "node:path";

const DOC = "See docs/design/notices.md.";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Class-string helpers whose string arguments are class lists. */
const CLASS_FNS = new Set(["cn", "clsx", "classNames", "classnames", "twMerge", "twJoin", "cx"]);
const CLASS_ATTRS = new Set(["className", "class"]);

function propertyKeyName(property) {
  if (property.type !== "Property") return null;
  if (property.key.type === "Identifier" && !property.computed) return property.key.name;
  if (property.key.type === "Literal") return String(property.key.value);
  return null;
}

/** The literal leaves a property value can take (`a`, `cond ? a : b`, `x ?? a`). */
function valueLeaves(node) {
  if (!node) return [];
  if (node.type === "ConditionalExpression") return [...valueLeaves(node.consequent), ...valueLeaves(node.alternate)];
  if (node.type === "LogicalExpression") return [...valueLeaves(node.left), ...valueLeaves(node.right)];
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") return valueLeaves(node.expression);
  if (node.type === "Literal") return [{ node, value: node.value }];
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return [{ node, value: node.quasis[0]?.value.cooked ?? "" }];
  }
  return [];
}

/** Node types a class string can pass through on its way to a className. */
const CLASS_PASS_THROUGH = new Set([
  "ConditionalExpression",
  "LogicalExpression",
  "BinaryExpression",
  "TemplateLiteral",
  "JSXExpressionContainer",
  "ArrayExpression",
  "TSAsExpression",
]);

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

/**
 * Whether a string node (Literal or TemplateElement) is a class list: it sits
 * (through ternaries, `&&`, concatenation, templates) inside a `className`
 * attribute or an argument of `cn()` / `clsx()` and friends.
 */
function isClassString(node) {
  let child = node.type === "TemplateElement" ? node.parent : node;
  let current = child.parent;
  while (current) {
    if (current.type === "JSXAttribute") {
      return current.name.type === "JSXIdentifier" && CLASS_ATTRS.has(current.name.name);
    }
    if (current.type === "CallExpression") {
      if (!current.arguments.includes(child)) return false;
      const name = calleeName(current.callee);
      return Boolean(name && CLASS_FNS.has(name));
    }
    // `a ? "x" : "y"` passes through only from its branches, not its test.
    if (current.type === "ConditionalExpression" && current.test === child) return false;
    if (!CLASS_PASS_THROUGH.has(current.type)) return false;
    child = current;
    current = current.parent;
  }
  return false;
}

/** Tokens of a class string, variant prefixes (`md:`, `!`) stripped. */
function classTokens(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^(?:[\w-]+:)*!?/, ""));
}

/** Visit every class-list string in the file. */
function classStringVisitors(check) {
  return {
    Literal(node) {
      if (typeof node.value !== "string" || !isClassString(node)) return;
      check(node, classTokens(node.value));
    },
    TemplateElement(node) {
      if (!isClassString(node)) return;
      check(node, classTokens(node.value.cooked ?? node.value.raw));
    },
  };
}

function getScope(context, node) {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  return sourceCode.getScope ? sourceCode.getScope(node) : context.getScope();
}

function isShadowed(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable && variable.defs.length > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// no-native-dialogs
// ---------------------------------------------------------------------------

const NATIVE_DIALOGS = new Set(["confirm", "alert", "prompt"]);
const WINDOW_OBJECTS = new Set(["window", "globalThis", "self"]);

const noNativeDialogs = {
  meta: {
    type: "problem",
    docs: { description: "Disallow window.confirm / alert / prompt; use ADE's dialog primitives." },
    schema: [],
    messages: {
      confirm: `Native \`{{call}}()\` blocks the renderer and ignores the app theme. Use \`await confirmDialog({ title, message, confirmLabel, destructive })\` from components/ui/dialog. ${DOC}`,
      prompt: `Native \`{{call}}()\` blocks the renderer and ignores the app theme. Use \`await promptDialog({ title, ... })\` from components/ui/dialog. ${DOC}`,
      alert: `Native \`{{call}}()\` blocks the renderer and ignores the app theme. Use \`showToast({ tone, title })\` for an event, or \`confirmDialog\` from components/ui/dialog when the user must acknowledge it. ${DOC}`,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        let name = null;
        let call = null;
        if (callee.type === "Identifier" && NATIVE_DIALOGS.has(callee.name)) {
          if (isShadowed(getScope(context, node), callee.name)) return;
          name = callee.name;
          call = callee.name;
        } else if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          WINDOW_OBJECTS.has(callee.object.name)
        ) {
          const prop = callee.computed
            ? callee.property.type === "Literal"
              ? String(callee.property.value)
              : null
            : callee.property.name;
          if (!prop || !NATIVE_DIALOGS.has(prop)) return;
          if (isShadowed(getScope(context, node), callee.object.name)) return;
          name = prop;
          call = `${callee.object.name}.${prop}`;
        }
        if (name) context.report({ node, messageId: name, data: { call } });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// no-adhoc-notice-component
// ---------------------------------------------------------------------------

const NOTICE_COMPONENT_NAME = /^[A-Z][A-Za-z0-9]*(?:Banner|Toast|Notice|Callout|Snackbar)$/;
const NOTICE_IMPORT = /(?:^|\/)(?:ui\/notice|app\/toast)(?:\/|$)/;

function isComponentInit(init) {
  if (!init) return false;
  if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") return true;
  // memo(...), forwardRef(...), React.memo(...)
  if (init.type === "CallExpression") {
    const name = calleeName(init.callee);
    return name === "memo" || name === "forwardRef";
  }
  return false;
}

const noAdhocNoticeComponent = {
  meta: {
    type: "suggestion",
    docs: { description: "A *Banner / *Toast / *Notice component must render through the shared notice primitives." },
    schema: [],
    messages: {
      adhoc: `\`{{name}}\` looks like a notice but this file imports nothing from components/ui/notice or components/app/toast. Render it through \`<Banner>\` / \`useAppBanner()\` (ui/notice) or \`showToast()\` (app/toast) instead of styling a new one. ${DOC}`,
    },
  },
  create(context) {
    let usesNoticeSystem = false;
    const candidates = [];
    const filename = context.filename ?? context.getFilename?.();
    const noteSource = (source) => {
      if (!source || typeof source.value !== "string") return;
      // Resolve relative imports against this file, so `./toast/toastStore`
      // from components/app counts the same as `../app/toast/toastStore`.
      const value = source.value;
      const resolved =
        value.startsWith(".") && filename && !filename.startsWith("<")
          ? path.resolve(path.dirname(filename), value).split(path.sep).join("/")
          : value;
      if (NOTICE_IMPORT.test(resolved)) usesNoticeSystem = true;
    };
    return {
      ImportDeclaration(node) {
        noteSource(node.source);
      },
      ExportNamedDeclaration(node) {
        noteSource(node.source);
      },
      ExportAllDeclaration(node) {
        noteSource(node.source);
      },
      ImportExpression(node) {
        noteSource(node.source);
      },
      FunctionDeclaration(node) {
        if (node.id && NOTICE_COMPONENT_NAME.test(node.id.name)) candidates.push(node.id);
      },
      ClassDeclaration(node) {
        if (node.id && NOTICE_COMPONENT_NAME.test(node.id.name)) candidates.push(node.id);
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && NOTICE_COMPONENT_NAME.test(node.id.name) && isComponentInit(node.init)) {
          candidates.push(node.id);
        }
      },
      "Program:exit"() {
        if (usesNoticeSystem) return;
        for (const id of candidates) context.report({ node: id, messageId: "adhoc", data: { name: id.name } });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// no-fixed-overlay
// ---------------------------------------------------------------------------

const noFixedOverlay = {
  meta: {
    type: "suggestion",
    docs: { description: "Disallow hand-positioned fixed overlays; use the shared hosts." },
    schema: [],
    messages: {
      style: `\`position: "fixed"\` builds a hand-rolled overlay. Banners go through \`AppBannerHost\` (useAppBanner), toasts through \`ToastViewport\` (showToast), modals through \`<Dialog>\` / confirmDialog, top-bar dropdowns through \`HeaderSheet\`. ${DOC}`,
      className: `The \`fixed\` class builds a hand-rolled overlay. Banners go through \`AppBannerHost\` (useAppBanner), toasts through \`ToastViewport\` (showToast), modals through \`<Dialog>\` / confirmDialog, top-bar dropdowns through \`HeaderSheet\`. ${DOC}`,
    },
  },
  create(context) {
    return {
      Property(node) {
        if (propertyKeyName(node) !== "position") return;
        for (const leaf of valueLeaves(node.value)) {
          if (leaf.value === "fixed") context.report({ node: leaf.node, messageId: "style" });
        }
      },
      ...classStringVisitors((node, tokens) => {
        if (tokens.includes("fixed")) context.report({ node, messageId: "className" });
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// no-raw-z-index
// ---------------------------------------------------------------------------

const Z_INDEX_FLOOR = 50;
const TW_Z_ARBITRARY = /^-?z-\[(\d+)\]$/;

const noRawZIndex = {
  meta: {
    type: "suggestion",
    docs: { description: `Disallow raw z-index values >= ${Z_INDEX_FLOOR}; use Z_LAYERS.` },
    schema: [],
    messages: {
      style: `Raw \`zIndex: {{value}}\` guesses a stacking order. Use a named layer from \`Z_LAYERS\` (components/ui/zLayers.ts: toast, sheet, floatingBanner, dialog, nestedDialog, tooltip). ${DOC}`,
      className: `Raw \`{{token}}\` guesses a stacking order. Use \`style={{ zIndex: Z_LAYERS.<layer> }}\` (components/ui/zLayers.ts). ${DOC}`,
    },
  },
  create(context) {
    return {
      Property(node) {
        if (propertyKeyName(node) !== "zIndex") return;
        for (const leaf of valueLeaves(node.value)) {
          const value = typeof leaf.value === "number" ? leaf.value : Number(leaf.value);
          if (typeof leaf.value !== "boolean" && leaf.value !== "" && Number.isFinite(value) && value >= Z_INDEX_FLOOR) {
            context.report({ node: leaf.node, messageId: "style", data: { value: String(leaf.value) } });
          }
        }
      },
      ...classStringVisitors((node, tokens) => {
        for (const token of tokens) {
          const arbitrary = TW_Z_ARBITRARY.exec(token);
          if (token === "z-50" || (arbitrary && Number(arbitrary[1]) >= Z_INDEX_FLOOR)) {
            context.report({ node, messageId: "className", data: { token } });
          }
        }
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// no-legacy-banner-import
// ---------------------------------------------------------------------------

const TOAST_LIBRARIES = ["sonner", "react-hot-toast", "@radix-ui/react-toast", "react-toastify"];
const LEGACY_BANNER = /(?:^|\/)components\/shared\/Banner(?:\.tsx?)?$/;

function isToastLibrary(source) {
  return TOAST_LIBRARIES.some((lib) => source === lib || source.startsWith(`${lib}/`));
}

function isLegacyBanner(source, filename) {
  if (LEGACY_BANNER.test(source)) return true;
  if (!source.startsWith(".") || !filename || filename.startsWith("<")) return false;
  const resolved = path.resolve(path.dirname(filename), source).split(path.sep).join("/");
  return LEGACY_BANNER.test(resolved);
}

const noLegacyBannerImport = {
  meta: {
    type: "problem",
    docs: { description: "Disallow the removed shared Banner and third-party toast libraries." },
    schema: [],
    messages: {
      banner: `components/shared/Banner was replaced. Import \`Banner\` / \`useAppBanner\` from components/ui/notice. ${DOC}`,
      toast: `\`{{source}}\` is a second toast system. Use \`showToast()\` from components/app/toast/toastStore. ${DOC}`,
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const check = (source) => {
      if (!source || typeof source.value !== "string") return;
      if (isToastLibrary(source.value)) {
        context.report({ node: source, messageId: "toast", data: { source: source.value } });
      } else if (isLegacyBanner(source.value, filename)) {
        context.report({ node: source, messageId: "banner" });
      }
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require" && node.arguments.length === 1) {
          check(node.arguments[0]);
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// no-legacy-brand-name
// ---------------------------------------------------------------------------

// The product is Daex; "ADE" is the former name. Copy reads the name from
// shared/brand.ts. Whole word, case-sensitive: `ADE_HOME`, `.ade/`, `ade://`,
// `AdeFoo` and Linear keys like `ADE-264` do not match.
const LEGACY_BRAND_WORD = /\bADE\b(?!-\d)/;

/** JSX attributes whose value is shown to the user (or read by a screen reader). */
const COPY_ATTRS = new Set([
  "title",
  "label",
  "placeholder",
  "alt",
  "description",
  "tooltip",
  "content",
  "text",
  "heading",
  "subtitle",
  "caption",
  "hint",
  "summary",
  "detail",
  "message",
  "eyebrow",
  "badge",
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-placeholder",
  "aria-valuetext",
]);
/** camelCase names that end in a copy word: `confirmLabel`, `emptyMessage`, `ariaLabel`. */
const COPY_NAME_SUFFIX = /[a-z0-9](?:Label|Title|Text|Placeholder|Tooltip|Description|Message|Hint|Caption|Heading|Subtitle|Detail|Eyebrow)$/;

function isCopyName(name) {
  return typeof name === "string" && (COPY_ATTRS.has(name) || COPY_NAME_SUFFIX.test(name));
}

/**
 * The toast / banner / dialog helpers from docs/design/notices.md. Their option
 * objects carry the words (`title`, `message`, `detail`, `confirmLabel`,
 * `actions[].label`).
 */
const NOTICE_FNS = new Set([
  "showToast",
  "updateToast",
  "confirmDialog",
  "promptDialog",
  "checkboxConfirmDialog",
  "useAppBanner",
]);

/** Node types copy passes through on its way into JSX (`a ? "x" : "y"`, `"x" + y`, templates). */
const COPY_PASS_THROUGH = new Set([
  "ConditionalExpression",
  "LogicalExpression",
  "BinaryExpression",
  "TemplateLiteral",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
]);

/** Inside an option object: nested objects and arrays (`actions: [{ label }]`). */
const OPTION_PASS_THROUGH = new Set([...COPY_PASS_THROUGH, "ObjectExpression", "ArrayExpression"]);

/**
 * Whether a string node is user-facing copy:
 * - JSX children (`<p>ADE</p>`, `<p>{cond ? "ADE" : x}</p>`);
 * - the value of a copy attribute (`title`, `aria-label`, `confirmLabel`, ...);
 * - the value of a copy key (`title:`, `label:`) in an object passed to a
 *   notice helper (`showToast({ title })`) or to any JSX attribute
 *   (`<Banner model={{ title }} />`, `<Menu items={[{ label }]} />`).
 * Everything else (constants, ids, keys, class names, paths, types) is code.
 */
function isUserFacingString(node) {
  let child = node.type === "TemplateElement" ? node.parent : node;
  let current = child.parent;
  let inCopyProperty = false;
  while (current) {
    if (current.type === "JSXElement" || current.type === "JSXFragment") return !inCopyProperty;
    if (current.type === "JSXExpressionContainer") {
      if (current.parent?.type === "JSXElement" || current.parent?.type === "JSXFragment") return !inCopyProperty;
      child = current;
      current = current.parent;
      continue;
    }
    if (current.type === "JSXAttribute") {
      if (inCopyProperty) return true;
      return current.name.type === "JSXIdentifier" && isCopyName(current.name.name);
    }
    if (current.type === "CallExpression") {
      if (!inCopyProperty || !current.arguments.includes(child)) return false;
      const name = calleeName(current.callee);
      return Boolean(name && NOTICE_FNS.has(name));
    }
    if (current.type === "ConditionalExpression" && current.test === child) return false;
    if (current.type === "BinaryExpression" && current.operator !== "+") return false;
    if (current.type === "Property") {
      if (current.value !== child) return false;
      if (!inCopyProperty) {
        if (!isCopyName(propertyKeyName(current))) return false;
        inCopyProperty = true;
      }
    } else if (!(inCopyProperty ? OPTION_PASS_THROUGH : COPY_PASS_THROUGH).has(current.type)) {
      return false;
    }
    child = current;
    current = current.parent;
  }
  return false;
}

const noLegacyBrandName = {
  meta: {
    type: "suggestion",
    docs: { description: "Disallow the former product name \"ADE\" in user-facing renderer copy; use BRAND from shared/brand." },
    schema: [],
    messages: {
      legacy:
        "\"ADE\" is the former product name. Use `BRAND.NAME` (or `BRAND.CLOUD_NAME`, `BRAND.BETA_NAME`, `BRAND.CLI`) from shared/brand instead of writing the name in copy. See docs/brand/README.md.",
    },
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text === "string" && LEGACY_BRAND_WORD.test(text) && isUserFacingString(node)) {
        context.report({ node, messageId: "legacy" });
      }
    };
    return {
      JSXText(node) {
        if (LEGACY_BRAND_WORD.test(node.value)) context.report({ node, messageId: "legacy" });
      },
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

// ---------------------------------------------------------------------------

const UI_PRIMITIVE_RULES = {
  "no-native-dialogs": noNativeDialogs,
  "no-adhoc-notice-component": noAdhocNoticeComponent,
  "no-fixed-overlay": noFixedOverlay,
  "no-raw-z-index": noRawZIndex,
  "no-legacy-banner-import": noLegacyBannerImport,
};

const plugin = {
  meta: { name: "ade-ui" },
  rules: {
    ...UI_PRIMITIVE_RULES,
    "no-legacy-brand-name": noLegacyBrandName,
  },
};

/**
 * The UI-primitive rules at "warn" — the ratchet (scripts/lint-ratchet.mjs) is
 * what fails CI. The primitives themselves are exempt from these.
 */
export const adeUiRecommendedRules = Object.fromEntries(
  Object.keys(UI_PRIMITIVE_RULES).map((name) => [`ade-ui/${name}`, "warn"]),
);

/**
 * The brand rule, also at "warn" and ratcheted. Separate from the UI-primitive
 * rules because it covers every renderer .tsx file, the primitives included.
 */
export const adeUiBrandRules = { "ade-ui/no-legacy-brand-name": "warn" };

export default plugin;
