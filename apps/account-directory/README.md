# ADE account directory Worker

Cloudflare Worker + D1 directory for account-scoped ADE machines. Clerk JWTs
are verified against the configured remote JWKS before any machine row is read
or changed.

## Local checks

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` is a Wrangler dry run and does not deploy.

## Cloudflare setup (pending)

Deployment is intentionally deferred. Before a first deploy:

1. Create the `ade-account-directory` D1 database and replace the local-only
   `database_id` in `wrangler.jsonc` with its UUID.
2. Set `CLERK_JWKS_URL`, `CLERK_ISSUER`, and `CLERK_OAUTH_CLIENT_ID` as Worker
   vars/secrets.
3. Apply the remote migration and deploy the Worker.

`ONLINE_WINDOW_MS` defaults to 90 seconds and can be adjusted as a Worker var.
