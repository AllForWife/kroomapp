# Conv／MaxPool 的 auto_pad（SAME_UPPER…）換成明確的 pads（CoreML ML Program 需要）
import sys, onnx
from onnx import helper
m = onnx.shape_inference.infer_shapes(onnx.load(sys.argv[1])); g = m.graph
shapes = {v.name: [d.dim_value for d in v.type.tensor_type.shape.dim] for v in list(g.value_info) + list(g.input) + list(g.output)}
inits = {t.name: list(t.dims) for t in g.initializer}
n_fix = 0
for n in g.node:
    if n.op_type not in ('Conv', 'MaxPool', 'AveragePool'): continue
    at = {a.name: a for a in n.attribute}
    ap = at.get('auto_pad'); mode = ap.s.decode() if ap else 'NOTSET'
    k = list(at['kernel_shape'].ints) if 'kernel_shape' in at else inits[n.input[1]][2:]
    s = list(at['strides'].ints) if 'strides' in at else [1] * len(k)
    d = list(at['dilations'].ints) if 'dilations' in at else [1] * len(k)
    if mode in ('SAME_UPPER', 'SAME_LOWER'):
        ish = shapes[n.input[0]][2:]; b, e = [], []
        for i in range(len(k)):
            out = -(-ish[i] // s[i]); tot = max(0, (out - 1) * s[i] + (k[i] - 1) * d[i] + 1 - ish[i])
            lo = tot // 2 if mode == 'SAME_UPPER' else tot - tot // 2; b.append(lo); e.append(tot - lo)
        pads = b + e
    elif mode == 'VALID': pads = [0] * (2 * len(k))
    elif 'pads' in at: continue
    else: pads = [0] * (2 * len(k))
    keep = [a for a in n.attribute if a.name not in ('auto_pad', 'pads')]
    del n.attribute[:]; n.attribute.extend(keep); n.attribute.extend([helper.make_attribute('pads', pads)]); n_fix += 1
onnx.save(m, sys.argv[2]); print(sys.argv[1], 'fixed', n_fix)
