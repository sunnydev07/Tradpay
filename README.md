# TradePay / LinkPay - Reverse Engineered P2P Engine & Fast Web App

A high-performance P2P Order Matching, Liquidity Dispatch, and UPI Collection Web Application reverse-engineered from the Android application (`linkpay.apk`). Rebuilt with an ultra-fast Node.js backend engine, **Supabase Authentication & Real Data Management**, and optimized for single-instance hosting on [Render](https://render.com).

---

## 1. Features & Architecture

### Supabase Authentication & Real User Data
- **Supabase Auth Integration**: Users can register and sign in with their Phone Number or Email and Password via Supabase Auth (`@supabase/supabase-js`).
- **Data Isolation**: Every user receives their own secure JWT token, personalized wallet collection, balance tracking, transaction history, and custom referral code (`LPxxxx`).
- **Real-Time Data Sorting**:
  - Live hang sales order sorting: **Ascending (₹)**, **Descending (₹)**, and **Default (Recency)**.
  - Range filter chips: `500-2000`, `2000-5000`, `5000-10000`, `10000-50000`.
- **Server-Side Financial State**: Balances, wallets, PIN hashes, rewards, and claimed orders live only in server-side state. Supabase `user_metadata` is treated as untrusted profile input and never as a balance or PIN source.
- **Verified Deposits**: UPI deposit submissions stay `pending` until an administrator approves them or a signed PSP webhook reconciles the UTR. Auto-credit is opt-in for local development only (`ALLOW_AUTO_DEPOSIT=true` outside production).
- **Deposit Operations**: Users can see their own deposit history; administrators review pending deposits at `/admin.html` or through `GET /app/admin/deposits`. Approval and rejection are idempotent.
- **Hashed PINs**: Security PINs are stored as scrypt hashes with per-user salts, verified with a constant-time comparison, and rate-limited after repeated failures. The PIN is never returned to the client.
- **Paise-Exact Money**: Balances, rewards, commissions, and deposit credits are calculated in integer paise before being stored as rupee amounts, avoiding floating-point drift.

### Reverse Engineered Engine from APK
- **Audio Feedback**: Extracted `dcloud_beep.ogg` (5,176 bytes) authentic order notification sound with Web Audio synthesizer fallback.
- **Visual Assets**: 77 authentic brand icons, banners, and tabs from the original app (`PhonePe`, `Paytm`, `GooglePay`, `Freecharge`, `Airtel`, `Mobikwik`, `BharatPeBiz`, etc.).
- **P2P Matching Lifecycle**:
  - `hangSales` -> Claim with compatible wallet -> 15-minute countdown -> Buyer UPI assignment -> Bank UTR submission -> Instant balance & reward payout.
- **Night Bonus Engine**: Automated bonus reward window (`22:00 - 06:00`) offering a **+25% bonus multiplier**.
- **3-Tier Affiliate System**: L1 Direct (0.60%), L2 (0.30%), and L3 (0.10%) commission tree.

---

## 2. API Specification

All endpoints return standard JSON where **`code: 1000`** indicates a successful operation. Every `/app/*` endpoint requires `Authorization: Bearer <supabase-access-token>` except login, registration, and the public marketing/configuration routes (official QR list, notices, carousel, wallet type list). The order catalog is authenticated.

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
| `/app/payment/deposit/submit` | `POST` | Bearer | Submit a 12-digit UTR deposit for verification |
| `/app/payment/deposit/history` | `GET` | Bearer | List the caller's deposit submissions |
| `/app/admin/deposits` | `GET` | Admin | List deposits, optionally filtered by `status` |
| `/app/admin/deposits/approve` | `POST` | Admin | Approve and credit a pending deposit exactly once |
| `/app/admin/deposits/reject` | `POST` | Admin | Reject a pending deposit without crediting |
| `/webhooks/payment` | `POST` | HMAC | Reconcile a PSP payment by UTR (idempotent) |
| `/app/ct/app/collection/getWalletList` | `POST` | Bearer | List user's bound collection wallets |
| `/app/ct/app/collection/submit` | `POST` | Bearer | Bind new UPI wallet (server-side state) |
| `/app/ct/app/collection/changeStatus/:id` | `POST` | Bearer | Toggle wallet active status (`onSell`/`offSell`) |
| `/health` | `GET` | Public | Single-instance health check for Render |

Admin routes require the caller's user id in `ADMIN_USER_IDS` (comma-separated). Administrators can review deposits at `/admin.html`. The WebSocket at `/ws` requires a first message of `{"type":"AUTH","token":"<access-token>"}` and closes unauthenticated connections after 10 seconds.

The payment webhook expects an `x-tradepay-signature: sha256=<hex>` HMAC over the exact JSON body, using `PAYMENT_WEBHOOK_SECRET`. A body such as `{"event":"payment.captured","utr":"123456789012","amount":1500}` marks the matching pending deposit completed and credits it once; retries return `duplicate: true` without crediting again.

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
| `ADMIN_USER_IDS` | Comma-separated user ids allowed to call admin endpoints and open `/admin.html` |
| `PAYMENT_WEBHOOK_SECRET` | HMAC secret for `/webhooks/payment`; the endpoint is disabled when unset |
| `CORS_ORIGINS` | Comma-separated extra origins; same-origin is always allowed |
| `PUBLIC_BASE_URL` | Public base URL used in invite links |
| `TRADEPAY_DB_FILE` | Absolute path to the runtime state file |
| `ALLOW_AUTO_DEPOSIT` | `true` only outside production to auto-credit deposits |
| `ALLOW_SIMULATION` | Set `false` to disable sample order generation |
| `BONUS_TIMEZONE` | Timezone for the night-bonus window (default `Asia/Kolkata`) |

---

## 4. Render Deployment (Single Instance)

The project includes [`render.yaml`](file:///C:/Users/sunny/Desktop/TradePay/render.yaml) and [`Dockerfile`](file:///C:/Users/sunny/Desktop/TradePay/Dockerfile) for zero-downtime deployment:

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
   - `TRADEPAY_DB_FILE`: `/var/data/db.json` after mounting a disk at `/var/data`
5. Attach a persistent disk for `TRADEPAY_DB_FILE` on a paid plan. The free plan has ephemeral storage, so balances and order state are lost on redeploy without a disk. `render.yaml` contains a commented disk block to uncomment on a paid plan.
6. Click **Apply**. In production the server refuses to start without `SUPABASE_URL` and `SUPABASE_KEY`.

---

## 5. Security Notes

- Never commit `data/db.json`, `.env` files, service-role keys, or webhook secrets.
- The old demo bearer token and plaintext demo PIN still exist in git history. They were demo-only, but rotate any credential that was ever reused outside local development.
- Order rewards are still based on a self-attested UTR until a real PSP connection is configured. `/webhooks/payment` provides the signed reconciliation path; it is disabled until `PAYMENT_WEBHOOK_SECRET` is set.
