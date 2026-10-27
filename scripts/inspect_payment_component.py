import os
import re

app_service_path = r"extracted_apk/assets/apps/__UNI__BA00479/www/app-service.js"
with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

# Search for component declaration for pages/payment/payment
pos = code.find('pages/payment/payment.vue')
if pos != -1:
    snippet = code[max(0, pos-1000):min(len(code), pos+3000)]
    print("=== PAYMENT.VUE SNIPPET ===")
    print(snippet)
else:
    print("Not found with .vue")
