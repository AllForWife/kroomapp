# ONNX 臉部管線（參考實作）vs MediaPipe FaceLandmarker：同一張照片比對地標與 52 個 blendshape
import sys, math, numpy as np, onnxruntime as ort
from PIL import Image
import mediapipe as mp
M = sys.argv[1]
SUB = [0,1,4,5,6,7,8,10,13,14,17,21,33,37,39,40,46,52,53,54,55,58,61,63,65,66,67,70,78,80,81,82,84,87,88,91,93,95,103,105,107,109,127,132,133,136,144,145,146,148,149,150,152,153,154,155,157,158,159,160,161,162,163,168,172,173,176,178,181,185,191,195,197,234,246,249,251,263,267,269,270,276,282,283,284,285,288,291,293,295,296,297,300,308,310,311,312,314,317,318,321,323,324,332,334,336,338,356,361,362,365,373,374,375,377,378,379,380,381,382,384,385,386,387,388,389,390,397,398,400,402,405,409,415,454,466,468,469,470,471,472,473,474,475,476,477]
assert len(SUB) == 146, len(SUB)
det = ort.InferenceSession(f'{M}/face_detector.onnx'); lmk = ort.InferenceSession(f'{M}/face_landmarks_detector.onnx'); bsm = ort.InferenceSession(f'{M}/face_blendshapes.onnx')
def anchors():
    a = []
    for stride, n in ((8, 2), (16, 6)):
        g = 128 // stride
        for y in range(g):
            for x in range(g):
                for _ in range(n): a.append(((x + .5) / g, (y + .5) / g))
    return np.array(a, np.float32)
ANC = anchors(); assert len(ANC) == 896
def warp(img, cx, cy, w, h, rot, size):
    # 旋轉的方形 ROI → size×size（雙線性，外面補 0）
    W, H = img.shape[1], img.shape[0]; out = np.zeros((size, size, 3), np.float32)
    u = (np.arange(size) + .5) / size - .5; uu, vv = np.meshgrid(u, u)
    c, s = math.cos(rot), math.sin(rot)
    px = cx * W + (uu * w * W) * c - (vv * h * H) * s; py = cy * H + (uu * w * W) * s + (vv * h * H) * c
    x0 = np.floor(px - .5).astype(int); y0 = np.floor(py - .5).astype(int); fx = px - .5 - x0; fy = py - .5 - y0
    def at(x, y):
        ok = (x >= 0) & (x < W) & (y >= 0) & (y < H); v = np.zeros((size, size, 3), np.float32); v[ok] = img[y[ok], x[ok]]; return v
    out = at(x0, y0) * ((1 - fx) * (1 - fy))[..., None] + at(x0 + 1, y0) * (fx * (1 - fy))[..., None] + at(x0, y0 + 1) * ((1 - fx) * fy)[..., None] + at(x0 + 1, y0 + 1) * (fx * fy)[..., None]
    return out
def detect(img):
    H, W = img.shape[:2]; s = max(W, H)
    # 置中補邊成正方形再縮到 128（letterbox）
    t = warp(img, .5, .5, s / W, s / H, 0, 128) / 127.5 - 1
    r, c = det.run(None, {'input': t[None].astype(np.float32)}); r, c = r[0], 1 / (1 + np.exp(-np.clip(c[0, :, 0], -100, 100)))
    i = int(np.argmax(c)); 
    if c[i] < .5: return None
    v = r[i] / 128; ax, ay = ANC[i]
    cx, cy, w, h = v[0] + ax, v[1] + ay, v[2], v[3]; kp = [(v[4 + 2 * k] + ax, v[5 + 2 * k] + ay) for k in range(6)]
    # letterbox 座標 → 原圖正規化座標
    sx, sy = s / W, s / H; un = lambda x, y: ((x - .5) * sx + .5, (y - .5) * sy + .5)
    cx, cy = un(cx, cy); w, h = w * sx, h * sy; kp = [un(*p) for p in kp]
    return dict(score=float(c[i]), cx=cx, cy=cy, w=w, h=h, kp=kp)
def roi_from(cx, cy, w, h, p0, p1, W, H):
    rot = -math.atan2(-(p1[1] - p0[1]) * H, (p1[0] - p0[0]) * W); rot = (rot + math.pi) % (2 * math.pi) - math.pi
    side = max(w * W, h * H) * 1.5
    return cx, cy, side / W, side / H, rot
def landmarks(img, roi):
    cx, cy, w, h, rot = roi; H, W = img.shape[:2]
    t = warp(img, cx, cy, w, h, rot, 256) / 255.
    o = lmk.run(None, {lmk.get_inputs()[0].name: t[None].astype(np.float32)})
    pts = o[0].reshape(478, 3); pres = 1 / (1 + math.exp(-float(o[1].ravel()[0])))
    c, s = math.cos(rot), math.sin(rot); u = pts[:, 0] / 256 - .5; v = pts[:, 1] / 256 - .5
    x = cx + (u * w * W * c - v * h * H * s) / W; y = cy + (u * w * W * s + v * h * H * c) / H; z = pts[:, 2] / 256 * w   # (z 跟 x 同尺度)
    return np.stack([x, y, z], 1), pres
def blend(lm, W, H, mode):
    p = lm[SUB, :2].copy()
    if mode == 'px': p[:, 0] *= W; p[:, 1] *= H
    return bsm.run(None, {bsm.get_inputs()[0].name: p[None].astype(np.float32)})[0]
for f in sys.argv[2:]:
    img = np.asarray(Image.open(f).convert('RGB')).astype(np.float32); H, W = img.shape[:2]
    d = detect(img); print(f, 'detect', d and round(d['score'], 3))
    roi = roi_from(d['cx'], d['cy'], d['w'], d['h'], d['kp'][0], d['kp'][1], W, H)
    lm, pres = landmarks(img, roi)
    # 第二輪：用地標重算 ROI（追蹤時就是這樣）
    xs, ys = lm[:, 0], lm[:, 1]; roi2 = roi_from((xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2, xs.max() - xs.min(), ys.max() - ys.min(), lm[33], lm[263], W, H)
    lm2, pres2 = landmarks(img, roi2)
    fl = mp.tasks.vision.FaceLandmarker.create_from_options(mp.tasks.vision.FaceLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_path=f'{M}/face_landmarker.task'), output_face_blendshapes=True, output_facial_transformation_matrixes=True, num_faces=1))
    r = fl.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(Image.open(f).convert('RGB'))))
    ref = np.array([[p.x, p.y, p.z] for p in r.face_landmarks[0]]); names = [c.category_name for c in r.face_blendshapes[0]]; refb = np.array([c.score for c in r.face_blendshapes[0]])
    for k, L in (('first', lm), ('tracked', lm2)): print(' ', k, 'presence', round(pres if k == 'first' else pres2, 3), 'landmark err px', round(float(np.abs(L[:, :2] - ref[:, :2]).mean() * W), 2))
    for mode in ('norm', 'px'):
        b_ref_in = blend(ref, W, H, mode); b_mine = blend(lm2, W, H, mode)
        print(' ', mode, 'blend(mp landmarks) vs mp max err', round(float(np.abs(b_ref_in - refb).max()), 4), '| full onnx pipeline vs mp max err', round(float(np.abs(b_mine - refb).max()), 4))
    top = np.argsort(-refb)[:6]; print('  top mp', [(names[i], round(float(refb[i]), 2)) for i in top]); print('  top us', [(names[i], round(float(blend(lm2, W, H, 'px')[i]), 2)) for i in top])
    np.set_printoptions(precision=4, suppress=True); print('  matrix', np.array(r.facial_transformation_matrixes[0]).round(3).tolist()[:3])

# ── 頭部轉向：加權 Procrustes（標準臉 → 偵測到的地標），跟 MediaPipe 的變換矩陣比旋轉
import json
CAN = json.load(open(f'{M}/canonical.json')); CV = np.array(CAN['v']); BI = [int(i) for i, _ in CAN['w']]; BW = np.array([w for _, w in CAN['w']])
def head_rot(lm, W, H):
    P = np.stack([lm[:, 0] * W, -lm[:, 1] * H, -lm[:, 2] * W], 1)[BI]; C = CV[BI]; w = BW / BW.sum()
    mp_, mc = (w[:, None] * P).sum(0), (w[:, None] * C).sum(0); Pc, Cc = P - mp_, C - mc
    U, S, Vt = np.linalg.svd((w[:, None] * Pc).T @ Cc); d = np.sign(np.linalg.det(U @ Vt)); D = np.diag([1, 1, d])
    return U @ D @ Vt
def ang(R1, R2): return math.degrees(math.acos(max(-1, min(1, (np.trace(R1.T @ R2) - 1) / 2))))
for f in sys.argv[2:]:
    img = np.asarray(Image.open(f).convert('RGB')).astype(np.float32); H, W = img.shape[:2]
    fl = mp.tasks.vision.FaceLandmarker.create_from_options(mp.tasks.vision.FaceLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_path=f'{M}/face_landmarker.task'), output_facial_transformation_matrixes=True, num_faces=1))
    r = fl.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(Image.open(f).convert('RGB'))))
    ref = np.array([[p.x, p.y, p.z] for p in r.face_landmarks[0]]); Mx = np.array(r.facial_transformation_matrixes[0])[:3, :3]; Mx = Mx / np.cbrt(np.linalg.det(Mx))
    d = detect(img); lm, _ = landmarks(img, roi_from(d['cx'], d['cy'], d['w'], d['h'], d['kp'][0], d['kp'][1], W, H))
    print(f, 'head rot diff vs mediapipe: from mp landmarks %.2f°, from our landmarks %.2f°' % (ang(head_rot(ref, W, H), Mx), ang(head_rot(lm, W, H), Mx)))

# MediaPipe geometry_pipeline 的做法：透視相機（垂直 FOV 63°、near 1）把螢幕地標換成公制座標，兩輪估尺度
def procrustes(C, P, w):
    w = w / w.sum(); mp_, mc = (w[:, None] * P).sum(0), (w[:, None] * C).sum(0); Pc, Cc = P - mp_, C - mc
    U, S, Vt = np.linalg.svd((w[:, None] * Pc).T @ Cc); D = np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))]); R = U @ D @ Vt
    s = (S * np.diag(D)).sum() / (w[:, None] * Cc * Cc).sum(); return s, R
def head_rot_mp(lm, W, H, fov=63):
    near = 1; h = 2 * near * math.tan(math.radians(fov) / 2); wd = h * W / H; left, bottom = -wd / 2, -h / 2
    S = lm.T.copy().astype(np.float64); S[1] = 1 - S[1]; S *= np.array([[wd], [h], [wd]]); S[0] += left; S[1] += bottom
    dz = S[2].mean(); C = CV[BI]; w = BW
    def est(L): return procrustes(C, L.T[BI], w)[0]
    I = S.copy(); I[2] *= -1; s1 = est(I)
    def metric(sc): L = S.copy(); L[2] = (L[2] - dz + near) / sc; L[0] *= L[2] / near; L[1] *= L[2] / near; L[2] *= -1; return L
    s2 = est(metric(s1)); L = metric(s1 * s2); return procrustes(C, L.T[BI], w)[1]
for f in sys.argv[2:]:
    img = np.asarray(Image.open(f).convert('RGB')).astype(np.float32); H, W = img.shape[:2]
    fl = mp.tasks.vision.FaceLandmarker.create_from_options(mp.tasks.vision.FaceLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_path=f'{M}/face_landmarker.task'), output_facial_transformation_matrixes=True, num_faces=1))
    r = fl.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(Image.open(f).convert('RGB'))))
    ref = np.array([[p.x, p.y, p.z] for p in r.face_landmarks[0]]); Mx = np.array(r.facial_transformation_matrixes[0])[:3, :3]; Mx = Mx / np.cbrt(np.linalg.det(Mx))
    d = detect(img); lm, _ = landmarks(img, roi_from(d['cx'], d['cy'], d['w'], d['h'], d['kp'][0], d['kp'][1], W, H))
    print(f, 'MP-style head rot diff: from mp landmarks %.3f°, from our landmarks %.2f°' % (ang(head_rot_mp(ref, W, H), Mx), ang(head_rot_mp(lm, W, H), Mx)))
