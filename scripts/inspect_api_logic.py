import os
import re

base_dir = r"extracted_apk/assets/apps/__UNI__BA00479/www"
app_service_path = os.path.join(base_dir, "app-service.js")

with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

# Let's search for network request definitions (uni.request, request interceptor, baseUrl, gateway, etc.)
lines = code.split('\n')
print(f"Total lines: {len(lines)}")

# Let's search for keywords in app-service
keywords = ["gateway", "request(", "baseURL", "baseUrl", "BASE_URL", "token", "header", "dispatchRule", "onSell", "offSell", "confirmRiskOrderPay"]
for kw in keywords:
    matches = [m.start() for m in re.finditer(re.escape(kw), code)]
    print(f"Keyword '{kw}': {len(matches)} occurrences")
    for pos in matches[:3]:
        snippet = code[max(0, pos-150):min(len(code), pos+250)].replace('\n', ' ')
        print(f"   [{kw}] ...{snippet}...\n")
