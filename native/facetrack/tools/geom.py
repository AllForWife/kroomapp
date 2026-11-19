# 讀 MediaPipe geometry_pipeline_metadata_landmarks.binarypb（手寫的 protobuf 解析）→ canonical.json：478 個標準臉頂點＋Procrustes 權重
import sys, struct, json
b = open(sys.argv[1], 'rb').read()
def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
        if c < 0x80: return r, i
def fields(b):
    i, out = 0, []
    while i < len(b):
        k, i = varint(b, i); f, t = k >> 3, k & 7
        if t == 0: v, i = varint(b, i)
        elif t == 2: n, i = varint(b, i); v = b[i:i + n]; i += n
        elif t == 5: v = b[i:i + 4]; i += 4
        elif t == 1: v = b[i:i + 8]; i += 8
        else: raise ValueError(t)
        out.append((f, t, v))
    return out
top = fields(b); print('counts', {f: sum(1 for x in top if x[0] == f) for f in (1, 2, 3)}); print('top fields', sorted(set((f, t) for f, t, _ in top)))
mesh = [v for f, t, v in top if f == 1 and t == 2][0]
basis = [fields(v) for f, t, v in top if f == 2 and t == 2]
mf = fields(mesh); print('mesh fields', sorted(set((f, t) for f, t, _ in mf)))
vb = b''.join(v for f, t, v in mf if f == 3 and t in (2, 5)); floats = struct.unpack('<%df' % (len(vb) // 4), vb)
nv = len(floats) // 5; print('vertices', nv, 'basis', len(basis))
verts = [floats[i * 5:i * 5 + 3] for i in range(nv)]
bas = []
for fl in basis:
    d = {f: v for f, t, v in fl}; bas.append([d.get(1, 0), struct.unpack('<f', d[2])[0] if 2 in d else 0.0])
json.dump({'v': [[round(x, 6) for x in p] for p in verts], 'w': bas}, open(sys.argv[2], 'w'))
print('sample', verts[1], bas[:3])
