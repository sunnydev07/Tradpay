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
- **Persistent Single-Instance State**: The ledger is stored in `data/db.json` locally and on a mounted Render disk in production. Writes are flushed and atomically renamed. The server refuses to start in production without an absolute `TRADEPAY_DB_FILE`, so a restart cannot silently reset balances.
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

Visit [http://localhost:3000](http://localhost:3000) in your browser. Authentication needs a Supabase project; set `SUPABASE_URL` and `SUPABASE_KEY` before starting, otherwise login and registration return 503. The server loads `.env` automatically when the file exists.

Runtime state is stored in `data/db.json` by default. Point `TRADEPAY_DB_FILE` at a persistent volume in production; do not commit the DB file (it is gitignored). Test-script guidance is in [`scripts/README.md`](scripts/README.md).

### Environment Variables

| Variable | Purpose |
| :--- | :--- |
| `SUPABASE_URL` / `SUPABASE_KEY` | Required. Supabase project URL and anon/publishable key; there is no hardcoded fallback |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional service-role key for server-only Supabase admin calls; never exposed to clients |
| `ADMIN_KEY` | Admin console secret. Required in production; at least 32 random characters. The server rejects the old `dev780@$$` default and refuses to start without a valid key |
| `ADMIN_USER_IDS` | Comma-separated user ids allowed to call admin endpoints without the admin key |
| `CORS_ORIGINS` | Comma-separated extra origins; same-origin is always allowed |
| `PUBLIC_BASE_URL` | Public base URL used in invite links |
| `TRADEPAY_DB_FILE` | Absolute path to the runtime state file. Required in production; use `/var/data/db.json` with a Render disk |
| `ALLOW_EPHEMERAL_STORAGE` | Set `true` only for disposable previews to bypass the production persistent-storage check |
| `USDT_TRC20_ADDRESS` / `USDT_BSC_ADDRESS` / `USDT_POLYGON_ADDRESS` | Real USDT receiving addresses. USDT deposits stay disabled until at least one valid address is set |
| `ALLOW_SIMULATION` | Set `false` to disable sample order generation |
| `BONUS_TIMEZONE` | Timezone for the night-bonus window (default `Asia/Kolkata`) |

---

## 4. Render & Supabase Deployment (Production Guide)

### Step 1: Initialize Supabase Database
1. Open the [Supabase Dashboard](https://supabase.com/dashboard).
2. Navigate to your project -> **SQL Editor**.
3. Open [`supabase/schema.sql`](supabase/schema.sql), copy its entire content, paste into the SQL editor, and click **Run**.
4. This idempotently provisions legacy tables for Supabase-side tooling:
   - `public.profiles` with historical profile columns. These columns are **not** the source of truth for money; the server ledger owns balances.
   - `public.wallets` with user associations, status, and turnover tracking.
   - `public.deposits` with UTR validation and indexes (`idx_deposits_user_id`, `idx_deposits_utr`, `idx_deposits_status`).
   - Row Level Security (RLS) policies allowing users access only to their own wallets.

### Step 2: Render Deployment (persistent disk required)
[`render.yaml`](render.yaml) provisions a **Starter** instance with a 1 GB disk mounted at `/var/data` and sets `TRADEPAY_DB_FILE=/var/data/db.json`. Render does not offer persistent disks on the free plan, so this Blueprint intentionally uses a paid instance type.

1. Push to your GitHub repository.
2. In [Render Dashboard](https://dashboard.render.com), select **New +** -> **Blueprint**.
3. Connect your repository. Render will automatically detect `render.yaml`.
4. Confirm the disk in the dashboard:
   - Instance type is **Starter** or higher.
   - Disk `tradepay-data` is mounted at `/var/data`.
   - `TRADEPAY_DB_FILE` is exactly `/var/data/db.json`.
5. Set the remaining environment variables in Render:
   - `SUPABASE_URL`: `https://<your-project>.supabase.co`
   - `SUPABASE_KEY`: `<your-supabase-anon-key>`
   - `SUPABASE_SERVICE_ROLE_KEY`: `<service-role-key>` (server-only; optional)
   - `ADMIN_KEY`: `<random-admin-secret>` (at least 32 characters; generate with `openssl rand -hex 32`)
   - `ADMIN_USER_IDS`: `<your-supabase-user-id>`
   - `PAYMENT_WEBHOOK_SECRET`: `<random-hmac-secret>` (optional until a PSP is connected)
   - `CORS_ORIGINS`: `https://your-custom-domain.example` (optional)
   - `PUBLIC_BASE_URL`: `https://your-service.onrender.com`
6. Click **Apply**. In production the server refuses to start without `SUPABASE_URL`, `SUPABASE_KEY`, an absolute `TRADEPAY_DB_FILE`, and a valid `ADMIN_KEY`.
7. **Migrating an existing deployment**: if the service previously ran without a disk, copy its current `data/db.json` to `/var/data/db.json` before the cutover. Balances are no longer restored from Supabase metadata, so an empty state file means an empty ledger.
8. **Verify persistence**: call `GET /health` and confirm `storage.durable` and `storage.ok` are both `true`. Then create a small test deposit or withdrawal, restart the service from the Render dashboard, and confirm the balance and ledger entry are still present.

The file store is designed for a **single instance**. If you need multiple instances or horizontal scaling, move the ledger to Postgres (a planned follow-up); do not run multiple instances against the same JSON file.

---

## 5. Security Notes

- Never commit `data/db.json`, `.env` files, service-role keys, webhook secrets, or the admin key.
- The old `dev780@$$` admin key is public in git history. It is now rejected outright; set a unique `ADMIN_KEY` of at least 32 random characters and rotate it if any deployment ever used the old default. The admin console exchanges the key for a two-hour signed session and never stores the raw key in the browser.
- The old demo bearer token and plaintext demo PIN still exist in git history. They were demo-only, but rotate any credential that was ever reused outside local development.
- Order rewards are based on a self-attested 12-digit UTR. Claimed orders lock a 15-minute countdown; expired orders release back to the matching pool automatically.
- Deposit creation only uses an active system-owned `isOfficial` wallet. If none is configured it returns an error rather than falling back to a user's UPI account.
- USDT gateways remain disabled until real receiving addresses are set in `USDT_TRC20_ADDRESS`, `USDT_BSC_ADDRESS`, or `USDT_POLYGON_ADDRESS`. Malformed and placeholder addresses are ignored.
- Keep the persistent disk mounted and monitored. The `/health` response reports `storage.ok: false` if the last state write failed.
