import os
import re

app_service_path = r"extracted_apk/assets/apps/__UNI__BA00479/www/app-service.js"
with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

pos = code.find('uni.request({url:C,method:t,data:n,header:$,timeout:b,success:function(t){')
if pos != -1:
    snippet = code[pos:pos+1500]
    print("=== REQUEST SUCCESS HANDLER ===")
    print(snippet)
else:
    matches = [m.start() for m in re.finditer(r'uni\.request', code)]
    for m in matches[:5]:
        print("uni.request at:", m)
        print(code[m:m+500])
