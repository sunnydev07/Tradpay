# TradePay - Reverse Engineered P2P Engine & Fast Web App

A high-performance P2P Order Matching, Liquidity Dispatch, and UPI Collection Web Application reverse-engineered from the Android application (`linkpay.apk`). Rebuilt with an ultra-fast Node.js backend engine, **Supabase Authentication & Real Data Management**, and optimized for single-instance hosting on [Render](https://render.com).

---

## 1. Features & Architecture

### Supabase Authentication & Real User Data
- **Supabase Auth Integration**: Users can register and sign in with their Phone Number or Email and Password via Supabase Auth (`@supabase/supabase-js`).
- **Data Isolation**: Every user receives their own secure JWT token, personalized wallet collection, balance tracking, transaction history, and custom referral code (`LPxxxx`).
- **Real-Time Data Sorting**:
  - Live hang sales order sorting: **Ascending (₹)**, **Descending (₹)**, and **Default (Recency)**.
  - Range filter chips: `500-2000`, `2000-5000`, `5000-10000`, `10000-50000`, `50000-100000`.
- **Server-Authoritative Ledger**: Balances, withdrawals, rewards, and deposit credits are written to an append-only server ledger with idempotency keys and paise-exact arithmetic. Supabase Auth `user_metadata` is used for display/profile fields only; balances, wallets, claimed orders, and PIN state are never imported from or written to metadata.
- **Durable Single-Instance State**: The ledger is stored in `data/db.json` locally and either on a mounted Render disk (`TRADEPAY_DB_FILE`) or in the service-role-only `public.tradepay_state` Supabase table (`TRADEPAY_STATE_BACKEND=supabase`). Writes are flushed atomically; production refuses to start without a durable backend, so a restart cannot silently reset balances.
- **Official Receiving Wallet Only**: Deposits are created against a system-owned, active `isOfficial` wallet. If none exists, deposit creation fails closed instead of falling back to another user's UPI account.
- **USDT Disabled by Default**: USDT deposit endpoints return `503` and the UI hides the gateway until a valid receiving address is configured through environment variables. Placeholder addresses are rejected.
- **Hashed PINs**: Security PINs are stored server-side as scrypt hashes with per-user salts, verified with a constant-time comparison, and rate-limited after repeated failures. PIN hashes and salts are never written to Supabase metadata and never returned to the client.
- **Paise-Exact Money**: Balances, rewards, and commissions are calculated in integer paise before being stored as rupee amounts, avoiding floating-point drift.

### Reverse Engineered Engine from APK
- **Audio Feedback**: Extracted `dcloud_beep.ogg` (5,176 bytes) authentic order notification sound with Web Audio synthesizer fallback.
- **Visual Assets**: 77 authentic brand icons, banners, and tabs from the original app (`PhonePe`, `Paytm`, `GooglePay`, `Freecharge`, `Airtel`, `Mobikwik`, `BharatPeBiz`, etc.).
- **P2P Matching Lifecycle**:
  - `hangSales` -> Claim with compatible wallet -> 15-minute countdown -> Bank UTR submission -> Instant balance & reward payout.
- **Night Bonus Engine**: Automated bonus reward window (`22:00 - 06:00`) offering a **+25% bonus multiplier**.
- **3-Tier Affiliate System**: L1 Direct (0.60%), L2 (0.30%), and L3 (0.10%) commission tree.

---

## 2. API Specification

All endpoints return standard JSON where **`code: 1000`** indicates a successful operation. Every `/app/*` endpoint requires `Authorization: Bearer <supabase-access-token>` except login, registration, and the public marketing/configuration routes (notices, carousel, wallet type list). The order catalog is authenticated.

| Endpoint | Method | Auth | Description |
| :--- | :--- | :--- | :--- |
| `/app/user/login/login` | `POST` | Public | Authenticate user via Supabase Auth |
| `/app/user/rs/submit` | `POST` | Public | Register a new user in Supabase |
| `/app/user/info` | `GET` | Bearer | Get current user profile, balance, and VIP status |
| `/app/payment/order` | `GET` | Bearer | Query hang sales orders with filters and sorting |
| `/app/payment/order/summary` | `GET` | Bearer | User available balance, reward total, USDT rate |
| `/app/payment/order/create` | `POST` | Bearer | Claim and lock an order to a payout wallet |
| `/app/payment/order/submit` | `POST` | Bearer | Confirm payment receipt with bank 12-digit UTR |
| `/app/payment/order/cancel` | `POST` | Bearer | Cancel order and release back to matching pool |
| `/app/ct/app/collection/getWalletList` | `POST` | Bearer | List user's bound collection wallets |
| `/app/ct/app/collection/submit` | `POST` | Bearer | Bind new UPI wallet (server-side state) |
| `/app/ct/app/collection/changeStatus/:id` | `POST` | Bearer | Toggle wallet active status (`onSell`/`offSell`) |
| `/health` | `GET` | Public | Single-instance health check for Render |

Administrators can be configured via `ADMIN_USER_IDS` (comma-separated user ids). The WebSocket at `/ws` requires a first message of `{"type":"AUTH","token":"<access-token>"}` and closes unauthenticated connections after 10 seconds.

---

## 3. Local Development

```powershell
# 1. Install dependencies
npm install

# 2. Run the application
npm start

# 3. Run the security regression tests (uses a temp DB, no Supabase calls)
npm test
```

Visit [http://localhost:3000](http://localhost:3000) in your browser. Authentication needs a Supabase project; set `SUPABASE_URL` and `SUPABASE_KEY` before starting, otherwise login and registration return 503. The server loads `.env` automatically when the file exists, but variables already set by the shell, Render, or CI take precedence.

Runtime state is stored in `data/db.json` by default. For hosting without a persistent disk (including Render's free plan), set `TRADEPAY_STATE_BACKEND=supabase` to keep the server-authoritative snapshot in `public.tradepay_state`; the local file then becomes only a cache. Do not commit either store (the DB file is gitignored). Test-script guidance is in [`scripts/README.md`](scripts/README.md).

### Environment Variables

| Variable | Purpose |
| :--- | :--- |
| `SUPABASE_URL` / `SUPABASE_KEY` | Required. Supabase project URL and anon/publishable key; there is no hardcoded fallback |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service-role key. Required when `TRADEPAY_STATE_BACKEND=supabase`; never exposed to clients |
| `ADMIN_KEY` | Admin console secret. Required in production; at least 32 random characters. The server rejects the old `dev780@$$` default and refuses to start without a valid key |
| `ADMIN_USER_IDS` | Comma-separated user ids allowed to call admin endpoints without the admin key |
| `CORS_ORIGINS` | Comma-separated extra origins; same-origin is always allowed |
| `PUBLIC_BASE_URL` | Public base URL used in invite links |
| `TRADEPAY_STATE_BACKEND` | Set to `supabase` to store the authoritative ledger snapshot in Supabase. Required for free Render hosting; leave unset to use the local file |
| `TRADEPAY_STATE_ID` | Optional row id in `public.tradepay_state` (default `primary`). Use a different value when one Supabase project serves multiple environments |
| `TRADEPAY_DB_FILE` | Absolute path to the local/cached runtime state file. Required in production only when the Supabase backend is not enabled; use `/var/data/db.json` with a Render disk |
| `ALLOW_EPHEMERAL_STORAGE` | Set `true` only for disposable previews to bypass the production durable-storage check |
| `USDT_TRC20_ADDRESS` / `USDT_BSC_ADDRESS` / `USDT_POLYGON_ADDRESS` | Real USDT receiving addresses. USDT deposits stay disabled until at least one valid address is set |
| `ALLOW_SIMULATION` | Set `false` to disable sample order generation |
| `BONUS_TIMEZONE` | Timezone for the night-bonus window (default `Asia/Kolkata`) |

---

## 4. Render & Supabase Deployment (Production Guide)

### Step 1: Initialize Supabase Database
1. Open the [Supabase Dashboard](https://supabase.com/dashboard).
2. Navigate to your project -> **SQL Editor**.
3. Open [`supabase/schema.sql`](supabase/schema.sql), copy its entire content, paste into the SQL editor, and click **Run**.
4. This idempotently provisions the supporting tables:
   - `public.profiles` with historical profile columns. These columns are **not** the source of truth for money; the server ledger owns balances.
   - `public.wallets` with user associations, status, and turnover tracking.
   - `public.deposits` with UTR validation and indexes (`idx_deposits_user_id`, `idx_deposits_utr`, `idx_deposits_status`).
   - `public.tradepay_state`, the single-row authoritative snapshot used by the free-plan deployment. RLS is enabled, `anon` and `authenticated` have no access, and only `service_role` may read or write it.
   - The `save_tradepay_state(text, jsonb, bigint)` function, which writes monotonically so an older process cannot overwrite a newer snapshot.
   - Row Level Security (RLS) policies allowing users access only to their own wallets.

### Step 2: Render Deployment (free plan + Supabase state)
[`render.yaml`](render.yaml) provisions a **free** Render web service and sets `TRADEPAY_STATE_BACKEND=supabase`. The authoritative ledger snapshot lives in Supabase, so no persistent disk is required. A mounted disk is still supported on paid instances: in that case remove `TRADEPAY_STATE_BACKEND`, add the disk, and set `TRADEPAY_DB_FILE=/var/data/db.json`.

1. Push to your GitHub repository.
2. In [Render Dashboard](https://dashboard.render.com), select **New +** -> **Blueprint**.
3. Connect your repository. Render will automatically detect `render.yaml`.
4. In Supabase, open **Project Settings -> API** and copy the `service_role` secret. This key bypasses RLS, so store it only in Render's environment. Never put it in browser code, `SUPABASE_KEY`, or a committed file.
5. Set these environment variables in Render:
   - `SUPABASE_URL`: `https://<your-project>.supabase.co`
   - `SUPABASE_KEY`: `<your-supabase-anon-key>`
   - `SUPABASE_SERVICE_ROLE_KEY`: `<service-role-key>` (server-only; required)
   - `ADMIN_KEY`: `<random-admin-secret>` (at least 32 characters; generate with `openssl rand -hex 32`)
   - `ADMIN_USER_IDS`: `<your-supabase-user-id>`
   - `PAYMENT_WEBHOOK_SECRET`: `<random-hmac-secret>` (optional until a PSP is connected)
   - `CORS_ORIGINS`: `https://your-custom-domain.example` (optional)
   - `PUBLIC_BASE_URL`: `https://your-service.onrender.com`
6. Click **Apply** and deploy the latest `main`. In production the server refuses to start when `TRADEPAY_STATE_BACKEND=supabase` is set without all three Supabase values, or when neither the Supabase backend nor an absolute `TRADEPAY_DB_FILE` is configured. It also requires a valid `ADMIN_KEY`.
7. **Migrating existing balances**: an empty `tradepay_state` table is seeded once from the local cache (`TRADEPAY_DB_FILE`) or the default zero-balance state. To move an existing ledger, run the server locally once with the old `TRADEPAY_DB_FILE`, `TRADEPAY_STATE_BACKEND=supabase`, and the three Supabase variables, then confirm the row in `public.tradepay_state` before deploying. If the row already exists, the local file is ignored because Supabase is authoritative.
8. **Verify persistence**: call `GET /health` and confirm the response contains:
   ```json
   "storage": {
     "backend": "supabase",
     "table": "tradepay_state",
     "durable": true,
     "ok": true,
     "initialized": true
   }
   ```
   Then create a small test deposit or withdrawal, restart the service from the Render dashboard, and confirm the balance and ledger entry are still present.
9. **Failure behavior**: mutating API responses wait for the snapshot write. If Supabase is unavailable, the API returns HTTP 503 instead of acknowledging an unsaved change, and `/health` reports `storage.ok: false`. A failed startup or reload exits rather than continuing with an empty ledger.

Free Render services spin down after inactivity, and free Supabase projects can be paused after a week of inactivity. The first request after either event is slow; if the Supabase project is paused, restore it in the dashboard before the Render instance can boot. Each write sends the whole JSONB snapshot, so very large ledger histories can hit Supabase/PostgREST request and database-size limits; normalize the ledger into tables before that point.

The Supabase state store is designed for a **single writer**. The monotonic revision prevents a stale snapshot from overwriting a newer one, but two live instances that mutate state independently can still lose each other's changes. Run one Render instance; move to per-table transactional storage before horizontal scaling.

---

## 5. Security Notes

- Never commit `data/db.json`, `.env` files, service-role keys, webhook secrets, or the admin key.
- The old `dev780@$$` admin key is public in git history. It is now rejected outright; set a unique `ADMIN_KEY` of at least 32 random characters and rotate it if any deployment ever used the old default. The admin console exchanges the key for a two-hour signed session and never stores the raw key in the browser.
- The old demo bearer token and plaintext demo PIN still exist in git history. They were demo-only, but rotate any credential that was ever reused outside local development.
- Order rewards are based on a self-attested 12-digit UTR. Claimed orders lock a 15-minute countdown; expired orders release back to the matching pool automatically.
- Deposit creation only uses an active system-owned `isOfficial` wallet. If none is configured it returns an error rather than falling back to a user's UPI account.
- USDT gateways remain disabled until real receiving addresses are set in `USDT_TRC20_ADDRESS`, `USDT_BSC_ADDRESS`, or `USDT_POLYGON_ADDRESS`. Malformed and placeholder addresses are ignored.
- Keep whichever state backend you use healthy and monitored. The `/health` response reports `storage.ok: false` if the last state write failed. Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser; `public.tradepay_state` is intentionally inaccessible to `anon` and `authenticated`.
