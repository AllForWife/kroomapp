# 最終模型：固定 batch=1、auto_pad 改明確 pads、名稱換成安全識別字（CPU／DirectML／CoreML 都吃）
import sys, subprocess
src, dst, here = sys.argv[1], sys.argv[2], sys.argv[3]
import onnx
m = onnx.load(src)
for vi in list(m.graph.input) + list(m.graph.output):
    for d in vi.type.tensor_type.shape.dim:
        if not d.dim_value: d.ClearField('dim_param'); d.dim_value = 1
del m.graph.value_info[:]; onnx.save(m, dst + '.tmp')
subprocess.check_call([sys.executable, '-I', here + '/pads.py', dst + '.tmp', dst + '.tmp2'])
subprocess.check_call([sys.executable, '-I', here + '/rename.py', dst + '.tmp2', dst])
import os; os.remove(dst + '.tmp'); os.remove(dst + '.tmp2')
m = onnx.load(dst); onnx.checker.check_model(m); print(dst, [i.name for i in m.graph.input], [o.name for o in m.graph.output])
