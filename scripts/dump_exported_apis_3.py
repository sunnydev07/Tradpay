import os

app_service_path = r"extracted_apk/assets/apps/__UNI__BA00479/www/app-service.js"
with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

pos = code.find('var y={getLatestAppVersion:')
if pos != -1:
    end = min(len(code), pos + 3000)
    print("=== EXPORTED APIS PART 3 ===")
    print(code[pos:end])
