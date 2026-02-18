#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-}"

if [[ -z "${TARGET_DIR}" ]]; then
  echo "usage: $(basename "$0") <target-dir>" >&2
  exit 2
fi

mkdir -p "${TARGET_DIR}"
cd "${TARGET_DIR}"

if [[ -n "$(ls -A . 2>/dev/null || true)" ]]; then
  echo "error: target dir is not empty: ${TARGET_DIR}" >&2
  exit 2
fi

git init -b main >/dev/null

mkdir -p src test .github/workflows .claude/commands

cat > README.md <<'EOF'
# conflict-cafe

A deliberately tiny Node app designed to create predictable merge conflicts for ADE demos.

## Run

```bash
npm test
node src/server.js
```

## Workshop Notes

Most lanes will touch:
- `src/receipt.js`
- `src/router.js`

That is intentional: the guided activity is about conflict prediction + resolution, not writing lots of code.
EOF

cat > package.json <<'EOF'
{
  "name": "conflict-cafe",
  "private": true,
  "version": "0.0.0",
  "description": "Tiny app designed to create predictable merge conflicts for ADE demos",
  "scripts": {
    "dev": "node src/server.js",
    "test": "node --test"
  }
}
EOF

cat > .gitignore <<'EOF'
node_modules
.ade
.DS_Store
EOF

cat > .github/workflows/ci.yml <<'EOF'
name: ci
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install
      - run: npm test
EOF

cat > .claude/commands/getContext.md <<'EOF'
---
name: "get context"
description: "Summarize the current repo state + active work for this demo app"
---

# getContext (demo)

Summarize:
- What the app does
- The current `src/receipt.js` behavior
- Any active conflicts (if present)
- Suggested next step for the guided activity
EOF

cat > .claude/commands/finalize.md <<'EOF'
---
name: "finalize"
description: "Generate a final summary for the conflict-cafe workshop"
---

# finalize (demo)

Write:
- What changed across lanes
- How conflicts were resolved
- What integration methods were used
EOF

cat > src/receipt.js <<'EOF'
"use strict";

function formatMoneyCents(cents) {
  // Intentionally naive: multiple lanes will modify this function.
  return `$${(cents / 100).toFixed(2)}`;
}

function buildReceipt(order, opts) {
  // Intentionally simple: multiple lanes will touch the same lines to force conflicts.
  const requestId = opts && opts.requestId ? String(opts.requestId) : null;
  const theme = (opts && opts.theme) || "classic";

  const banner = `=== Conflict Cafe (${theme}) ===`;
  const lines = [banner];
  if (requestId) lines.push(`Request: ${requestId}`);

  const subtotalCents = order.qty * order.priceCents;

  lines.push(`Item: ${order.item} x${order.qty} @ ${formatMoneyCents(order.priceCents)}`);
  lines.push(`Subtotal: ${formatMoneyCents(subtotalCents)}`);
  lines.push("Thanks for visiting Conflict Cafe.");

  return `${lines.join("\n")}\n`;
}

module.exports = {
  formatMoneyCents,
  buildReceipt
};
EOF

cat > src/router.js <<'EOF'
"use strict";

const { buildReceipt } = require("./receipt");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function parseJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    e.name = "BadJson";
    throw e;
  }
}

function send(res, statusCode, body, headers) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    ...headers
  });
  res.end(body);
}

function normalizeOrder(input) {
  const item = typeof input.item === "string" && input.item.trim() ? input.item.trim() : "coffee";
  const qty = Number.isFinite(input.qty) ? input.qty : Number.parseInt(String(input.qty || "1"), 10);
  const normalizedQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
  const priceCents = Number.isFinite(input.priceCents)
    ? input.priceCents
    : Number.parseInt(String(input.priceCents || "450"), 10);
  const normalizedPrice = Number.isFinite(priceCents) && priceCents > 0 ? priceCents : 450;

  return { item, qty: normalizedQty, priceCents: normalizedPrice };
}

async function handleOrder(req, res) {
  const payload = await parseJson(req);
  const order = normalizeOrder(payload);

  // Most lanes will change the option shape here (locale, coupon, tax, etc.).
  const receipt = buildReceipt(order, { theme: "classic", requestId: null });
  send(res, 200, receipt, {});
}

const ROUTES = {
  "GET /health": async (_req, res) => send(res, 200, "ok\n", {}),
  "POST /order": handleOrder
};

async function route(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const key = `${(req.method || "GET").toUpperCase()} ${url.pathname}`;
  const handler = ROUTES[key];
  if (!handler) return send(res, 404, "not found\n", {});

  try {
    await handler(req, res);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return send(res, 500, `${message}\n`, {});
  }
}

module.exports = {
  route,
  normalizeOrder
};
EOF

cat > src/server.js <<'EOF'
"use strict";

const http = require("node:http");
const { route } = require("./router");

const port = Number.parseInt(process.env.PORT || "8787", 10);

const server = http.createServer((req, res) => {
  void route(req, res);
});

server.listen(port, "127.0.0.1", () => {
  // Intentionally simple stdout for ADE terminal transcript + session delta.
  // curl example:
  //   curl -sS -X POST http://127.0.0.1:8787/order -d '{"item":"tea","qty":2,"priceCents":300}'
  console.log(`conflict-cafe listening on http://127.0.0.1:${port}`);
});
EOF

cat > test/receipt.test.js <<'EOF'
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReceipt } = require("../src/receipt");

test("buildReceipt prints a stable baseline receipt", () => {
  const receipt = buildReceipt({ item: "coffee", qty: 2, priceCents: 450 }, { theme: "classic", requestId: null });
  assert.match(receipt, /Conflict Cafe/);
  assert.match(receipt, /Item: coffee x2/);
  assert.match(receipt, /Subtotal: \$9\.00/);
});
EOF

cat > test/router.test.js <<'EOF'
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOrder } = require("../src/router");

test("normalizeOrder applies defaults and basic validation", () => {
  assert.deepEqual(normalizeOrder({}), { item: "coffee", qty: 1, priceCents: 450 });
  assert.deepEqual(normalizeOrder({ item: "tea", qty: 0, priceCents: -5 }), { item: "tea", qty: 1, priceCents: 450 });
});
EOF

git add -A
git commit -m "init conflict-cafe baseline" >/dev/null

echo "ok: created conflict-cafe repo at ${TARGET_DIR}"
echo "next:"
echo "  cd ${TARGET_DIR}"
echo "  npm test"
