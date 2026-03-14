# ADE Web

Marketing site + download page for ADE (Agentic Development Environment).

## Dev

```bash
cd apps/web
npm install
npm run dev
```

If `npm install` fails due to cache permissions, use a repo-local cache:

```bash
cd apps/web
npm install --cache ../../.npm-cache
```

## Build

```bash
cd apps/web
npm run build
npm run preview
```
