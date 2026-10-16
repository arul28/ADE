// Small XML helpers shared by the office parsers.
//
// OOXML documents use namespaces (`x:`, `p:`, `a:`, `r:`), and different
// producers prefix the same element differently (some write `p:sp`, some `sp`).
// Every lookup here matches on the LOCAL name through `getElementsByTagNameNS`,
// which is prefix-independent and skips the manual `querySelectorAll("*")`
// scans the reference implementations used.

/** Parse a small OOXML document. Returns null when the text is not valid XML. */
export function parseXml(text: string): Document | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch {
    return null;
  }
  // DOMParser does not throw on malformed XML: it returns a document with a
  // <parsererror> element, which is how a broken part is detected here.
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc;
}

/** Every descendant element with this local name. */
export function elementsNS(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", localName));
}

/** The first descendant element with this local name, or null. */
export function firstElementNS(root: Document | Element, localName: string): Element | null {
  const all = root.getElementsByTagNameNS("*", localName);
  return all.length > 0 ? all[0]! : null;
}

/**
 * The value of an attribute regardless of namespace prefix, for the common
 * case where the same attribute is written `r:id` by one producer and `id` by
 * another.
 */
export function attributeAnyNS(element: Element | null, localName: string): string | null {
  if (!element) return null;
  for (const attr of Array.from(element.attributes)) {
    if (attr.localName === localName || attr.name === localName) return attr.value;
  }
  return null;
}

const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * The relationship id on an element (`r:id`, `r:embed`, `r:link`).
 *
 * Matched by NAMESPACE, not by the literal `r:` prefix: the OOXML spec binds
 * the relationships namespace to whichever prefix a producer chose, and
 * `getAttribute("r:embed")` silently returns null for a document that wrote
 * `rel:embed`. A null here would present as an empty slide.
 */
export function relationshipId(element: Element | null, localName: "id" | "embed" | "link"): string | null {
  if (!element) return null;
  const byNamespace = element.getAttributeNS(RELATIONSHIPS_NS, localName);
  if (byNamespace) return byNamespace;
  const literal = element.getAttribute(`r:${localName}`);
  return literal || null;
}

const ENTITY_RE = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g;

/**
 * Decode the XML entities that can appear in element text.
 *
 * Needed by the scanners that read large parts (shared strings, worksheet
 * bodies) without DOMParser: those work on the raw XML text, where `&amp;`
 * would otherwise reach the user as literal text. `&<>` are appended rather
 * than looked up because they are the ones that collide with regex output.
 */
export function decodeXmlEntities(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(ENTITY_RE, (_match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (hex) return safeCodePoint(parseInt(hex, 16));
    if (dec) return safeCodePoint(parseInt(dec, 10));
    switch (named) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: return "";
    }
  });
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** 0-based column index of an A1-style reference ("A" → 0, "AA" → 26). */
export function columnIndexFromRef(ref: string): number {
  let index = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) return -1;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

/** 1-based row number parsed out of an A1-style reference, or -1. */
export function rowNumberFromRef(ref: string): number {
  const digits = /^[A-Za-z]+(\d+)$/.exec(ref);
  if (!digits) return -1;
  const row = Number(digits[1]);
  return Number.isFinite(row) ? row : -1;
}

/** Defer to the event loop so a long scan cannot block a frame for long. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
