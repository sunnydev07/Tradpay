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
- **Cloud Metadata Persistence**: Wallets, security PINs, balance rewards, and claimed orders sync with Supabase user metadata.

### Reverse Engineered Engine from APK
- **Audio Feedback**: Extracted `dcloud_beep.ogg` (5,176 bytes) authentic order notification sound with Web Audio synthesizer fallback.
- **Visual Assets**: 77 authentic brand icons, banners, and tabs from the original app (`PhonePe`, `Paytm`, `GooglePay`, `Freecharge`, `Airtel`, `Mobikwik`, `BharatPeBiz`, etc.).
- **P2P Matching Lifecycle**:
  - `hangSales` -> Claim with compatible wallet -> 15-minute countdown -> Buyer UPI assignment -> Bank UTR submission -> Instant balance & reward payout.
- **Night Bonus Engine**: Automated bonus reward window (`22:00 - 06:00`) offering a **+25% bonus multiplier**.
- **3-Tier Affiliate System**: L1 Direct (0.60%), L2 (0.30%), and L3 (0.10%) commission tree.

---

## 2. API Specification

All endpoints return standard JSON where **`code: 1000`** indicates a successful operation:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/app/user/login/login` | `POST` | Authenticate user via Supabase Auth |
| `/app/user/rs/submit` | `POST` | Register a new user in Supabase |
| `/app/user/info` | `GET` | Get current user profile, balance, and VIP status |
| `/app/payment/order` | `GET` | Query hang sales orders with filters and sorting |
| `/app/payment/order/summary` | `GET` | User available balance, reward total, USDT rate |
| `/app/payment/order/create` | `POST` | Claim and lock an order to a payout wallet |
| `/app/payment/order/submit` | `POST` | Confirm payment receipt with bank 12-digit UTR |
| `/app/payment/order/cancel` | `POST` | Cancel order and release back to matching pool |
| `/app/ct/app/collection/getWalletList` | `POST` | List user's bound collection wallets |
| `/app/ct/app/collection/submit` | `POST` | Bind new UPI wallet (persisted to Supabase) |
| `/app/ct/app/collection/changeStatus/:id` | `POST` | Toggle wallet active status (`onSell`/`offSell`) |
| `/health` | `GET` | Single-instance health check for Render |

---

## 3. Local Development

```powershell
# 1. Install dependencies
npm install

# 2. Run the application
npm start
```

Visit [http://localhost:3000](http://localhost:3000) in your browser.

---

## 4. Render Deployment (Single Instance)

The project includes [`render.yaml`](file:///C:/Users/sunny/Desktop/TradePay/render.yaml) and [`Dockerfile`](file:///C:/Users/sunny/Desktop/TradePay/Dockerfile) for zero-downtime deployment:

1. Push to your GitHub repository.
2. In [Render Dashboard](https://dashboard.render.com), select **New +** -> **Blueprint**.
3. Connect your repository. Render will automatically detect `render.yaml`.
4. (Optional) Set environment variables in Render:
   - `SUPABASE_URL`: `https://vhzfbacpvfjdpkthxvej.supabase.co`
   - `SUPABASE_KEY`: `<your-supabase-anon-key>`
5. Click **Apply**.
