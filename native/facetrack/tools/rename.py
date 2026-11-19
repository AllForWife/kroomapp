# 把 ONNX 裡所有節點／張量名稱換成安全的識別字（CoreML ML Program 不吃 ':' '/' 等字元）
import sys, onnx, re
m = onnx.load(sys.argv[1]); g = m.graph; mp = {}
keep = {i.name for i in g.input} | {o.name for o in g.output}
def nm(x):
    if not x or x in keep and False: return x
    if x not in mp: mp[x] = 't%d' % len(mp)
    return mp[x]
for i in g.input: i.name = nm(i.name)
for o in g.output: o.name = nm(o.name)
for t in g.initializer: t.name = nm(t.name)
for v in g.value_info: v.name = nm(v.name)
for k, n in enumerate(g.node):
    n.name = 'n%d' % k
    for j in range(len(n.input)): n.input[j] = nm(n.input[j]) if n.input[j] else ''
    for j in range(len(n.output)): n.output[j] = nm(n.output[j])
onnx.save(m, sys.argv[2])
