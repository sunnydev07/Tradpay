import os
import re

app_service_path = r"extracted_apk/assets/apps/__UNI__BA00479/www/app-service.js"
with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

# Locate where coverOrder, collectionRiskOrder, wallet, user, etc. are declared
# Look around 'collectionRiskOrder:{createRiskOrder:'
pos = code.find('collectionRiskOrder:{createRiskOrder:')
if pos != -1:
    start = max(0, pos - 2000)
    end = min(len(code), pos + 3000)
    print("=== API URL MAP & METHODS ===")
    print(code[start:end])
