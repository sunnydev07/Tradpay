import os
import re

app_service_path = r"extracted_apk/assets/apps/__UNI__BA00479/www/app-service.js"
with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

def search_usages(name):
    print(f"\n================ USAGES OF: {name} ================")
    matches = [m.start() for m in re.finditer(re.escape(name), code)]
    for m in matches[:5]:
        snippet = code[max(0, m - 150):min(len(code), m + 350)].replace('\n', ' ')
        print(f"--- match at {m} ---")
        print(snippet)

search_usages("orderApi.summary")
search_usages("orderApi.orderInfo")
search_usages("walletApi.getWalletList")
search_usages("userApi.info")
search_usages("teamApi.teamDetails")
