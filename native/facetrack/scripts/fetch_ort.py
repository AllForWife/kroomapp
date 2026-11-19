#!/usr/bin/env python3
# 抓微軟官方的 ONNX Runtime 執行檔（MIT 授權，可隨 App 附帶）到 native/facetrack/ort/<平台>/：
#   mac-arm64、mac-x64：PyPI 的 onnxruntime（含 CoreML；Intel Mac 最後一版是 1.23.2）→ libonnxruntime.dylib
#   win-x64：PyPI 的 onnxruntime-directml（含 DirectML，任何 DX12 顯卡）→ onnxruntime.dll、DirectML.dll
#   只用標準函式庫（urllib、zipfile），不用 pip。版本固定，檔案用 PyPI 給的 sha256 驗證。
#   python3 native/facetrack/scripts/fetch_ort.py [mac-arm64 mac-x64 win-x64]
import hashlib, json, os, subprocess, sys, urllib.request, zipfile, io

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, '..', 'ort')
PLATS = {
    'mac-arm64': ('onnxruntime', '1.32.0', 'macosx', 'arm64', {'libonnxruntime.dylib': r'capi/libonnxruntime.'}),
    'mac-x64': ('onnxruntime', '1.23.2', 'macosx', 'x86_64', {'libonnxruntime.dylib': r'capi/libonnxruntime.'}),
    'win-x64': ('onnxruntime-directml', '1.24.4', 'win_amd64', 'win_amd64', {'onnxruntime.dll': 'capi/onnxruntime.dll', 'DirectML.dll': 'capi/DirectML.dll', 'onnxruntime_providers_shared.dll': 'capi/onnxruntime_providers_shared.dll'}),
}
def get(url):
    # (python.org 版 Python 沒裝憑證時 urllib 會失敗 → 改用系統的 curl)
    try: return urllib.request.urlopen(url).read()
    except Exception: return subprocess.run(['curl', '-sSfL', url], check=True, capture_output=True).stdout
def pick(pkg, ver, plat, arch):
    meta = json.loads(get(f'https://pypi.org/pypi/{pkg}/{ver}/json'))
    c = [u for u in meta['urls'] if u['filename'].endswith('.whl') and plat in u['filename'] and arch in u['filename'] and '-cp312-' in u['filename']]
    if not c: raise SystemExit(f'{pkg} {ver}: 找不到 {plat} {arch} 的 wheel')
    return c[0]
for p in (sys.argv[1:] or PLATS.keys()):
    pkg, ver, plat, arch, files = PLATS[p]; u = pick(pkg, ver, plat, arch)
    print(p, '←', u['filename']); data = get(u['url'])
    if hashlib.sha256(data).hexdigest() != u['digests']['sha256']: raise SystemExit('sha256 不符')
    z = zipfile.ZipFile(io.BytesIO(data)); d = os.path.join(OUT, p); os.makedirs(d, exist_ok=True)
    names = z.namelist()
    for dst, src in files.items():
        hit = [n for n in names if n.startswith('onnxruntime/' + src) and (n.endswith('.dylib') or n.endswith('.dll'))]
        if not hit: raise SystemExit(f'wheel 裡沒有 {src}')
        open(os.path.join(d, dst), 'wb').write(z.read(sorted(hit, key=len)[0]))
    for lic in ('onnxruntime/LICENSE', 'onnxruntime/ThirdPartyNotices.txt'):
        if lic in names: open(os.path.join(d, os.path.basename(lic)), 'wb').write(z.read(lic))
    print('  →', d, sorted(os.listdir(d)))
