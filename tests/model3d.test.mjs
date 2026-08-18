/* 小宝CAD 3D 文档模型单元测试（用模拟内核验证 model3d 逻辑） */
import { strict as assert } from 'node:assert';
import { Model3D } from '../js/three-dim/model3d.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

/** 模拟内核：实现 occ-kernel.js 契约 */
function mockKernel() {
  const calls = { create: [], boolean: [], transform: [], mesh: [], deleted: [] };
  let nextId = 1;
  const k = {
    calls,
    createBox(p) { calls.create.push(['box', p]); return nextId++; },
    createCylinder(p) { calls.create.push(['cylinder', p]); return nextId++; },
    createSphere(p) { calls.create.push(['sphere', p]); return nextId++; },
    createCone(p) { calls.create.push(['cone', p]); return nextId++; },
    createTorus(p) { calls.create.push(['torus', p]); return nextId++; },
    boolean(op, a, bs) { calls.boolean.push([op, a, [...bs]]); return nextId++; },
    fillet(id, r) { calls.boolean.push(['fillet', id, r]); return nextId++; },
    chamfer(id, d) { calls.boolean.push(['chamfer', id, d]); return nextId++; },
    transform(id, t) { calls.transform.push([id, { ...t }]); },
    mesh(id) {
      calls.mesh.push(id);
      return { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
    },
    bbox() { return { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 }; },
    volume() { return 1000; },
    deleteBody(id) { calls.deleted.push(id); },
    exportSTL() { return new Uint8Array([1, 2, 3]); },
    exportSTEP() { return new Uint8Array([4, 5, 6]); },
    importSTEP() { return [nextId++]; },
    dispose() {},
  };
  return k;
}

console.log('== Model3D（模拟内核） ==');
{
  const m = new Model3D();
  const k = mockKernel();
  m.setKernel(k);
  const box = m.addPrimitive('box', { x: 0, y: 0, z: 0, dx: 10, dy: 20, dz: 30 });
  const cyl = m.addPrimitive('cylinder', { x: 0, y: 0, z: 0, r: 5, h: 40 });
  const meshes = m.evaluate();
  assert.equal(k.calls.create.length, 2);
  assert.deepEqual(k.calls.create[0][1], { x: 0, y: 0, z: 0, dx: 10, dy: 20, dz: 30 });
  assert.equal(meshes.length, 2);
  assert.equal(meshes[0].indices.length, 3);
  ok('创建两个基本体并求值出网格');
}
{
  const m = new Model3D();
  const k = mockKernel();
  m.setKernel(k);
  const a = m.addPrimitive('box', { dx: 10, dy: 10, dz: 10 });
  const b = m.addPrimitive('sphere', { r: 3 });
  m.boolean('cut', a.id, [b.id]);
  assert.equal(m.count(), 3);            // 特征树保留输入
  assert.equal(m.visibleCount(), 1);     // 可见实体只有布尔结果
  const meshes = m.evaluate();
  // 求值重建：先建 2 个基本体，再布尔
  assert.equal(k.calls.create.length, 2);
  assert.equal(k.calls.boolean.length, 1);
  assert.equal(k.calls.boolean[0][0], 'cut');
  assert.equal(meshes.length, 1);
  ok('布尔运算：特征树保留输入、只渲染结果、内核调用正确');
}
{
  const m = new Model3D();
  const k = mockKernel();
  m.setKernel(k);
  const a = m.addPrimitive('box', { dx: 10, dy: 10, dz: 10 });
  m.transformBody(a.id, { dx: 5, scale: 2 });
  m.transformBody(a.id, { dx: 3, scale: 4 });
  const t = m.byId(a.id).transform;
  assert.equal(t.dx, 8);
  assert.equal(t.scale, 8); // 缩放应相乘而非相加
  m.evaluate();
  ok('变换累积：位移相加、缩放相乘');
}
{
  const m = new Model3D();
  const k = mockKernel();
  m.setKernel(k);
  const a = m.addPrimitive('box', { dx: 10, dy: 10, dz: 10 });
  const b = m.addPrimitive('sphere', { r: 5 });
  m.removeBody(a.id);
  assert.equal(m.count(), 1);
  m.undo();
  assert.equal(m.count(), 2);
  m.redo();
  assert.equal(m.count(), 1);
  ok('3D 撤销/重做');
}
{
  const m = new Model3D();
  const k = mockKernel();
  m.setKernel(k);
  const a = m.addPrimitive('box', { dx: 5, dy: 5, dz: 5 });
  const b = m.addPrimitive('cylinder', { r: 2, h: 10 });
  m.boolean('fuse', a.id, [b.id]);
  const json = JSON.stringify(m.serialize());
  const m2 = new Model3D();
  m2.load(JSON.parse(json));
  assert.equal(m2.count(), 3);
  assert.equal(m2.visibleCount(), 1);
  assert.equal(m2.bodies[2].kind, 'boolean');
  assert.equal(m2.bodies[2].params.op, 'fuse');
  const k2 = mockKernel();
  m2.setKernel(k2);
  const meshes = m2.evaluate();
  assert.equal(k2.calls.create.length, 2);
  assert.equal(k2.calls.boolean.length, 1);
  assert.equal(meshes.length, 1);
  ok('3D 模型序列化/反序列化后可重新求值');
}
{
  const m = new Model3D();
  const k = mockKernel();
  m.setKernel(k);
  const a = m.addPrimitive('box', { dx: 10, dy: 10, dz: 10 });
  const b = m.addPrimitive('sphere', { r: 3 });
  const c = m.addPrimitive('cylinder', { r: 2, h: 5 });
  const r1 = m.boolean('fuse', a.id, [b.id]);
  const r2 = m.boolean('cut', r1.id, [c.id]);
  assert.equal(m.count(), 5);
  m.removeBody(a.id); // 删除被依赖的输入 → 级联删除两个布尔结果
  assert.equal(m.count(), 2);
  assert(!m.byId(r1.id) && !m.byId(r2.id));
  ok('级联删除：删除输入实体时布尔结果一并删除');
}
{
  const m = new Model3D();
  const k = mockKernel();
  m.setKernel(k);
  const a = m.addPrimitive('box', { dx: 10, dy: 10, dz: 10 });
  m.evaluate();
  const before = k.calls.mesh.length;
  m.addPrimitive('sphere', { r: 4 });
  m.evaluate();
  assert.equal(k.calls.mesh.length, before + 2); // 全量重建网格
  ok('修改后重新求值并重新生成网格');
}
{
  const m = new Model3D();
  const k = mockKernel();
  // 模拟内核布尔失败（如不相交交集 → 空结果）
  const origBoolean = k.boolean.bind(k);
  k.boolean = (op, a, bs) => {
    if (op === 'common') throw new Error('布尔运算失败：空结果');
    return origBoolean(op, a, bs);
  };
  m.setKernel(k);
  const a = m.addPrimitive('box', { dx: 10, dy: 10, dz: 10 });
  const b = m.addPrimitive('sphere', { r: 5 });
  m.boolean('common', a.id, [b.id]);
  const meshes = m.evaluate();
  assert.equal(m._booleanFailed.size, 1);
  assert.equal(m.visibleCount(), 2);   // 失败时输入不被隐藏
  assert.equal(meshes.length, 2);      // 两个输入仍渲染
  ok('布尔求值失败：输入保持可见（用户看不到内容的 bug 修复）');
}

{
  // 圆角/倒角特征树：源被消费、失败不消费、级联删除
  const m = new Model3D();
  const k = mockKernel();
  m.setKernel(k);
  const a = m.addPrimitive('box', { dx: 10, dy: 10, dz: 10 });
  const f = m.filletChamfer('fillet', a.id, 2);
  assert(m.consumedSet().has(a.id), '圆角应消费源实体');
  assert.equal(m.visibleCount(), 1);
  assert(m.summary().includes('圆角'), '摘要应包含圆角特征');
  // 失败标记后源恢复可见
  m._booleanFailed.add(f.id);
  assert(!m.consumedSet().has(a.id), '失败的圆角不应消费源实体');
  assert.equal(m.visibleCount(), 1, '失败的圆角自身不渲染，仅源实体可见');
  m._booleanFailed.delete(f.id);
  // 删除源 → 圆角级联删除
  m.removeBody(a.id);
  assert(!m.byId(f.id), '删除源实体应级联删除圆角特征');
  ok('圆角/倒角特征树（消费/失败/级联）');
}

{
  // 导入体 undo/redo 强制重导时，旧内核实体必须先释放（WASM 堆泄漏修复）
  const m = new Model3D();
  const k = mockKernel();
  m.setKernel(k);
  const b = { id: 'imp1', label: '导入:test', kind: 'imported', params: {}, color: '#ccc', visible: true, _bytes: new Uint8Array([1, 2, 3]), _kids: [100] };
  m.bodies.push(b);
  m._kernelIds.set('imp1', [100]);
  m.evaluate(); // 已有 _kids → 不重导
  assert.equal(k.calls.deleted.length, 0);
  b._kids = null; // 模拟 undo/redo 后失效
  m.evaluate();
  assert(k.calls.deleted.includes(100), '重导前应释放旧内核实体 id=100');
  ok('导入体重导先释放旧内核实体');
}

console.log(`\n全部通过：${n} 项`);
