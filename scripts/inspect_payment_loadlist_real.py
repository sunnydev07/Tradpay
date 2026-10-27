import os

app_service_path = r"extracted_apk/assets/apps/__UNI__BA00479/www/app-service.js"
with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

pos = code.find('pages/payment/payment.vue:401')
if pos != -1:
    pos2 = code.find('loadList:function', pos)
    print(code[pos2:pos2+2000])
