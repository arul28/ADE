# ADE account directory Worker

Cloudflare Worker + D1 directory for account-scoped ADE machines. Clerk JWTs
are verified against the configured remote JWKS before any machine row is read
or changed.

The Worker also hosts ADE's device-authorization bridge for headless sign-in:

- `POST /device/code` creates a short-lived code bound to a daemon-generated secret.
- `GET /device` renders a read-only human-code confirmation page.
- `POST /device` confirms the code and redirects through Clerk OAuth + PKCE.
- `GET /device/callback` exchanges the Clerk code and holds the token pair briefly.
- `POST /device/token` lets the initiating daemon redeem the pair once.

Device codes and approval-attempt rate limits are stored in D1. The daemon
secret is stored only as a SHA-256 digest; approved token pairs are cleared by
the one-time redemption update or when the device code expires.

## Local checks

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` is a Wrangler dry run and does not deploy.

## Cloudflare deployment

Development and production are isolated so development Clerk users and machine
heartbeats never enter the production directory:

- Development: `https://ade-account-directory.arulsharma1028.workers.dev`
- Production: `https://ade-account-directory-production.arulsharma1028.workers.dev`

The `production` Wrangler environment binds a separate
`ade-account-directory-production` D1 database. To reproduce or move either
deployment:

1. Create the matching D1 database and put its UUID in `wrangler.jsonc`.
2. Set `CLERK_JWKS_URL`, `CLERK_ISSUER`, and
   `CLERK_OAUTH_CLIENT_ID=<your-clerk-oauth-client-id>` as Worker vars/secrets. Register
   `https://<worker-host>/device/callback` as an allowed redirect URI for the
   Clerk OAuth application. Set `WEB_CLIENT_ORIGIN` to the exact HTTPS origin
   of the hosted ADE web client; this is the only cross-origin caller allowed
   to send an account bearer to `GET /account/machines`.
3. Apply both remote migrations and deploy the Worker. Use
   `npm run d1:migrate:production` and `npm run deploy:production` for the
   production environment. Release builds use the production origin; local
   development uses the development origin. Set the machine-level
   `ADE_ACCOUNT_DIRECTORY_URL=https://<worker-host>` only for a trusted
   self-hosted override.

`ONLINE_WINDOW_MS` defaults to 90 seconds and can be adjusted as a Worker var.
