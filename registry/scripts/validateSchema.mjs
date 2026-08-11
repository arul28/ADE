/**
 * The smallest JSON Schema checker that can enforce `schema/index.schema.json`.
 *
 * The crawler runs in a scheduled job with no `npm install` — a dependency
 * there is a supply-chain surface on the file every ADE install fetches — so
 * pulling in Ajv to validate one document is not available, and hand-checking
 * the fields in the crawler would be a third copy of the contract beside the
 * schema and the TypeScript parser.
 *
 * This implements exactly the keywords the index schema uses, and REFUSES a
 * keyword it does not implement (`unsupported keyword` below) rather than
 * ignoring it. That is the property that makes it safe to rely on: a future
 * schema edit reaching for something this file cannot check fails the crawl
 * loudly instead of quietly validating nothing.
 *
 * `format` is the one exception and is deliberately not enforced — it is an
 * annotation in JSON Schema 2020-12, the reading side parses dates with
 * `Date.parse`, and a stricter check here would refuse documents the app
 * accepts.
 */

const SUPPORTED = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "description",
  "type",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "maxProperties",
  "items",
  "maxItems",
  "minItems",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "format",
]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

function resolveRef(ref, root) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
  let current = root;
  for (const segment of ref.slice(2).split("/")) {
    current = current?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (current === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  }
  return current;
}

/**
 * Every way `value` fails `schema`, as human-readable paths. An empty array
 * means the document is valid under the subset described above.
 */
export function validateAgainstSchema(value, schema, root = schema, path = "") {
  const problems = [];
  if (typeof schema === "boolean") {
    return schema ? problems : [`${path || "value"} is not allowed here`];
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`unsupported keyword "${keyword}" at ${path || "root"}`);
  }
  const at = path || "value";

  if (schema.$ref) {
    return validateAgainstSchema(value, resolveRef(schema.$ref, root), root, path);
  }
  if (schema.type && !matchesType(value, schema.type)) {
    return [`${at} should be ${schema.type}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${at} should be one of ${schema.enum.join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      problems.push(`${at} does not match ${schema.pattern}`);
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      problems.push(`${at} is shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      problems.push(`${at} is longer than ${schema.maxLength}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      problems.push(`${at} is below ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      problems.push(`${at} is above ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      problems.push(`${at} holds ${value.length} items, above ${schema.maxItems}`);
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problems.push(`${at} holds ${value.length} items, below ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        problems.push(...validateAgainstSchema(item, schema.items, root, `${at}[${index}]`));
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) problems.push(`${at} is missing "${required}"`);
    }
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
      problems.push(`${at} holds ${keys.length} properties, above ${schema.maxProperties}`);
    }
    for (const key of keys) {
      if (schema.propertyNames) {
        problems.push(...validateAgainstSchema(key, schema.propertyNames, root, `${at} key "${key}"`));
      }
      const child = schema.properties?.[key];
      if (child !== undefined && Object.hasOwn(schema.properties, key)) {
        problems.push(...validateAgainstSchema(value[key], child, root, `${at}.${key}`));
        continue;
      }
      if (schema.additionalProperties === false) {
        problems.push(`${at} has an unexpected property "${key}"`);
        continue;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        problems.push(...validateAgainstSchema(value[key], schema.additionalProperties, root, `${at}.${key}`));
      }
    }
  }

  return problems;
}
