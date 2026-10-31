# Scripts

## Supported test suite

Run from the repository root:

```powershell
npm test
```

`test_p0_security.js` is the supported regression suite. It uses a temporary
database file, never calls Supabase, and covers authentication, ownership,
idempotent money paths, deposit approval/reconciliation, webhook signatures,
PIN hashing, and paise-exact money arithmetic.

`test_ledger_authority.js` verifies the server-authoritative ledger: hostile
Supabase metadata cannot mint balance or bypass a PIN, sync payloads contain no
financial fields, ledger credits are idempotent, and reconciliation matches.

`test_deposit_safety.js` verifies that deposits never fall back to a user
wallet, that a missing official wallet fails closed, and that USDT gateways stay
disabled until a real, valid receiving address is configured.

`test_admin_auth.js` verifies that admin access fails closed without a strong
`ADMIN_KEY`, rejects the old public default, and only accepts correctly signed,
unexpired session tokens. The verification-panel test also confirms that the key
is ignored when supplied in the query string.

`test_state_store.js` runs the real engine in child processes against a local
PostgREST mock. It covers first-boot seeding, reloading balances from Supabase
after deleting the local cache, fail-closed startup on read/write outages, the
durability gate for failed writes, the untouched file backend, and production
startup rejection when the service-role key is missing. It never contacts a real
Supabase project.

## Legacy scripts

The remaining `test_*.js` files were written against the old unauthenticated
demo API. They assume public order mutations, six-digit/placeholder UTRs, and
demo tokens, so they no longer represent supported behavior.

`test_order_flow.js` and `test_qr_views.js` refuse to run unless explicitly
opted in:

```powershell
$env:ALLOW_LEGACY_SCRIPTS = "true"
node scripts/test_qr_views.js
```

Only do that against a local server. Never run legacy scripts against
production or with real user data. Scripts that talk to Supabase also require
`SUPABASE_URL` and `SUPABASE_KEY`; they no longer contain a project key.

## APK analysis tools

`analyze_apk.py`, `dump_*.py`, `inspect_*.py`, and `scan_tables.js` are
reverse-engineering helpers for `linkpay.apk`. They are not part of the test
suite.
