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
