import os
import re
import json

base_dir = r"extracted_apk/assets/apps/__UNI__BA00479/www"
app_service_path = os.path.join(base_dir, "app-service.js")

with open(app_service_path, "r", encoding="utf-8", errors="ignore") as f:
    code = f.read()

print("File size:", len(code), "characters")

# Find HTTP URLs
urls = set(re.findall(r'https?://[^\s\'"<>]+', code))
print("\n--- URLs Found ---")
for u in sorted(urls):
    print(u)

# Find WebSockets
ws_urls = set(re.findall(r'wss?://[^\s\'"<>]+', code))
print("\n--- WebSockets Found ---")
for w in sorted(ws_urls):
    print(w)

# Find API paths like /api/...
api_paths = set(re.findall(r'[\'"](/api/[^\'"]+)[\'"]', code))
print(f"\n--- API Endpoints ({len(api_paths)}) ---")
for p in sorted(api_paths):
    print(p)

# Find other potential endpoints
endpoints = set(re.findall(r'[\'"](/[a-zA-Z0-9_\-]+/[a-zA-Z0-9_\-/]+)[\'"]', code))
relevant = [p for p in endpoints if any(k in p for k in ['order', 'pay', 'user', 'auth', 'wallet', 'deposit', 'withdraw', 'team', 'integral', 'airdrop', 'task', 'token', 'login', 'register'])]
print(f"\n--- Relevant Paths ({len(relevant)}) ---")
for p in sorted(relevant):
    print(p)
