# TradePay Frontend Audit — Prioritized Plan (Re-audit after fixes)

**Re-audit date:** 2026-11-02 · **Baseline commits fixed by user:** `31ffe79 fix(ui): resolve Vue mounting, unclosed modal nesting, and scroll lock bugs`, `ac35443 fix(ui): complete remaining TradePay UI plan`

**Files audited:** `public/index.html` (3,115 lines), `public/admin.html` (1,351 lines), `public/css/view.css` (62 KB minified), plus `public/sw.js` (66 lines), `public/manifest.json`, cross-checked against `server/index.js`, `server/routes/api.js`, `server/engine/*`.

**Method:** full reads/greps of all files, programmatic tag-balance verification (index 351/351 `div`, admin 135/135 `div` — both balanced), `node --check` on every extracted `<script>` block (all OK), Vue `setup()`-return vs template-binding cross-check, and endpoint/payload verification against the server code. No live browser testing.

**Status legend:** ✅ FIXED in `31ffe79`/`ac35443` · ⚠️ PARTIALLY fixed (residue listed) · ❌ STILL OPEN

---

# SECTION 0 — FIXED IN `31ffe79` / `ac35443` (verified, no action needed)

| # | Original finding | Status | Verification evidence |
|---|---|---|---|
| 1.8 | Missing `</div>` → `#app` never closed, modals nested inside app | ✅ Fixed | `div` balance 351/351; `</div>` at L2041 immediately before `<audio>` L2043. `node --check` on extracted scripts: OK. |
| 1.3 | `:key="tx.buyId"` / `copyTransactionUtr(tx.utr, tx.buyId)` | ⚠️ Partial | L1649/L1696/L1697 now use `tx.id \|\| tx.buyId \|\| tx.orderNo`. **Residue:** L824 still `:key="tx.buyId"`, L1649 still has `v-else` + `v-for` on one element. |
| 1.2 | `tx.totalReward` → `+₹0.00` | ⚠️ Partial | L1685 now `tx.reward ?? tx.totalReward ?? 0`. **Residue:** L851 still `formatMoney(tx.totalReward)`. |
| 1.9 | Marquee `animate-marquee` dead (no keyframes) | ❌ Open (see R-09) | Zero `@keyframes` anywhere; L510 unchanged. |
| 2.2 | `#app` flash of unstyled content (no `v-cloak`) | ✅ Fixed (index) / ❌ Open (admin) | index L270 `[v-cloak]` CSS + L274 `<div id="app" v-cloak …>`. Admin `#app` (L66) still has no `v-cloak` → see R-12. |
| 3.1 | No backdrop-click close, no Esc, no body scroll lock (index) | ⚠️ Partial | `handleModalEscape`/`closeOpenModals` added (L2254, registered L3264, removed L3308); `@click.self` on all overlays **except iosInstall L332 and the install banner**; `body.modal-open` watch (L2238, CSS L62). **Admin: still no `@click.self`, no Escape, no scroll lock** → see R-14. |
| 3.2 | Double-submit on confirm/reject/payout | ⚠️ Partial | Admin `confirmDeposit`/`confirmAndCredit`/`confirmReject` now guard on `actionLoading` (L1046+, L1130+); `rejectSubmitting`/`payoutSubmitting` (L1085, L1162) + `:disabled` bindings. Index `confirmClaimOrder` (L2878) / `submitActiveOrder` (L2925) have `loading` guards. **Residue:** `saveNewWallet` (L2989), `claimMission` (L3055), `toggleWalletStatus` (L2857) still unguarded → see R-15. |
| 2.4-adjacent | Admin mobile viewport / zoom lock | ✅ Fixed | `<meta … viewport-fit=cover>` (L5), `maximum-scale` removed; new `admin-shell`/`admin-modal-backdrop`/`admin-modal-panel` dvh + safe-area CSS. **Residue:** locked overlay leaves dashboard tabbable; poll `setInterval` (L1401) never cleared → see R-16. |
| 4.1 | `text-gray-500` unreadable on `#1E1E1E` | ⚠️ Partial | All `text-gray-500` → `gray-400` (0 occurrences remain in both files). **Residue:** placeholders unchanged (index 11× `placeholder-gray-600` + 1× `placeholder-gray-500`; admin 1× `placeholder-gray-600` + 3× `placeholder-gray-500`); 7× `text-[9px]`, 1× `text-[8px]` remain → see R-20. |
| 3.4 | Deposit UTR input unvalidated | ✅ Fixed | L1824: `inputmode="numeric" maxlength="32"` + `isDepositUtrValid` computed (allows blank), client 12-digit check in `submitDepositPayment`, `isValidUpiId()` hardening. **Residue:** rest of inputs lack `inputmode`/`autocomplete` → see R-18. |
| — | Row filter / data guards | ✅ Fixed | `safeRecords` + `isValidTransactionRow` row filter (covers all server statuses `pending/confirming/processing/verifying/completed/rejected/cancelled/expired` with id/buyId/orderNo), `watch` on `usdtEnabled` closes USDT modal, `switchTab` closes all modals (L~2360), admin `dataLoading`/`dataError`/`safeRecords` states, admin `min-h-11` buttons, admin toast error color. |
| 3.11 (index) | WS reconnect re-entrancy / backoff | ✅ Fixed (index) / ❌ Open (admin) | index `connectWebSocket` guards `CONNECTING \|\| OPEN`, fixed 3000 ms retry. **Admin `connectWs` (L1343) has no guard, `ws.onclose` (L1374) reconnects unconditionally** → see R-05 / R-17. |
| 3.9 | Admin viewport | ✅ Fixed (see above) | — |

**Syntax/structure health:** all extracted `<script>` blocks pass `node --check`; both documents tag-balanced; no new runtime errors introduced by the two fix commits.

---

# SECTION 1 — CRITICAL BUGS & RUNTIME ERRORS (remaining)

## R-01 ❌ Deposit banner opens modal at the WRONG step — shows "Payment Confirmed & Credited" for deposits still only *verifying*
`index.html` L501 (unchanged from original plan)

The template still sets `step = status === 'verifying' ? 3 : 2`. Step 3 is the success/credited screen (rendered at L1884). A user waiting for admin approval resumes into a screen telling them the money is already credited. Correct mapping: `verifying → step 2` (L1837), `pending → step 1` (L1767). Step 3 must only be reached via the real WS `DEPOSIT_VERIFIED` event (L3198).

**Before (L501):**
```html
<button @click="modals.deposit.show = true; modals.deposit.step = activeDeposit.status === 'verifying' ? 3 : 2; activeDepositOrder = activeDeposit" class="px-3.5 py-2 rounded-xl bg-emerald-500 text-black text-xs font-bold shadow hover:brightness-110 active:scale-95 transition whitespace-nowrap flex-shrink-0">
```
**After:**
```html
<button @click="openDepositResumeModal" class="px-3.5 py-2 rounded-xl bg-emerald-500 text-black text-xs font-bold shadow hover:brightness-110 active:scale-95 transition whitespace-nowrap flex-shrink-0">
```
```js
// add to setup(), and to the return object
function openDepositResumeModal() {
  const dep = activeDeposit.value;
  if (!dep) return;
  activeDepositOrder.value = dep;
  // pending   = UTR not submitted yet → payment/UTR form (step 1)
  // verifying = awaiting ADMIN check   → submitting view (step 2)
  // step 3 ("credited") is ONLY reached via the real WS DEPOSIT_VERIFIED event
  modals.deposit.step = dep.status === 'verifying' ? 2 : 1;
  modals.deposit.show = true;
}
```

---

## R-02 ❌ Residue of 1.2: wallet-tab preview still renders **"+₹0.00"** for every order
`index.html` L851

`paymentEngine.getUserUnifiedTransactions()` sends `reward`, not `totalReward` (withdrawal rows carry `totalReward: 0`). L1685 was fixed but L851 (wallet tab, top-3 preview) was missed.

**Before (L851):**
```html
<span class="font-bold text-emerald-400">+₹{{ formatMoney(tx.totalReward) }}</span>
```
**After:**
```html
<span class="font-bold text-emerald-400">+₹{{ formatMoney(tx.reward ?? tx.totalReward ?? 0) }}</span>
```

---

## R-03 ❌ Residue of 1.3: `:key="tx.buyId"` + `v-else`/`v-for` on the same element
`index.html` L824 and L1649

Server sends `id: o.buyId || o.id` (paymentEngine.js L663) — `tx.buyId` is `undefined` on every unified row → duplicate keys, corrupted list diffing in the wallet preview.

**Before (L824):**
```html
<div v-for="tx in userTransactions.slice(0, 3)" :key="tx.buyId" @click="openTransactionsHistoryModal('all')" class="rounded-2xl bg-[#242424] border border-white/5 p-3.5 hover:border-white/15 transition cursor-pointer space-y-2.5">
```
**After:**
```html
<div v-for="tx in userTransactions.slice(0, 3)" :key="tx.id || tx.buyId || tx.orderNo" @click="openTransactionsHistoryModal('all')" class="rounded-2xl bg-[#242424] border border-white/5 p-3.5 hover:border-white/15 transition cursor-pointer space-y-2.5">
```

L1649 still puts `v-else` and `v-for` on the same element (undefined priority in Vue 3 — the `v-for` may render even when the empty-state branch is active):

**Before (L1649):**
```html
<div v-else v-for="tx in filteredTransactions" :key="tx.id || tx.buyId || tx.orderNo" class="rounded-2xl bg-[#242424] border p-4 space-y-3 transition" :class="...">
```
**After** (wrap in `<template v-else>`):
```html
<template v-else>
  <div v-for="tx in filteredTransactions" :key="tx.id || tx.buyId || tx.orderNo" class="rounded-2xl bg-[#242424] border p-4 space-y-3 transition" :class="...">
    <!-- unchanged row content -->
  </div>
</template>
```

---

## R-04 ❌ Logout / 401 leaves the **previous account's balance, nickname, UTRs and wallets on screen**
`index.html` `handleLogout` L2435 + `authFetch` 401 path L2293

`resetPrivateState` was never added. `handleLogout()` clears the token, closes WS and calls `fetchAll()` — but `fetchAll()` early-returns (`if (!token.value) return;`) so private reactive state (user, summary, wallets, hangSalesList, userTransactions, activeDeposit, activeClaimedOrder, nightBonus) is never reset. Same leak on the 401 path.

**Before (L2435):**
```js
async function handleLogout() {
  try {
    await authFetch('/app/user/info/appLogout', { method: 'POST' });
  } catch (e) { /* best effort */ }
  token.value = '';
  localStorage.removeItem('tradepay_token');
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch (e) { /* ignore */ }
    ws = null;
  }
  showToast('Signed out successfully');
  fetchAll();
}
```
**After:**
```js
function resetPrivateState() {
  Object.assign(user, { id: '', nickname: '', phone: '', balance: 0, vipLevel: 1, inviteCode: '', points: 0, isAdmin: false, isPinSet: false });
  Object.assign(summary, { balance: 0, rewardTotal: 0, pendingWithdrawal: 0, usdtEnabled: false });
  wallets.value = [];
  hangSalesList.value = [];
  userTransactions.value = [];
  activeDeposit.value = null;
  activeClaimedOrder.value = null;
  activeWithdrawal.value = null;
  nightBonus.inRangeNow = false;
  Object.keys(modals).forEach(k => { if (modals[k]) modals[k].show = false; });
}

async function handleLogout() {
  try {
    await authFetch('/app/user/info/appLogout', { method: 'POST' });
  } catch (e) { /* best effort */ }
  token.value = '';
  localStorage.removeItem('tradepay_token');
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch (e) { /* ignore */ }
    ws = null;
  }
  resetPrivateState();          // <-- add
  showToast('Signed out successfully');
  fetchAll();
}
```
And in `authFetch` (L2293), add `resetPrivateState();` inside the `if (res.status === 401)` block after `ws = null;` (plus `showToast('Session expired, please sign in again', 'error')`).

---

## R-05 ❌ Admin WebSocket chain: console authenticates with a **user** token, receives **user-scoped** ADMIN events, shows a hardcoded "Live Sync" pill
`admin.html` L129-134, L1343-1352, L962 · `server/index.js` L215, L266-281 · `server/engine/paymentEngine.js` L198, L435 · `server/engine/orderEngine.js` L310 · `server/engine/adminAuth.js` L87

Four linked defects:

1. **Server WS AUTH** (`server/index.js` L215) only calls `auth.authenticateToken(data.token)` — the admin console sends `localStorage.getItem('tradepay_token')` (a *user* token; usually absent in the admin browser) so the admin WS connection is either unauthenticated or authenticated as a random user. `adminAuth.verifySessionToken` (adminAuth.js L87) exists and is used by HTTP (`api.js` L119) but is **not wired into the WS path**.
2. **ADMIN_* payloads carry `userId`** (paymentEngine L198/L435, orderEngine L310), and `broadcastAll` (index.js L266-281) filters by `payload.userId` vs `meta.userId` → an admin connected as a user only receives events for *that* user; an unauthenticated admin receives nothing. The verification queue silently misses events.
3. **Admin pill is hardcoded** (admin L129-134): static "Live WebSocket Sync" dot regardless of actual connection state.
4. **`lockConsole()` (L962) leaves the WS open** and `ws.onclose` (L1374) reconnects forever even after logout/lock.

**Fix (deploy server + admin.html together):**

*server/index.js L215:*
```js
// Before
const user = await auth.authenticateToken(String(data.token || ''));
// After
let user = null;
let isAdmin = false;
const admin = adminAuth.verifySessionToken(String(data.token || ''));
if (admin) {
  isAdmin = true;
  user = { id: 'admin:' + (admin.adminId || 'console') };
} else {
  user = await auth.authenticateToken(String(data.token || ''));
}
```
then skip the `payload.userId` filter for admin sockets in `broadcastAll` (L268-274):
```js
if (meta.isAdmin) continue;                 // admin sockets get every ADMIN_* event
if (targetUserId && meta.userId !== targetUserId) continue;
```
(Store `isAdmin` in the `clients.set(ws, { userId, isAdmin })` map at L227.)

*admin.html `connectWs` L1348-1352:*
```js
ws.onopen = () => {
  const session = localStorage.getItem('tradepay_admin_session');
  if (session) ws.send(JSON.stringify({ type: 'AUTH', token: session }));
};
```
*admin.html L129-134 pill:*
```html
<div class="flex items-center gap-2 px-2.5 py-1 rounded-full border" :class="wsConnected ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-white/10 bg-white/5'">
  <span class="w-2 h-2 rounded-full" :class="wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'"></span>
  <span class="font-medium text-[11px]" :class="wsConnected ? 'text-emerald-300' : 'text-gray-400'">{{ wsConnected ? 'Live WebSocket Sync' : 'Reconnecting…' }}</span>
</div>
```
```js
const wsConnected = ref(false);
// in ws.onopen: wsConnected.value = true;
// in ws.onclose: wsConnected.value = false;
```
*`lockConsole` L962:* also do `if (ws) { ws.onclose = null; try { ws.close(); } catch(e){} ws = null; } wsConnected.value = false;`

---

## R-06 ❌ Admin deposit/withdrawal tiles always show **₹0.00**
`admin.html` L179, L192 · `server/routes/api.js` L1130-1153

`stats.pendingDepositsAmount` / `stats.pendingWithdrawalsAmount` are read in the template but **never returned by `/api/admin/stats`** (the endpoint computes only order pending/completed figures), so `|| 0` renders ₹0.00 forever.

**Before (server `api.js`, inside `return ok(res, { … })`):**
```js
const pendingAmount = pending.reduce((sum, o) => money.add(sum, o.amount || 0), 0);
// ... existing fields only
```
**After:**
```js
const pendingDeps = Object.values(state.deposits || {}).filter(d => d.status === 'verifying' || d.status === 'pending');
const pendingWths = Object.values(state.withdrawals || {}).filter(w => w.status === 'pending' || w.status === 'verifying');
return ok(res, {
  // ...existing fields...
  pendingDepositsAmount: pendingDeps.reduce((s, d) => money.add(s, d.amount || 0), 0),
  pendingWithdrawalsAmount: pendingWths.reduce((s, w) => money.add(s, w.amount || 0), 0),
});
```
(No client change needed — L835/L839 already default both to `0`.)

---

## R-07 ❌ `sw.js` unchanged: stale-shell cache + cache-poisoning navigation branch + opaque CDN responses never cached
`public/sw.js` L1-66 (file untouched since 29-10; still `tradepay-pwa-v3`)

Three defects remain exactly as audited:

1. **Precache `'/'` and `'/index.html'` at install**, then serve HTML *network-first* — but a failed network fetch falls back to the **precached v3 shell forever**; combined with no `update`/`skipWaiting` versioning discipline users can be stuck on old HTML after a deploy until hard refresh.
2. **Navigation branch caches whatever response arrives**, including `opaque`/error responses — a single failed navigation poisons the shell.
3. **Opaque CDN responses** (Tailwind/unpkg scripts) are stored but `cache.match` can't validate them; cross-origin no-cors responses should be cached only when `response.ok || response.type === 'opaque'` *and* explicitly allowlisted, or fetched with a CORS-aware strategy.

**After (sketch — bump to v4 so old caches die in `activate`):**
```js
const CACHE_NAME = 'tradepay-pwa-v4';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/app/') || url.pathname.startsWith('/ws')) return;
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request).then(r => r || caches.match('/index.html')))
    );
    return;
  }
  // cache-first for static assets, but never cache non-OK responses
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
      }
      return res;
    }))
  );
});
```

---

## R-08 ❌ `view.css` is a 62 KB minified uni-app dump shipped to every page load
`public/css/view.css` (62,503 bytes, untouched)

Still linked from both HTML heads; contains `uni-icon`/`uni-` prefixed rules unused by this app. It is render-blocking on 3G. Either delete the `<link>` (verify no rule is referenced — audit found none) or trim to the handful of used selectors.

---

## R-09 ❌ Live notice marquee is dead — `animate-marquee` has no `@keyframes`
`index.html` L510 · zero `@keyframes` in the entire file

**Before (L508-512):**
```html
<div class="overflow-hidden whitespace-nowrap flex-1">
  <div class="inline-block animate-marquee">
    {{ activeNotice }}
  </div>
</div>
```
**After** (add to the `<style>` block):
```css
@keyframes marquee {
  0%   { transform: translateX(100%); }
  100% { transform: translateX(-100%); }
}
.animate-marquee {
  animation: marquee 12s linear infinite;
  padding-left: 100%;
}
@media (prefers-reduced-motion: reduce) {
  .animate-marquee { animation: none; padding-left: 0; }
}
```
(Or drop `animate-marquee` and render the notice as plain static text — the current class does literally nothing.)

---

## R-10 ❌ Admin alert sound points at a file that doesn't exist
`admin.html` L70 — only `public/sounds/dcloud_beep.ogg` exists

**Before (L69-71):**
```html
<audio id="alertAudio" preload="auto">
  <source src="/sounds/beep.wav" type="audio/wav">
</audio>
```
**After:**
```html
<audio id="alertAudio" preload="auto">
  <source src="/sounds/dcloud_beep.ogg" type="audio/ogg">
</audio>
```
Mitigated today by `playSynthBeep()` fallback (L892), but every beep pays a 404 first — and `audio.play()` rejects with `NotAllowedError` *before* the missing-file error on iOS, so the synth fallback path is unreliable. Also add `@error`-style resilience: in `playBeep()` (L877) prefer `playSynthBeep()` directly if `audio.error` is set.

---

# SECTION 2 — LAYOUT & MOBILE ISSUES (remaining)

## R-11 ❌ `.modal-sheet` overrides the fixed `.modal-panel` max-height — sheets can exceed the visual viewport
`index.html` L184-192 vs fixed L176-183 · usages L1171, L1566, L1747, L1909

`.modal-panel` was corrected to `100dvh - 2rem - safe-insets`, but `.modal-sheet` (declared **after** it, same specificity) still uses the old `100dvh - env(safe-area-inset-top)` with **no bottom inset**, and `max-h-[92vh] sm:max-h-[85vh]` utility overrides at L1566/L1747/L1909 beat both rules on mobile.

**Before (L184-192):**
```css
.modal-sheet {
  max-height: calc(100vh - env(safe-area-inset-top, 0px));
  max-height: calc(100dvh - env(safe-area-inset-top, 0px));
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding-bottom: calc(1.25rem + env(safe-area-inset-bottom, 0px)) !important;
}
```
**After:**
```css
.modal-sheet {
  max-height: calc(100vh - 2rem);
  max-height: calc(100dvh - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
```
And remove `max-h-[92vh] sm:max-h-[85vh]` from L1566, L1747, L1909 (let the CSS rule own max-height), or replace with `max-h-[calc(100dvh-2rem)]`.

---

## R-12 ❌ Admin has no `v-cloak` — raw `{{ }}` template flashes on load
`admin.html` L66 (index is fixed)

**Before (L66):**
```html
<div id="app" class="admin-shell flex-1 flex flex-col max-w-7xl w-full mx-auto space-y-6">
```
**After:**
```html
<div id="app" v-cloak class="admin-shell flex-1 flex flex-col max-w-7xl w-full mx-auto space-y-6">
```
plus in the `<style>` block:
```css
[v-cloak] { display: none !important; }
```

---

## R-13 ❌ Sub-44px touch targets remain across index (✕ buttons, copy-ID, chip rows)
`index.html` L392, L327, L339, L1082, L1177, L1228, L1392, L1426, L1479, L1513, L1544, and `py-1` chip rows

- L392: `class="… text-[11px] p-0.5"` copy-ID button (~16px hit area).
- L327: install-banner ✕ `text-sm p-1`.
- Ten modal ✕ buttons are bare `class="text-gray-400 hover:text-white text-lg"` (~20px).
- Filter/mission chips use `py-1`.

**Before (representative, L392):**
```html
<button @click="copyText(String(user.id))" class="text-gray-400 hover:text-white text-[11px] p-0.5 transition" title="Copy ID">
```
**After:**
```html
<button @click="copyText(String(user.id))" class="text-gray-400 hover:text-white text-[11px] min-h-11 min-w-11 -my-2 -mx-1 flex items-center justify-center transition" title="Copy ID">
```
**Before (all ✕ buttons, e.g. L1082):**
```html
<button @click="modals.auth.show = false" class="text-gray-400 hover:text-white text-lg">✕</button>
```
**After:**
```html
<button @click="modals.auth.show = false" aria-label="Close" class="text-gray-400 hover:text-white text-lg min-h-11 min-w-11 -mr-2 flex items-center justify-center rounded-lg">✕</button>
```
(Apply the same `min-h-11 min-w-11 flex items-center justify-center` pattern — already used by admin — to L339, L1177, L1228, L1392, L1426, L1479, L1513, L1544; bump chip rows from `py-1` to `py-2`.)

---

## R-14 ❌ Admin modals: no backdrop-dismiss, no Escape, no body scroll lock
`admin.html` L704, L736, L772 · no `Escape`/`@click.self`/`body.style.overflow` anywhere in the file

The admin console got dvh/safe-area CSS in `ac35443` but none of the index-side dismissal work was ported: reject modal (L704), payout modal (L736) and QR modal (L772) can only be closed via their ✕ buttons; the dashboard behind them keeps scrolling on phones.

**Before (L704):**
```html
<div v-if="rejectModal.show" class="admin-modal-backdrop fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center">
```
**After:**
```html
<div v-if="rejectModal.show" @click.self="rejectModal.show = false" class="admin-modal-backdrop fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center">
```
(Repeat for L736 `payoutModal` and L772 `qrModal`.) Add to `setup()`:
```js
const onKey = (e) => {
  if (e.key !== 'Escape') return;
  if (qrModal.show) qrModal.show = false;
  else if (payoutModal.show) payoutModal.show = false;
  else if (rejectModal.show && !rejectSubmitting.value) rejectModal.show = false;
};
onMounted(() => document.addEventListener('keydown', onKey));
onUnmounted(() => document.removeEventListener('keydown', onKey));
watch(() => rejectModal.show || payoutModal.show || qrModal.show, open => {
  document.body.classList.toggle('modal-open', open);
});
```
(plus `body.modal-open { overflow: hidden; }` in the admin `<style>`.)

---

## R-15 ⚠️ Three index submit paths still have no double-submit guard (3.2 residue)
`index.html` L2857 `toggleWalletStatus`, L2989 `saveNewWallet`, L3055 `claimMission`

`confirmClaimOrder`/`submitActiveOrder`/`submitWithdrawalRequest` were guarded in `ac35443`; these three were not. Tapping twice on flaky mobile networks double-binds a wallet / double-claims a mission.

**Before (L2989):**
```js
async function saveNewWallet() {
  const upiId = String(newWallet.account || '').trim();
  if (!isValidUpiId(upiId)) { showToast('Please enter a valid UPI ID (e.g. mobile@ybl or username@upi)'); return; }
  try { /* ... */ } catch (e) { showToast('Failed to add wallet'); }
}
```
**After:**
```js
const saveWalletSubmitting = ref(false);
async function saveNewWallet() {
  if (saveWalletSubmitting.value) return;
  const upiId = String(newWallet.account || '').trim();
  if (!isValidUpiId(upiId)) { showToast('Please enter a valid UPI ID (e.g. mobile@ybl or username@upi)'); return; }
  saveWalletSubmitting.value = true;
  try { /* ...unchanged... */ } catch (e) { showToast('Failed to add wallet'); }
  finally { saveWalletSubmitting.value = false; }
}
```
Same `if (x.loading) return; … finally …` pattern for `claimMission(m)` (guard on a per-mission `m.claiming` flag) and `toggleWalletStatus(w)` (guard on `w.toggling` or a shared ref), and add `:disabled` bindings on the three buttons.

---

## R-16 ⚠️ Admin lock/poll residue (3.9): locked dashboard stays tabbable; poll interval leaks
`admin.html` L962 `lockConsole`, L1401 `setInterval`, L1406 `onUnmounted`

- The unlock overlay (`v-if="!isUnlocked"`, L76) sits **above** the dashboard DOM — background buttons/inputs remain keyboard-tabbable and screen-reader reachable while "locked".
- `setInterval(..., 30000)` at L1401 is never `clearInterval`'d (only `ws.close()` in `onUnmounted` L1406) → keeps firing `fetchData()` after the tab is closed/navigated in SPA-less teardown, and continues while locked.

**Before (L1401 + L1406):**
```js
setInterval(() => {
  if (isUnlocked.value) fetchData();
}, 30000);
// ...
onUnmounted(() => {
  if (ws) ws.close();
});
```
**After:**
```js
const pollTimer = setInterval(() => {
  if (isUnlocked.value) fetchData();
}, 30000);
// ...
onUnmounted(() => {
  clearInterval(pollTimer);
  if (ws) ws.close();
});
```
And gate the background: `<div v-if="isUnlocked" …>` on the dashboard root (or `inert` binding: `:inert="!isUnlocked"` — supported in modern browsers).

---

## R-17 ❌ Admin WS has no re-entrancy guard and reconnects forever (3.11 residue)
`admin.html` L1343 `connectWs`, L1374-1376 `ws.onclose`

Index was fixed in `ac35443`; admin wasn't. `fetchData()` success path (L1392) and any re-entry can call `connectWs()` while a socket is already `CONNECTING`, leaking sockets; after `lockConsole()` the `setTimeout(connectWs, 3000)` loop runs forever.

**Before (L1343-1347):**
```js
function connectWs() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  try {
    ws = new WebSocket(wsUrl);
```
**After:**
```js
function connectWs() {
  if (!isUnlocked.value) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  try {
    ws = new WebSocket(wsUrl);
```
```js
// L1374
ws.onclose = () => {
  wsConnected.value = false;
  if (isUnlocked.value) setTimeout(connectWs, 3000);
};
```

---

# SECTION 3 — UX & INTERACTION ISSUES (remaining)

## R-18 ❌ Withdrawal modal `step` is set but never declared or rendered (dead state machine)
`index.html` L2160 (declaration) vs L2671, L2673, L2737, L3220 (assignments) · template L1908-2039 has no step views

`modals.withdrawal` is declared as `{ show, amount, payoutType, pin, loading, upiId, … }` — **no `step`** — yet code assigns `.step = 2/3`, and the template never branches on it. After submit, `loading` flips back to `false` and the form re-enables, so a user can submit a second withdrawal while the first is pending review; the "Immediately switch to Review Status!" comment at L2737 does nothing.

**Before (L2160):**
```js
withdrawal: { show: false, amount: '', payoutType: 'upi', pin: '', loading: false, upiId: '', accountName: '', bankName: '', accountNumber: '', ifsc: '' }
```
**After:**
```js
withdrawal: { show: false, step: 1, amount: '', payoutType: 'upi', pin: '', loading: false, upiId: '', accountName: '', bankName: '', accountNumber: '', ifsc: '' }
```
Then split the modal body (L1940-2035) into three branches mirroring the deposit modal:
```html
<div v-if="modals.withdrawal.step === 1" class="space-y-4"> …amount/payout form… </div>
<div v-else-if="modals.withdrawal.step === 2" class="space-y-4 text-center py-4"> …reviewing spinner, activeWithdrawal… </div>
<div v-else-if="modals.withdrawal.step === 3" class="space-y-4 text-center py-4"> …completed / txRef… </div>
```
and reset `modals.withdrawal.step = 1` in the modal's close handler (and in `switchTab`, which already zeroes `show`).

---

## R-19 ❌ Input hygiene: missing `inputmode`/`autocomplete`/`enterkeyhint`; PIN input unvalidated client-side
`index.html` L1946, L1987, L1991, L1999, L2004, L2008, L2013, L2020 · admin: **zero** `inputmode` in the whole file · only 1 `inputmode` exists (L1824)

The deposit UTR input was fixed; everything else wasn't. Worst case is the withdrawal PIN (L2020): `type="password" maxlength="6"` with no `inputmode="numeric"`, no `pattern`, no client `\d{6}` check — on iOS the user gets the full alphabetic keyboard, and a malformed PIN is only rejected after a round-trip (`requestWithdrawal` verifies server-side, paymentEngine L~460).

**Before (L2020):**
```html
<input type="password" v-model="modals.withdrawal.pin" maxlength="6" placeholder="Enter 6-digit PIN" class="w-full px-3 py-2.5 rounded-xl bg-[#1A1A1A] border border-white/10 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50">
```
**After:**
```html
<input type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]{6}" maxlength="6" placeholder="Enter 6-digit PIN" class="w-full px-3 py-2.5 rounded-xl bg-[#1A1A1A] border border-white/10 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-amber-500/50">
```
plus client check in `submitWithdrawalRequest` (before `modals.withdrawal.loading = true`, L2723):
```js
if (modals.withdrawal.pin && !/^\d{6}$/.test(modals.withdrawal.pin)) {
  showToast('PIN must be exactly 6 digits', 'error');
  return;
}
```
Also apply: `inputmode="numeric" autocomplete="cc-number"`-style attributes to L1946 (amount), L1999 (account number), `autocomplete="off"` + `enterkeyhint="go"` on UPI/IFSC fields, and `enterkeyhint="done"` on PIN. Admin needs the same treatment on its key/amount inputs.

---

## R-20 ❌ Toast system: error type renders neutral in index, no timer race guard, admin uses `animate-bounce`, no transitions
`index.html` L306 (markup), L2279 (`showToast`) · `admin.html` L798 (markup), L870 · index has exactly 1 `<transition>` (L305); admin 0

1. **Index error toasts are visually identical to info toasts** — `toastClass` was never created (0 references); L306 branches only on `success`.
2. **Timer race:** `showToast` schedules `setTimeout(() => toast.show = false, 2500)` without clearing the previous timer — a second toast within 2.5 s is dismissed early by the first timer.
3. **Admin toast bounces forever** while visible (`animate-bounce` on L798).
4. **No enter/leave transitions** — toasts pop in/out.

**Before (index L306):**
```html
<div v-if="toast.show" class="app-toast fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-xs font-medium shadow-2xl flex items-center gap-2 border" :class="toast.type === 'success' ? 'bg-emerald-950/90 text-emerald-200 border-emerald-500/30' : 'bg-[#2A2A2A] text-white border-white/10'">
```
**After:**
```html
<transition enter-active-class="transition duration-200" enter-from-class="opacity-0 -translate-y-2" leave-active-class="transition duration-200" leave-to-class="opacity-0 -translate-y-2">
  <div v-if="toast.show" role="status" aria-live="polite" class="app-toast fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-xs font-medium shadow-2xl flex items-center gap-2 border" :class="toast.type === 'success' ? 'bg-emerald-950/90 text-emerald-200 border-emerald-500/30' : (toast.type === 'error' ? 'bg-red-950/90 text-red-200 border-red-500/40' : 'bg-[#2A2A2A] text-white border-white/10')">
```
(close `</transition>` after the div.)

**Before (index `showToast` L2279):**
```js
function showToast(msg, type = 'info') {
  toast.message = msg;
  toast.type = type;
  toast.show = true;
  setTimeout(() => { toast.show = false; }, 2500);
}
```
**After:**
```js
let toastTimer = null;
function showToast(msg, type = 'info') {
  toast.message = msg;
  toast.type = type;
  toast.show = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.show = false; }, 2500);
}
```
**Admin L798:** replace `animate-bounce` with a `<transition …>` slide-in (and the same `clearTimeout` guard in its `showToast` L870).

---

## R-21 ❌ `copyText` uses bare `navigator.clipboard` — fails on HTTP, old iOS Safari, and non-secure contexts
`index.html` L2382 · `admin.html` L1217

`navigator.clipboard` is `undefined` outside secure contexts → `TypeError` swallowed by `.catch`, falling back to *showing the raw text in a toast* (admin always does this). Production may be HTTPS, but the app is also opened over LAN/IP during development and on iOS 12-13 Safari.

**Before (index L2382):**
```js
function copyText(txt) {
  if (!txt) return;
  navigator.clipboard.writeText(String(txt)).then(() => {
    showToast('Copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Copied: ' + txt, 'success');
  });
}
```
**After:**
```js
function copyText(txt) {
  if (!txt) return;
  const value = String(txt);
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(ok ? 'Copied to clipboard!' : 'Copy failed: ' + value, ok ? 'success' : 'error');
    } catch (e) {
      showToast('Copy failed: ' + value, 'error');
    }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value)
      .then(() => showToast('Copied to clipboard!', 'success'))
      .catch(fallback);
  } else {
    fallback();
  }
}
```
(Apply identically in `admin.html` L1217.)

---

## R-22 ❌ Silent `catch {}` blocks hide real failures
`admin.html` L1214 (`spawnSampleTestOrder`), L937-966 region · `index.html` various `catch (e) {}`

**Before (admin L1203-1215):**
```js
async function spawnSampleTestOrder() {
  try {
    const res = await fetch('/api/sim/spawn-order', { method: 'POST', headers: getAuthHeaders() });
    const json = await res.json();
    if (json.code === 1000) {
      showToast(`Test matching order ₹${json.data.amount} spawned!`, 'success');
      fetchData();
    }
  } catch (e) {}
}
```
**After:**
```js
async function spawnSampleTestOrder() {
  try {
    const res = await fetch('/api/sim/spawn-order', { method: 'POST', headers: getAuthHeaders() });
    const json = await res.json();
    if (json.code === 1000) {
      showToast(`Test matching order ₹${json.data.amount} spawned!`, 'success');
      fetchData();
    } else {
      showToast(json.message || 'Failed to spawn test order', 'error');
    }
  } catch (e) {
    showToast('Network error while spawning test order', 'error');
  }
}
```
Same treatment for index `fetchSummary`/`fetchUserInfo`-style `catch (e) {}` where the failure is user-visible (at minimum `console.warn('[TradePay]', label, e)`).

---

## R-23 ❌ Admin `fetchData` runs 7 requests sequentially — up to ~7 RTTs of blank dashboard per refresh
`admin.html` L969-1035 (`await` chain at L977, L988, L995, L1002, L1009, L1016, L1023)

On a 300 ms RTT mobile connection that's >2 s per poll tick, and `dataLoading` covers the whole window.

**Before (L976-1030, condensed):**
```js
const statsRes = await fetch('/api/admin/stats', { headers });
// ...parse...
const pendRes = await fetch('/api/admin/orders/pending', { headers });
// ...parse...
const allRes = await fetch('/api/admin/orders/all', { headers });
// ...6 more sequential awaits...
```
**After:**
```js
const headers = getAuthHeaders();
const [statsRes, pendRes, allRes, depRes, allDepRes, wthRes, allWthRes] = await Promise.all([
  fetch('/api/admin/stats', { headers }),
  fetch('/api/admin/orders/pending', { headers }),
  fetch('/api/admin/orders/all', { headers }),
  fetch('/api/admin/deposits/pending', { headers }),
  fetch('/api/admin/deposits/all', { headers }),
  fetch('/api/admin/withdrawals/pending', { headers }),
  fetch('/api/admin/withdrawals/all', { headers }),
]);
if (statsRes.status === 401 || statsRes.status === 403) { lockConsole(); return; }
const [statsJson, pendJson, allJson, depJson, allDepJson, wthJson, allWthJson] =
  await Promise.all([statsRes, pendRes, allRes, depRes, allDepRes, wthRes, allWthRes].map(r => r.json()));
if (statsJson.code === 1000) Object.assign(stats, statsJson.data);
// ...assign the rest as before...
```
(Keep the per-response 401/403 check by testing status codes before the `.json()` fan-out.)

---

## R-24 ❌ `manifest.json` deep link `/?tab=payment` is dead — no URL parsing
`public/manifest.json` `start_url`/`url` vs `index.html` L2052

`const activeTab = ref('home')` — the app never reads `location.search`, so the PWA "open on Payment tab" intent does nothing (the only `URLSearchParams` use is inside `fetchHangSales`, L2485).

**Before (index L2052):**
```js
const activeTab = ref('home');
```
**After:**
```js
const VALID_TABS = ['home', 'payment', 'wallet', 'team'];
const initialTab = new URLSearchParams(location.search).get('tab');
const activeTab = ref(VALID_TABS.includes(initialTab) ? initialTab : 'home');
if (activeTab.value !== 'home') {
  // fetch the tab's data once mounted (inside onMounted after fetchAll)
}
```

---

## R-25 ⚠️ WS backoff residue + fake defaults (3.11/3.12)
`index.html` L3256 area (fixed 3000 ms — acceptable), `admin.html` L1375 (covered by R-17) · `index.html` L2079, L2103

- **`nightBonus.inRangeNow: true` (L2103)** — before `fetchNightBonus()` resolves, the home tab shows the "night bonus" badge/card (L670, L711) for users who aren't in range. Default to `false`; only the server response turns it on.
- **Default `user` object (L2079) lacks `isAdmin` / `isPinSet`** — templates read `user.isAdmin` (L736, L981) and `user.isPinSet` (L981, L2018, L3084). `undefined` renders the wrong label ("Set Up >" shows when state is unknown) and briefly hides admin buttons. Add `isAdmin: false, isPinSet: false` to the default.

**Before (L2102-2106):**
```js
const nightBonus = reactive({
  inRangeNow: true,
  startTime: '22:00',
  endTime: '06:00'
});
```
**After:**
```js
const nightBonus = reactive({
  inRangeNow: false,
  startTime: '22:00',
  endTime: '06:00'
});
```
**Before (L2079-2087):**
```js
const user = reactive({
  id: '10086',
  nickname: 'Trader',
  phone: '+919876543210',
  balance: 0.00,
  vipLevel: 1,
  inviteCode: 'TP8899',
  points: 0
});
```
**After:** add `isAdmin: false, isPinSet: false,` (and prefer `id: ''`, `nickname: ''`, `phone: ''` so no fake identity flashes).

---

## R-26 ⚠️ iosInstall modal lacks `@click.self`; install banner has no backdrop at all
`index.html` L332 (overlay), L327 (banner ✕ `p-1`)

Every other modal got backdrop-dismiss in `31ffe79`; the iOS install modal (L332) was missed.

**Before (L332):**
```html
<div v-if="modals.iosInstall.show" class="modal-overlay fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
```
**After:**
```html
<div v-if="modals.iosInstall.show" @click.self="modals.iosInstall.show = false" class="modal-overlay fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
```
It is also automatically covered once `closeOpenModals()` (L2254) includes it — verify `handleModalEscape` iterates all `modals` keys (it does, via `Object.keys(modals)`).

---

# SECTION 4 — DESIGN & POLISH (remaining)

## R-27 ❌ red-vs-rose inconsistency (4.2)
`admin.html`: 32 `red-*` classes · `index.html` L1023 `text-red-400`, L1114 `bg-red-500`, L1366 `bg-red-500/15 border-red-500/50`

The palette is `rose-500` for rejection (index L1649 history rows use `border-rose-500/30`) but `red-*` elsewhere. Pick one (recommend **rose-500** to match the existing gradient themes `from-[#281b1c]`) and sed-swap:
```powershell
(Get-Content public/admin.html) -replace 'red-(\d{3})','rose-$1' | Set-Content public/admin.html
(Get-Content public/index.html) -replace 'text-red-400','text-rose-400' -replace 'bg-red-500','bg-rose-500' | Set-Content public/index.html
```
(Keep `red` only if a deliberate "destructive" distinction is wanted — but then use it consistently in both files.)

---

## R-28 ❌ Accessibility: zero `aria-label` in index, 3 total in admin, 3 `aria-live`/`role="status"` total (4.3)
`index.html`: 0 `aria-label` · `admin.html`: 3 (modal ✕ only, L711/L743/…) · both files: 3 `aria-live`/`role="status"`

Minimum set:
- All ✕ close buttons: `aria-label="Close"` (see R-13 snippet — covers ~11 buttons).
- Toasts: `role="status" aria-live="polite"` (index L306, admin L798 — see R-20).
- Icon-only action buttons: `aria-label` on copy-ID (L392), copy-UTR (L1696), audio toggle, filter chips (`aria-pressed`).
- The marquee notice (L510): `role="marquee"` is wrong — use a plain `<p>` with `aria-live="off"` (avoid screen-reader spam).
- Modal overlays: `role="dialog" aria-modal="true"` + `:aria-labelledby` pointing at the `<h3>`.

---

## R-29 ❌ No loading skeleton for the Payment tab (4.4)
`index.html` — `hangLoading`/skeleton markup: 0 matches

`fetchHangSales()` has no loading state; the tab shows "No orders in this range right now." (L734) for the entire fetch, which reads as "empty" on slow networks.

**Before (L734):**
```html
<div v-if="hangSalesList.length === 0" class="py-12 text-center text-gray-400 text-xs space-y-3">
```
**After:**
```js
const hangLoading = ref(false);
async function fetchHangSales() {
  hangLoading.value = true;
  try { /* ...unchanged... */ } finally { hangLoading.value = false; }
}
```
```html
<div v-if="hangLoading" class="py-12 space-y-3" aria-busy="true">
  <div class="h-20 rounded-2xl bg-[#242424] animate-pulse"></div>
  <div class="h-20 rounded-2xl bg-[#242424] animate-pulse"></div>
  <div class="h-20 rounded-2xl bg-[#242424] animate-pulse"></div>
</div>
<div v-else-if="hangSalesList.length === 0" class="py-12 text-center text-gray-400 text-xs space-y-3">
```

---

## R-30 ❌ Placeholder + micro-text residue (4.1 residue)
- `placeholder-gray-600`: **11× index** (L1276, L1803, L1824, L1946, L1987, L1991, L1999, L2004, L2008, L2013, L2020), **1× admin**; `placeholder-gray-500`: 1× index, **3× admin** — all below the contrast floor on `#1A1A1A`/`#1E1E1E`.
- `text-[9px]`: 7× index; `text-[8px]`: 1× — below legibility on mobile.

**Fix:**
```powershell
(Get-Content public/index.html) -replace 'placeholder-gray-600','placeholder-gray-400' -replace 'placeholder-gray-500','placeholder-gray-400' -replace 'text-\[9px\]','text-[10px]' -replace 'text-\[8px\]','text-[10px]' | Set-Content public/index.html
(Get-Content public/admin.html) -replace 'placeholder-gray-600','placeholder-gray-400' -replace 'placeholder-gray-500','placeholder-gray-400' | Set-Content public/admin.html
```

---

## R-31 ❌ Banner image has no `@error` fallback (2.5)
`index.html` L518

**Before (L518):**
```html
<img :src="banners[bannerIndex]" class="w-full h-full object-cover transition-all duration-700" alt="Banner">
```
**After:**
```html
<img :src="banners[bannerIndex]" @error="$event.target.style.display='none'" class="w-full h-full object-cover transition-all duration-700" alt="Banner">
```
(or swap in `/static/logo/icon-512.png` on error).

---

## R-32 ❌ iOS zoom guard uses `font-size: 16px !important` instead of `max(16px, 1em)` (2.4)
`index.html` ~L196-200

**Before:**
```css
@supports (-webkit-touch-callout: none) {
  input, select, textarea {
    font-size: 16px !important;
  }
}
```
**After:**
```css
@supports (-webkit-touch-callout: none) {
  input, select, textarea {
    font-size: max(16px, 1em) !important;
  }
}
```
(`16px !important` forces *every* input to 16px, inflating the small `text-[11px]`/`text-xs` inputs and breaking layouts that rely on them; `max()` keeps small text small while still defeating iOS auto-zoom, which triggers below 16px.)

---

# PRIORITY ORDER FOR THE NEXT FIX PASS

| Priority | Items | Why |
|---|---|---|
| P0 | **R-01** deposit step inversion · **R-05** admin WS chain (server + admin.html **together**) · **R-04** logout/401 state leak | User-facing wrong data / security-adjacent: "credited" lie, admin queue misses events, cross-account data leak on shared devices. |
| P1 | **R-06** ₹0 admin tiles · **R-02** L851 `+₹0.00` · **R-03** L824 key + `v-else v-for` · **R-18** withdrawal dead `step` | Visible incorrect numbers / broken list rendering / double-withdrawal risk. |
| P2 | **R-07** sw.js v4 · **R-09** marquee · **R-10** beep.wav · **R-11** `.modal-sheet` · **R-12** admin v-cloak | Broken assets and layout overflow; cheap one-liners. |
| P3 | **R-14** admin modal dismiss · **R-17** admin WS guard · **R-15** submit guards · **R-16** lock/poll residue · **R-19** input hygiene · **R-20** toasts · **R-21** clipboard | UX batch — each is small and independent. |
| P4 | **R-22** silent catches · **R-23** `Promise.all` · **R-24** tab param · **R-25** fake defaults · **R-26** iosInstall self-close | Performance/robustness. |
| P5 | **R-08** view.css · **R-27** red/rose · **R-28** ARIA · **R-29** skeleton · **R-30** placeholder/text sizes · **R-31** banner `@error` · **R-32** zoom guard | Polish — safe mechanical sed passes. |

**Deploy note:** R-05 requires shipping `server/index.js` (WS AUTH + `broadcastAll` admin bypass) and `public/admin.html` (session AUTH + pill + lock-closes-WS) in the **same release**; a mixed deploy either drops admin events or exposes user tokens to the admin socket.
