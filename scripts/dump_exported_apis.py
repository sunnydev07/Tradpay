import os

app_service_path = r"extracted_apk/assets/apps/__UNI__BA00479/www/app-service.js"
with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

pos = code.find('e.endpoints=s;')
if pos != -1:
    end = min(len(code), pos + 4000)
    print("=== EXPORTED APIS ===")
    print(code[pos:end])
