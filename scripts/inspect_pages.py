import os
import re

app_service_path = r"extracted_apk/assets/apps/__UNI__BA00479/www/app-service.js"
with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

pages = [
    "pages/home/home",
    "pages/payment/payment",
    "pages/wallet/wallet",
    "pages/team/team",
    "pages/user/my",
    "pages/payment/inr-order",
    "pages/home/usdt-order"
]

for p in pages:
    matches = [m.start() for m in re.finditer(re.escape(p), code)]
    print(f"\n================ Page: {p} ({len(matches)} occurrences) ================")
    for idx, pos in enumerate(matches[:2]):
        snippet = code[max(0, pos-200):min(len(code), pos+400)].replace('\n', ' ')
        print(f"[{idx}] {snippet}\n")
