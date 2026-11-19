# ONNX 整理：輸入固定 batch=1、PRelu 換成 Max(x,0)+α·Min(x,0)（CoreML 不吃 PRelu，會切成很多段）、onnxruntime 預先最佳化
import sys, onnx, numpy as np
from onnx import helper, numpy_helper
src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src); g = m.graph
for vi in list(g.input) + list(g.output):
    for d in vi.type.tensor_type.shape.dim:
        if not d.dim_value: d.ClearField('dim_param'); d.dim_value = 1
nodes = []; k = 0
for n in g.node:
    if n.op_type == 'PRelu':
        x, a = n.input; y = n.output[0]; k += 1; z = f'prelu_zero_{k}'
        g.initializer.append(numpy_helper.from_array(np.zeros((), np.float32), z))
        nodes += [helper.make_node('Max', [x, z], [f'{y}_pos']), helper.make_node('Min', [x, z], [f'{y}_neg']), helper.make_node('Mul', [f'{y}_neg', a], [f'{y}_negs']), helper.make_node('Add', [f'{y}_pos', f'{y}_negs'], [y])]
    else: nodes.append(n)
del g.node[:]; g.node.extend(nodes)
del g.value_info[:]
m = onnx.shape_inference.infer_shapes(m); onnx.checker.check_model(m); onnx.save(m, dst); print(src, 'PRelu replaced', k)
