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
- **Supabase Cloud Sync & Owner Visibility**: All user profiles, wallets, balances, PIN hashes, and order records automatically persist to Supabase Auth `user_metadata` and the supervised database. The project owner can inspect, manage, and audit every user directly in the Supabase Dashboard.
- **Hashed PINs**: Security PINs are stored as scrypt hashes with per-user salts, verified with a constant-time comparison, and rate-limited after repeated failures. The PIN is never returned to the client.
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

Visit [http://localhost:3000](http://localhost:3000) in your browser. Authentication needs a Supabase project; set `SUPABASE_URL` and `SUPABASE_KEY` before starting, otherwise login and registration return 503. The process does not load `.env` files automatically.

Runtime state is stored in `data/db.json` by default. Point `TRADEPAY_DB_FILE` at a persistent volume in production; do not commit the DB file (it is gitignored). Test-script guidance is in [`scripts/README.md`](scripts/README.md).

### Environment Variables

| Variable | Purpose |
| :--- | :--- |
| `SUPABASE_URL` / `SUPABASE_KEY` | Required. Supabase project URL and anon/publishable key; there is no hardcoded fallback |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional service-role key for server-only Supabase admin calls; never exposed to clients |
| `ADMIN_USER_IDS` | Comma-separated user ids allowed to call admin endpoints |
| `CORS_ORIGINS` | Comma-separated extra origins; same-origin is always allowed |
| `PUBLIC_BASE_URL` | Public base URL used in invite links |
| `TRADEPAY_DB_FILE` | Absolute path to the runtime state file |
| `ALLOW_SIMULATION` | Set `false` to disable sample order generation |
| `BONUS_TIMEZONE` | Timezone for the night-bonus window (default `Asia/Kolkata`) |

---

## 4. Render & Supabase Deployment (Production Guide)

### Step 1: Initialize Supabase Database
1. Open the [Supabase Dashboard](https://supabase.com/dashboard).
2. Navigate to your project -> **SQL Editor**.
3. Open [`supabase/schema.sql`](supabase/schema.sql), copy its entire content, paste into the SQL editor, and click **Run**.
4. This idempotently provisions:
   - `public.profiles` with custom application attributes (balance, points, VIP level, invite code).
   - `public.wallets` with user associations, status, and turnover tracking.
   - `public.deposits` with UTR validation and indexes (`idx_deposits_user_id`, `idx_deposits_utr`, `idx_deposits_status`).
   - Row Level Security (RLS) policies allowing users access only to their own wallets.

### Step 2: Render Deployment
The project includes [`render.yaml`](render.yaml) and [`Dockerfile`](Dockerfile) for zero-downtime deployment:

1. Push to your GitHub repository.
2. In [Render Dashboard](https://dashboard.render.com), select **New +** -> **Blueprint**.
3. Connect your repository. Render will automatically detect `render.yaml`.
4. Set the required environment variables in Render:
   - `SUPABASE_URL`: `https://<your-project>.supabase.co`
   - `SUPABASE_KEY`: `<your-supabase-anon-key>`
   - `SUPABASE_SERVICE_ROLE_KEY`: `<service-role-key>` (server-only; optional)
   - `ADMIN_USER_IDS`: `<your-supabase-user-id>`
   - `PAYMENT_WEBHOOK_SECRET`: `<random-hmac-secret>` (optional until a PSP is connected)
   - `CORS_ORIGINS`: `https://your-custom-domain.example` (optional)
   - `PUBLIC_BASE_URL`: `https://your-service.onrender.com`
   - `TRADEPAY_DB_FILE`: `/var/data/db.json` (after mounting a disk at `/var/data`)
5. **Persistent Disk Setup**:
   - The free plan uses ephemeral disk storage (runtime state resets on restart or redeployment).
   - For persistent runtime state across redeploys, upgrade to a paid instance (Starter plan), uncomment the `disk:` block in `render.yaml` or attach a disk mounted to `/var/data` (size: 1GB) via the Render Dashboard, and set `TRADEPAY_DB_FILE=/var/data/db.json`.
6. Click **Apply**. In production the server refuses to start without `SUPABASE_URL` and `SUPABASE_KEY`.

---

## 5. Security Notes

- Never commit `data/db.json`, `.env` files, service-role keys, or webhook secrets.
- The old demo bearer token and plaintext demo PIN still exist in git history. They were demo-only, but rotate any credential that was ever reused outside local development.
- Order rewards are based on a self-attested 12-digit UTR. Claimed orders lock a 15-minute countdown; expired orders release back to the matching pool automatically.
