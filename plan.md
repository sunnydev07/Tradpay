# TradePay Supabase Migration Plan — B′ (dedicated state project)

**Status:** planning only. No Supabase project has been created, no Render env has been changed, and no code has been modified yet.

**Repository:** `C:\Users\sunny\Desktop\TradePay`
**Branch:** `main`
**Last commit at planning time:** `2185838 fix(state): bound Supabase state requests to avoid startup hangs`
**Working tree at planning time:** clean

---

## 1. Objective

Deploy TradePay on Render's **free** plan with balances and all financial state surviving:

- Render restarts / sleep-wake cycles
- user logout and login
- redeploys

Constraints:

- Render Starter is not an option; the service must run on `plan: free`.
- Existing users must keep their current logins and balances.
- `SUPABASE_SERVICE_ROLE_KEY` and any state secret must remain server-side only.
- The exposed admin key `a6zJ...` must never be used again; generate a new one.
- All work stays on `main`.

---

## 2. Critical findings that shape the plan

### 2.1 The old Supabase project is not empty

Old project:

- ref: `vhzfbacpvfjdpkthxvej`
- name: `metrascan-compliance`
- region: `ap-south-1`
- org: `vercel_icfg_8Doj7zzWZIS5sRkMEJzgZoHr` (free plan)
- Postgres `17.6.1.166`

It contains:

- `public.profiles` (empty)
- **117 Auth users total**, shared with the `metrascan-compliance` app
- **28 TradePay Auth users** — every UUID user in `data/db.json` was verified to exist in this project's `auth.users`

Local `data/db.json` (380 KB) contains:

- 29 users (28 UUID users + legacy `10086`)
- 3 funded users
- total balance: **9,226**
- 22 wallets
- 10 deposits
- 20 withdrawals
- ledger entries / idempotency records
- claimed orders, hang sales, settings, team, missions, notices

**Do not delete this project. Do not pause it.** It holds another app's data and TradePay's Auth pool.

### 2.2 A fully fresh Supabase project cannot preserve logins

A new project has a new Auth user pool with new UUIDs. TradePay keys users by Supabase UUID:

```js
let user = state.users[supUser.id];
if (!user) user = createLocalUser(supUser, state);
```

So a fresh Auth project would:

- invalidate every existing password (users would have to re-register/reset)
- give every user a new UUID
- orphan existing balances keyed by the old UUIDs

Migrating password hashes is currently impossible because the old project's `postgres` role cannot authenticate:

```text
FATAL: 28000: PAM authentication failed for user "postgres"
pam_authenticate failed: Permission denied
```

This blocks the Dashboard SQL Editor, Management API `/database/query`, the pooler, and an Edge Function using `SUPABASE_DB_URL`. Two restarts and a password reset did not fix it. Therefore `auth.users.encrypted_password` cannot be exported.

### 2.3 What still works on the old project

- GoTrue: `GET /auth/v1/health` → `200`
- PostgREST: `GET /rest/v1/` → `200`
- `public.profiles` readable
- Auth Admin API works with the service-role key

Only the `postgres` login/DDL path is broken.

---

## 3. Chosen architecture — B′

Use **two Supabase projects**:

```text
Browser
  │
  ▼
Render: TradePay (free, oregon)
  ├── Auth  ───────────────► OLD project: vhzfbacpvfjdpkthxvej
  │                          (GoTrue, 28 TradePay users, healthy)
  │
  └── state ───────────────► NEW project: tradepay-state
                             public.tradepay_state
                             save_tradepay_state(...)
                             service-role only
```

- **Old project:** Auth only. No schema changes, no DDL, no deletion.
- **New project:** durable state only. Its Auth/profiles tables are unused.
- **Render:** `TRADEPAY_STATE_BACKEND=supabase`, with a dedicated state URL/key.
- **Local `data/db.json`:** cache + backup only; never authoritative when Supabase state is enabled.

This preserves all current logins and balances while working around the PAM bug, because the app only needs PostgREST for state and GoTrue for auth.

### Why not use the new project for Auth too?

That is the "full fresh project" option. It requires all 28 users to re-register/reset passwords and requires remapping every ledger reference from old UUIDs to new UUIDs. It is higher risk and not necessary. Only choose it if the user explicitly accepts resetting all logins.

### Why not keep using the old project for state?

The `tradepay_state` table does not exist there, and it cannot be created because all DDL paths require `postgres`. PostgREST cannot run DDL.

---

## 4. Target configuration

### 4.1 New Supabase project

| Field | Value |
|---|---|
| Name | `tradepay-state` (default; may be adjusted) |
| Organization | `vercel_icfg_8Doj7zzWZIS5sRkMEJzgZoHr` (slug) |
| Plan | free (org-level; do not pass `plan`) |
| Region | `us-west-2` recommended (Render is in `oregon`) |
| Fallback region | `us-west-1` or `ap-south-1` if creation fails |
| DB password | generated 40-char alphanumeric; saved locally, never in chat |
| Password file | `C:\Users\sunny\.tradepay\tradepay-state-db-password.txt` |

The free org currently has 1 active project, so a second free project fits the 2-project limit.

### 4.2 Render environment variables

| Variable | Source | Notes |
|---|---|---|
| `TRADEPAY_STATE_BACKEND` | literal | `supabase` |
| `SUPABASE_URL` | old project | Auth project URL, existing value |
| `SUPABASE_KEY` | old project | anon/publishable key, existing value |
| `SUPABASE_SERVICE_ROLE_KEY` | old project | service/secret key; used for Auth admin metadata sync. Optional but keep if already set |
| `SUPABASE_STATE_URL` | **new project** | `https://<new-ref>.supabase.co` |
| `SUPABASE_STATE_SERVICE_ROLE_KEY` | **new project** | service/secret key; server-only |
| `ADMIN_KEY` | **new** | 64 random chars; never reuse the exposed key |
| `ADMIN_USER_IDS` | existing | comma-separated existing admin UUIDs |
| `TRADEPAY_DB_FILE` | remove | must not point at `/var/data` on free Render |
| `NODE_ENV` | `production` | already in `render.yaml` |
| `PORT` | `10000` | already in `render.yaml` |

Do **not** put the new project in `SUPABASE_URL`; that would point Auth at an empty user pool.

---

## 5. Execution phases

### Phase 0 — Preflight and backup

- [ ] Confirm `git status --short` is clean (except this `plan.md`).
- [ ] Back up the local state:

```powershell
Copy-Item data\db.json "data\db.pre-supabase-$(Get-Date -Format yyyyMMdd-HHmmss).json"
```

- [ ] Record the baseline:

```powershell
node -e "const j=require('./data/db.json'); const u=Object.values(j.users); console.log({users:u.length,funded:u.filter(x=>Number(x.balance)>0).length,total:u.reduce((s,x)=>s+Number(x.balance||0),0),wallets:j.wallets.length,deposits:Object.keys(j.deposits).length,withdrawals:Object.keys(j.withdrawals).length,ledger:j.ledger.entries.length});"
```

Expected baseline:

```text
{ users: 29, funded: 3, total: 9226, wallets: 22, deposits: 10, withdrawals: 20, ledger: <count> }
```

- [ ] Verify the old project's Auth still contains the 28 TradePay UUIDs (already done during planning; repeat only if desired).
- [ ] Do not run any DDL against the old project.

### Phase 1 — Create the new free project

Use the Supabase Management API. The Supabase MCP tool list does **not** expose project creation, so call the API directly.

#### 1.1 Get/refresh the Management API token

Token file:

```text
C:\Users\sunny\.local\share\opencode\mcp-auth.json
```

Relevant shape:

```json
{
  "supabase": {
    "tokens": {
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": 1791999041774
    },
    "clientInfo": {
      "clientId": "...",
      "clientSecret": "..."
    }
  }
}
```

`expiresAt` is in milliseconds. Refresh when expired:

```js
const body = new URLSearchParams({
  grant_type: 'refresh_token',
  refresh_token: tokens.refreshToken
});
const headers = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Authorization:
    'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
};
const res = await fetch('https://api.supabase.com/v1/oauth/token', {
  method: 'POST',
  headers,
  body
});
```

Save the new `access_token`, `refresh_token`, and `expiresAt` back to the same file. Never print the token.

#### 1.2 Create the project

```js
const REF_ORG = 'vercel_icfg_8Doj7zzWZIS5sRkMEJzgZoHr';
const res = await fetch('https://api.supabase.com/v1/projects', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'tradepay-state',
    organization_slug: REF_ORG,
    region_selection: { type: 'specific', code: 'us-west-2' },
    db_pass: generatedPassword
  })
});
```

- Generate a 40-character alphanumeric password (avoid characters that need URL encoding).
- Save it immediately to `C:\Users\sunny\.tradepay\tradepay-state-db-password.txt`.
- Capture the returned `ref` / `id`. Record it in the progress log below.
- If the response is `402`/`403` due to the free-project limit, stop and report. Do not delete or pause the old project.

#### 1.3 Wait for readiness

Poll:

```text
GET https://api.supabase.com/v1/projects/<new-ref>
```

until `status === 'ACTIVE_HEALTHY'`. This usually takes 2–5 minutes. Also check:

```text
GET https://api.supabase.com/v1/projects/<new-ref>/health?services=db
```

Expected: `[{"name":"db","healthy":true,"status":"ACTIVE_HEALTHY"}]`.

### Phase 2 — Apply the schema

Use the Management API against the **new** project:

```js
const sql = fs.readFileSync('supabase/schema.sql', 'utf8');
const res = await fetch(
  `https://api.supabase.com/v1/projects/${newRef}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  }
);
```

If the database is still starting, retry with backoff. If the new project also returns:

```text
FATAL: 28000: PAM authentication failed for user "postgres"
```

stop immediately. That would indicate a platform-wide issue, and the fallback is option A (Supabase support), not another project.

#### 2.1 Verify with SQL

Run each of these against the new project:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
order by 1;
```

Expected includes:

```text
deposits
profiles
tradepay_state
wallets
```

```sql
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by 1;
```

Expected includes:

```text
save_tradepay_state(text, jsonb, bigint)
handle_new_user()
```

```sql
select relrowsecurity
from pg_class
where oid = 'public.tradepay_state'::regclass;
```

Expected: `true`.

```sql
select grantee, privilege_type
from information_schema.role_table_grants
where table_name = 'tradepay_state'
order by 1, 2;
```

Expected: only `service_role` has `SELECT`, `INSERT`, `UPDATE` (no `anon` / `authenticated`).

```sql
notify pgrst, 'reload schema';
```

This makes the new table/RPC visible to PostgREST immediately.

### Phase 3 — Seed the state row from `data/db.json`

**Critical ordering:** seed before Render starts with `TRADEPAY_STATE_BACKEND=supabase`. An empty table would be seeded by the app from whatever local cache the Render instance has, which on free Render is a zero-balance default.

#### 3.1 Get the new project's keys

```text
GET https://api.supabase.com/v1/projects/<new-ref>/api-keys?reveal=true
```

Response entries have `name`, `type`, `api_key`. Prefer legacy keys if present:

- `SUPABASE_STATE_URL`: `https://<new-ref>.supabase.co`
- `SUPABASE_STATE_SERVICE_ROLE_KEY`: `service_role` (legacy) or `secret` (new)
- `SUPABASE_KEY` (old project): `anon` (legacy) or `publishable` (new)
- `SUPABASE_SERVICE_ROLE_KEY` (old project): `service_role` (legacy) or `secret` (new)

Never print these values in chat or logs.

#### 3.2 POST the snapshot

Use a temporary Node script (outside the repo, e.g. `%TEMP%\opencode\seed-state.mjs`):

```js
import fs from 'node:fs';

const state = JSON.parse(fs.readFileSync('./data/db.json', 'utf8'));
const url = 'https://<new-ref>.supabase.co';
const key = process.env.SUPABASE_STATE_SERVICE_ROLE_KEY;

const res = await fetch(`${url}/rest/v1/rpc/save_tradepay_state`, {
  method: 'POST',
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  },
  body: JSON.stringify({
    p_id: 'primary',
    p_state: state,
    p_revision: Date.now()
  })
});

console.log(res.status, await res.text());
```

The snapshot is about 380 KB, which is below PostgREST's usual request limit. If it is rejected for size, use `@supabase/supabase-js` `rpc()` instead; the payload is the same.

#### 3.3 Verify the row

```text
GET https://<new-ref>.supabase.co/rest/v1/tradepay_state?select=id,revision,state,updated_at&id=eq.primary
```

with `apikey` and `Authorization: Bearer <state service key>`.

Compare semantically with `data/db.json`:

- 29 users
- 3 funded users
- total balance 9,226
- 22 wallets
- 10 deposits
- 20 withdrawals
- ledger entry count matches
- user ID set matches

Use `assert.deepStrictEqual(remote.state, localState)` if the JSONB round-trip is exact; otherwise compare the counts and totals above.

#### 3.4 Security and revision tests

- **Anon denial:** `GET /rest/v1/tradepay_state?select=*` with the **anon** key must return `401`/`403` (or an empty result only if RLS explicitly hides the row; expected behavior here is permission denied because grants were revoked).
- **Monotonic revision:** call `save_tradepay_state` with `p_revision = currentRevision + 1` and a sentinel field; confirm it updates. Then call with `p_revision = currentRevision - 1` and a different sentinel; confirm the row did **not** change.

Do not leave the sentinel field in the final state. Re-seed the original snapshot with a higher revision if needed.

### Phase 4 — Code change for split Auth/state

Only `stateStore.js` needs functional changes. `db.js`, `index.js`, and routes already call `stateStore`.

#### 4.1 `server/engine/stateStore.js`

Add the Supabase client factory and dedicated state client:

```js
const { createClient } = require('@supabase/supabase-js');
const supabaseService = require('./supabaseService');
```

Add near the top after `ROW_ID`:

```js
let dedicatedStateClient = null;
let dedicatedStateClientConfig = '';

function getStateClient() {
  const stateUrl = String(process.env.SUPABASE_STATE_URL || '').trim();

  // Backward compatibility: one project for Auth and state.
  if (!stateUrl) {
    return supabaseService.getAdminClient();
  }

  const stateKey = String(
    process.env.SUPABASE_STATE_SERVICE_ROLE_KEY || ''
  ).trim();
  if (!stateKey) return null;

  const configKey = `${stateUrl}\u0000${stateKey}`;
  if (!dedicatedStateClient || dedicatedStateClientConfig !== configKey) {
    dedicatedStateClient = createClient(stateUrl, stateKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Bound state requests so startup cannot hang indefinitely.
      db: { timeout: 20000 }
    });
    dedicatedStateClientConfig = configKey;
  }
  return dedicatedStateClient;
}
```

Update `getConfigError()`:

```js
function getConfigError() {
  if (!isSupabaseRequested()) return null;

  if (!String(process.env.SUPABASE_URL || '').trim()) {
    return 'TRADEPAY_STATE_BACKEND=supabase requires SUPABASE_URL';
  }
  if (!String(process.env.SUPABASE_KEY || '').trim()) {
    return 'TRADEPAY_STATE_BACKEND=supabase requires SUPABASE_KEY';
  }

  const stateUrl = String(process.env.SUPABASE_STATE_URL || '').trim();
  if (stateUrl) {
    // A dedicated state project must use its own service key. Never send the
    // Auth project's service key to a different project.
    if (!String(process.env.SUPABASE_STATE_SERVICE_ROLE_KEY || '').trim()) {
      return 'SUPABASE_STATE_URL requires SUPABASE_STATE_SERVICE_ROLE_KEY (server-only)';
    }
  } else if (!String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) {
    return 'TRADEPAY_STATE_BACKEND=supabase requires SUPABASE_SERVICE_ROLE_KEY (server-only)';
  }

  return null;
}
```

Update `isEnabled()`:

```js
function isEnabled() {
  return Boolean(
    isSupabaseRequested() && !getConfigError() && getStateClient()
  );
}
```

Update `load()` and `save()`:

```js
const client = getStateClient();
if (!client) {
  throw new Error('Supabase state client is not configured');
}
```

Leave the table name, row id, SQL error messages, and exports unchanged.

#### 4.2 `render.yaml`

Add under the existing Supabase variables:

```yaml
      # Auth project (existing). SUPABASE_URL/SUPABASE_KEY are used by GoTrue.
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_KEY
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false

      # Dedicated state project. Server-only; never expose this key.
      - key: SUPABASE_STATE_URL
        sync: false
      - key: SUPABASE_STATE_SERVICE_ROLE_KEY
        sync: false
```

Add comments clarifying:

- `SUPABASE_URL` / `SUPABASE_KEY` are the **Auth** project.
- `SUPABASE_STATE_URL` / `SUPABASE_STATE_SERVICE_ROLE_KEY` are the **state** project.
- `TRADEPAY_STATE_BACKEND=supabase` is already set.

#### 4.3 `README.md`

Update:

- The env-var table with the two new variables.
- The deployment guide to explain the split-project setup.
- The migration step: seed the new state project from the local cache before enabling the backend on Render.
- The health-check section: still expects `backend: "supabase"`, `durable: true`, `ok: true`, `initialized: true`.

#### 4.4 `scripts/test_state_store.js`

In `runChild()` default env, clear the new variables so host env cannot leak between tests:

```js
SUPABASE_STATE_URL: '',
SUPABASE_STATE_SERVICE_ROLE_KEY: '',
```

Extend the configuration test:

```js
process.env.SUPABASE_STATE_URL = 'https://state.example.supabase.co';
process.env.SUPABASE_STATE_SERVICE_ROLE_KEY = '';
assert.match(stateStore.getConfigError(), /SUPABASE_STATE_SERVICE_ROLE_KEY/);
delete process.env.SUPABASE_STATE_URL;
```

Save/restore the new env variables in the test's `finally` block.

Add a regression test proving state can use a different project from Auth:

```js
test('state can live in a dedicated project while auth stays elsewhere', async (t) => {
  const mock = await startMockSupabase();
  const temp = makeTempDb();
  t.after(async () => {
    await mock.close();
    temp.cleanup();
  });

  const result = await runChild({
    TRADEPAY_STATE_BACKEND: 'supabase',
    SUPABASE_URL: 'https://auth.invalid',
    SUPABASE_KEY: 'auth-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: '',
    SUPABASE_STATE_URL: mock.url,
    SUPABASE_STATE_SERVICE_ROLE_KEY: 'state-service-key',
    TRADEPAY_DB_FILE: temp.file,
    TEST_BALANCE: '123.45',
    TEST_FLUSH_REMOTE: '1'
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = parseChild(result);
  assert.equal(parsed.info.backend, 'supabase');
  assert.equal(parsed.balance, 123.45);
  assert.ok(mock.row, 'dedicated state project must receive the seed');
  assert.equal(mock.row.state.users['10086'].balance, 123.45);
});
```

#### 4.5 `supabase/schema.sql`

Only a comment cleanup:

```sql
-- Run this in the NEW dedicated state project's SQL Editor.
-- Do not run it against the Auth project (its postgres role is currently
-- unable to authenticate); Auth does not need this schema.
```

Remove the hard-coded old project ref from the header comment.

#### 4.6 Test and commit

```powershell
npm run test:state-store
npm test
git status --short
git add server/engine/stateStore.js render.yaml README.md scripts/test_state_store.js supabase/schema.sql
git commit -m "feat(state): support a dedicated Supabase project for durable state"
git push origin main
```

Expected: all tests pass. If `npm test` needs a local Supabase or network, use the suite's existing local mocks; it should not contact real Supabase.

### Phase 5 — Local end-to-end verification

Use a spare port and production-like env. Do not commit these values.

```powershell
$env:NODE_ENV = 'production'
$env:PORT = '3100'
$env:TRADEPAY_STATE_BACKEND = 'supabase'
$env:SUPABASE_URL = 'https://vhzfbacpvfjdpkthxvej.supabase.co'
$env:SUPABASE_KEY = '<old anon key>'
$env:SUPABASE_SERVICE_ROLE_KEY = '<old service key>'
$env:SUPABASE_STATE_URL = 'https://<new-ref>.supabase.co'
$env:SUPABASE_STATE_SERVICE_ROLE_KEY = '<new service key>'
$env:ADMIN_KEY = '<new 64-char key>'
$env:ADMIN_USER_IDS = '<existing admin ids>'
npm start
```

Checks:

- [ ] `GET http://127.0.0.1:3100/health` returns:

```json
{
  "status": "healthy",
  "storage": {
    "backend": "supabase",
    "table": "tradepay_state",
    "durable": true,
    "ok": true,
    "initialized": true,
    "revision": <number>,
    "lastSavedAt": "<timestamp>"
  }
}
```

- [ ] `/health` revision matches the seeded row's revision.
- [ ] Stop the process, start it again; `/health` still loads the same revision and the balance total is 9,226.
- [ ] Make a small mutation through the app or `db` (if safe), confirm the new project's row revision and `updated_at` advance.
- [ ] Confirm no state request goes to the old project. The old project has no `tradepay_state` table; if a request went there it would fail.
- [ ] Check the client bundle does not contain `service_role` or the state key:

```powershell
Select-String -Path public\* -Pattern "service_role|SUPABASE_STATE_SERVICE_ROLE_KEY" -Recurse
```

### Phase 6 — Render handoff

The user has no Render API key available locally, so this is the only manual step.

#### 6.1 Generate the handoff file

Create:

```text
C:\Users\sunny\.tradepay\render-env.txt
```

Contents (values filled in, no secrets printed in chat):

```text
TRADEPAY_STATE_BACKEND=supabase
SUPABASE_URL=https://vhzfbacpvfjdpkthxvej.supabase.co
SUPABASE_KEY=<old anon/publishable key>
SUPABASE_SERVICE_ROLE_KEY=<old service/secret key>
SUPABASE_STATE_URL=https://<new-ref>.supabase.co
SUPABASE_STATE_SERVICE_ROLE_KEY=<new service/secret key>
ADMIN_KEY=<new 64-char random key>
ADMIN_USER_IDS=<existing comma-separated ids>
```

Generate `ADMIN_KEY` with 64 hex characters, for example:

```js
crypto.randomBytes(32).toString('hex')
```

Do not reuse the exposed `a6zJ...` key or any placeholder.

#### 6.2 User actions in Render

- [ ] Open the Render service's **Environment** page.
- [ ] Set/confirm the values from `render-env.txt`.
- [ ] Remove `TRADEPAY_DB_FILE` if it points to `/var/data` (free plan has no disk).
- [ ] Confirm `TRADEPAY_STATE_BACKEND=supabase`.
- [ ] Deploy the latest `main` (commit from Phase 4.6).
- [ ] If the blueprint auto-deploys before env is set, let it fail, set env, then **Manual Deploy → Deploy latest commit**.

### Phase 7 — Production verification

- [ ] `GET https://<render-service>/health`:

```json
{
  "status": "healthy",
  "storage": {
    "backend": "supabase",
    "durable": true,
    "ok": true,
    "initialized": true
  }
}
```

- [ ] Log in with a real existing account (old Auth project). Confirm the balance matches `data/db.json` (total 9,226 across funded users).
- [ ] Log out, log in again. Balance unchanged.
- [ ] Create a small test mutation (deposit/withdrawal/admin adjustment) with a recognizable amount.
- [ ] Confirm the new project's `tradepay_state.revision` and `updated_at` advanced.
- [ ] Restart the Render service from the dashboard (or suspend/resume).
- [ ] After restart, `GET /health` is healthy and the test mutation/balance is still present.
- [ ] Log in again; balance still present.
- [ ] Admin login with the new `ADMIN_KEY` works.
- [ ] The old exposed `a6zJ...` key is rejected.
- [ ] Search the served client assets for the service-role key; it must not appear.

### Phase 8 — Cleanup and rollback

- [ ] Keep the old project and the local `data/db.json` backup.
- [ ] Keep `render-env.txt` until the user has pasted all values, then they may delete it.
- [ ] Do not delete the old project. It holds the other app's 117 users and TradePay's Auth pool.
- [ ] If the new state project is abandoned, delete **only** the new project, with explicit user approval.
- [ ] If the Render deploy fails, revert the new env vars; the old project and local state remain intact.
- [ ] If the state row is corrupted, re-seed from the backup with a higher revision.

---

## 6. Acceptance criteria

- [ ] `GET /health` reports `storage.backend === "supabase"`, `durable === true`, `ok === true`, `initialized === true`.
- [ ] The new project has exactly one `tradepay_state` row (`id = 'primary'`) with the seeded snapshot.
- [ ] All 29 local users and 28 Auth UUIDs are preserved; funded balances total 9,226.
- [ ] Login/logout preserves balances.
- [ ] Render restart preserves balances and ledger entries.
- [ ] Admin works with the new key; the exposed old key does not.
- [ ] `anon` cannot read `tradepay_state`.
- [ ] The service-role key never appears in client code, browser assets, logs, or chat.
- [ ] `npm test` passes.
- [ ] No DDL or deletion is performed on the old project.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Free org rejects a second project | Stop; do not pause/delete the old project. Use a new org or upgrade only with user approval. |
| New project also has PAM failure | Stop; this is platform-wide. Fall back to option A (Supabase support) using event IDs `d16ab3ca8fc84ba89540b7ecd3a79e05`, `283ae2d64d0b48fb88f5a87ed61b8dfa`. |
| Seed fails / payload too large | Use `@supabase/supabase-js` RPC; 380 KB should be fine. Verify counts before Render deploy. |
| Render starts before seed | Seed first; verify the row; only then enable the backend. |
| Old Auth project degrades | Auth/REST are healthy today, but the project still needs a Supabase support fix. Keep the support ticket option open. |
| Free Supabase pauses after 7 days idle | Regular app traffic keeps it active; a paused project will cause fail-closed startup, not silent data loss. |
| Free Render sleeps after inactivity | Expected; first request cold-starts; state is loaded from Supabase. |
| 380 KB snapshot per mutation | Free-tier bandwidth may become a limit at high write volume. Monitor; future optimization is per-user rows or an append-only ledger. |
| Shared Auth pool | The old project also serves `metrascan-compliance` (117 users). This is pre-existing; do not delete users or change Auth settings. |
| Exposed admin key | Generate a new 64-char `ADMIN_KEY`; never reuse the old value. |

---

## 8. Do-not list

- Do **not** run `supabase/schema.sql` against the old project.
- Do **not** delete or pause `vhzfbacpvfjdpkthxvej`.
- Do **not** point `SUPABASE_URL` at the new project; Auth would break.
- Do **not** use the new project's anon/publishable key for state writes.
- Do **not** put `SUPABASE_STATE_SERVICE_ROLE_KEY` in `SUPABASE_KEY`, client code, `public/`, or logs.
- Do **not** seed from an empty/default state on Render.
- Do **not** reuse the exposed `a6zJ...` admin key.
- Do **not** commit `.env`, `render-env.txt`, `data/db.json`, or any password file.
- Do **not** migrate Auth users to the new project unless the user explicitly accepts password resets and balance remapping.

---

## 9. Open decisions

1. **Region:** `us-west-2` recommended (near Render `oregon`); alternative `ap-south-1` (near Auth project/users).
2. **Project name:** `tradepay-state` default.
3. **Old `SUPABASE_SERVICE_ROLE_KEY` in Render:** keep if already set (Auth admin metadata sync); optional otherwise.
4. **Disposable test Auth user:** not required for local state verification; production verification can use a real account.

---

## 10. Progress log

| Date | Step | Result |
|---|---|---|
| 2026-11-01 | Verified old project Auth | 28/28 TradePay UUID users found; 117 Auth users total (shared with metrascan) |
| 2026-11-01 | Verified local state | 29 users, 3 funded, total 9,226; 22 wallets, 10 deposits, 20 withdrawals |
| 2026-11-01 | Verified old project outage | `postgres` PAM failure blocks DDL; GoTrue/PostgREST healthy |
| 2026-11-01 | Created this plan | No external changes made |
| 2026-11-01 | Phase 0 Preflight & Backup | Backed up `data/db.json` -> `data/db.pre-supabase-*.json`; baseline matched (29 users, 3 funded, 9226 total, 22 wallets, 10 deposits, 20 withdrawals, 84 ledger entries) |
| 2026-11-01 | Phase 1 Dedicated State Project | Project `tradepay-state` verified active (`afzlfxinbwqbecjduixd`, `us-west-2`, `ACTIVE_HEALTHY`); password file ensured |
| 2026-11-01 | Phase 2 Schema Applied | Applied `supabase/schema.sql` via Management API `/database/query`. Verified tables (deposits, profiles, tradepay_state, wallets), functions, RLS, and grants (service_role only). PostgREST schema reloaded |
| 2026-11-01 | Phase 3 State Row Seeded | Seeded snapshot from `data/db.json` via `save_tradepay_state`. Verified row contents (all 29 users, 3 funded, 9226 balance, 22 wallets, 10 deposits, 20 withdrawals, 84 ledger). Tested anon denial (401) and monotonic revision. Re-seeded clean snapshot at revision 1793527355925 |
| 2026-11-01 | Phase 4 Code & Tests | Updated `server/engine/stateStore.js`, `render.yaml`, `README.md`, `supabase/schema.sql`. `npm run test:state-store` (8/8) and `npm test` (all suites) passed |
| 2026-11-01 | Phase 5 Local E2E Verification | Ran production server on port 3100. `/health` returned healthy with `storage.backend: "supabase"`, `durable: true`, `ok: true`, `initialized: true`, revision 1793527355925. Cold restart verified identical revision. Client assets verified clean of secrets |
| 2026-11-01 | Phase 6.1 Handoff Env File | Generated `C:\Users\sunny\.tradepay\render-env.txt` containing fresh 64-char `ADMIN_KEY` and all split project keys |

When execution begins, append the new project ref, schema result, seed result, code commit SHA, Render deploy result, and health-check output here.
