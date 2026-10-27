import os

app_service_path = r"extracted_apk/assets/apps/__UNI__BA00479/www/app-service.js"
with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

pos = code.find('uni.request({url:C,method:t,data:n,header:$,timeout:b,success:function(t){')
if pos != -1:
    print(code[pos-2500:pos-1000])
