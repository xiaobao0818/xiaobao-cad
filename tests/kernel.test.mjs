import assert from 'node:assert/strict';
import { initKernel, Kernel } from '../js/three-dim/occ-kernel.js';

let kernel;
let pass = 0;
function ok(name) { pass++; console.log(`  ✔ ${name}`); }
function approx(actual, expected, rel = 1e-6, label = '') {
  const e = Math.abs(actual - expected);
  const denom = Math.abs(expected) > 1 ? Math.abs(expected) : 1;
  assert.ok(e / denom <= rel, `${label} expected≈${expected}, got ${actual} (rel err ${e / denom})`);
}

console.log('== kernel.test.mjs ==');

// 1. init
kernel = await initKernel();
assert.ok(kernel instanceof Kernel, 'initKernel returns Kernel');
assert.equal(kernel.bodyCount(), 0, 'bodyCount starts at 0');
ok('initKernel 成功，bodyCount 初始 0');

// 2. box volume
const boxA = kernel.createBox({ dx: 10, dy: 20, dz: 30 });
approx(kernel.volume(boxA), 6000, 1e-6, 'box volume');
ok('createBox({dx:10,dy:20,dz:30}) volume ≈ 6000');

// 2b. 圆柱 r/h 语义校准：直接体积测量应等于 π·r²·h
// （实测 createCylinder({r,h}) 体积精确等于 π·r²·h，r 与 h 即用户期望的真实半径/高度，无需入参换算）
const cylCal1 = kernel.createCylinder({ r: 2, h: 40 });
approx(kernel.volume(cylCal1), Math.PI * 2 * 2 * 40, 0.02, 'cylinder r=2 h=40 体积 = π·r²·h');
const cylCal2 = kernel.createCylinder({ r: 3, h: 5 });
approx(kernel.volume(cylCal2), Math.PI * 3 * 3 * 5, 0.02, 'cylinder r=3 h=5 体积 = π·r²·h');
ok('createCylinder r/h 语义校准通过：volume = π·r²·h（<2% 容差）');

// 3. boolean identities
const cyl = kernel.createCylinder({ r: 2, h: 40 });
const volA = kernel.volume(boxA);
const volB = kernel.volume(cyl);
const fuse = kernel.boolean('fuse', boxA, cyl);
const cut = kernel.boolean('cut', boxA, cyl);
const common = kernel.boolean('common', boxA, cyl);
const volFuse = kernel.volume(fuse);
const volCut = kernel.volume(cut);
const volCommon = kernel.volume(common);
approx(volFuse, volA + volB - volCommon, 1e-6, 'volume(fuse) = a+b-common');
approx(volCut, volA - volCommon, 1e-6, 'volume(cut) = a-common');
ok('布尔 cut/fuse/common 体积恒等式成立');

// 4. mesh
const m = kernel.mesh(boxA);
assert.ok(m.positions.length > 0, 'positions not empty');
assert.ok(m.indices.length > 0, 'indices not empty');
assert.equal(m.positions.length % 3, 0, 'positions multiple of 3');
assert.equal(m.indices.length % 3, 0, 'indices multiple of 3');
const bb = kernel.bbox(boxA);
let inBox = true;
for (let i = 0; i < m.positions.length; i += 3) {
  const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
  if (x < bb.minX - 1e-6 || x > bb.maxX + 1e-6 ||
      y < bb.minY - 1e-6 || y > bb.maxY + 1e-6 ||
      z < bb.minZ - 1e-6 || z > bb.maxZ + 1e-6) { inBox = false; break; }
}
assert.ok(inBox, 'mesh vertices within bbox');
ok('mesh 返回非空 positions/indices 且顶点在 bbox 内');

// 5. transform translate
const tbox = kernel.createBox({ dx: 10, dy: 10, dz: 10 });
const before = kernel.bbox(tbox).minX;
kernel.transform(tbox, { dx: 10 });
const after = kernel.bbox(tbox).minX;
assert.ok(Math.abs((after - before) - 10) < 1e-6, `minX increased by 10 (${before} -> ${after})`);
ok('transform {dx:10} 后 bbox.minX 增大 10');

// 6. exportSTL (binary: 80-byte header + uint32 triangle count)
const stl = kernel.exportSTL(boxA);
assert.ok(stl.length > 0, 'stl bytes > 0');
assert.ok(stl.length >= 84, 'stl has header + count');
const triCount = new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
assert.equal((stl.length - 84) / 50, triCount, 'binary STL triangle count matches byte size');
ok('exportSTL 二进制格式有效（80字节头 + 三角形计数）');

// 6b. exportSTL with array (compound)
const b1 = kernel.createBox({ dx: 10, dy: 10, dz: 10, x: -20, y: 0, z: 0 });
const b2 = kernel.createBox({ dx: 10, dy: 10, dz: 10, x: 20, y: 0, z: 0 });
const singleTriCount = kernel.mesh(b1).indices.length / 3 + kernel.mesh(b2).indices.length / 3;
const stlMulti = kernel.exportSTL([b1, b2]);
assert.ok(stlMulti.length > 0, 'array stl bytes > 0');
const multiTriCount = new DataView(stlMulti.buffer, stlMulti.byteOffset, stlMulti.byteLength).getUint32(80, true);
assert.equal((stlMulti.length - 84) / 50, multiTriCount, 'array binary STL triangle count matches byte size');
assert.equal(multiTriCount, singleTriCount, 'compound STL triangle count equals sum of bodies');
ok('exportSTL([id1,id2]) 合并导出为单个 STL（三角形数 = 各 body 之和）');

// 7. STEP roundtrip
const stepBytes = kernel.exportSTEP([boxA]);
assert.ok(stepBytes.length > 0, 'step bytes > 0');
const imported = kernel.importSTEP(stepBytes);
assert.equal(imported.length, 1, 'importSTEP returns 1 body');
const volErr = Math.abs(kernel.volume(imported[0]) - 6000) / 6000;
assert.ok(volErr < 0.01, `imported volume error ${volErr} < 1%`);
ok('exportSTEP/importSTEP 回读 1 个 body，体积误差 < 1%');

// 7b. 复合体 STEP 往返：写 → 读 → TopoDS_Iterator 遍历 OneShape 子形状
const boxB2 = kernel.createBox({ dx: 5, dy: 5, dz: 5, x: 50, y: 0, z: 0 });
const compoundBytes = kernel.exportSTEP([boxA, boxB2]);
assert.ok(compoundBytes.length > 0, 'compound step bytes > 0');
// 内核层：importSTEP 按 SOLID 拆分，应返回 >= 2 个 body
const compoundImported = kernel.importSTEP(compoundBytes);
assert.ok(compoundImported.length >= 2, `compound importSTEP returns >= 2 bodies (got ${compoundImported.length})`);
// OCC 层：TopoDS_Iterator 遍历 OneShape 子形状 >= 2（与浏览器验证一致）
const oc = kernel.oc;
oc.FS.writeFile('/c.step', compoundBytes);
const reader = new oc.STEPControl_Reader_1();
assert.equal(reader.ReadFile('c.step').value, 1, 'compound ReadFile = IFSelect_RetDone(1)');
assert.equal(reader.TransferRoots(), 1, 'TransferRoots = 1');
const oneShape = reader.OneShape();
assert.ok(!oneShape.IsNull(), 'OneShape not null');
const it = new oc.TopoDS_Iterator_1();
it.Initialize(oneShape, true, true);
let subCount = 0;
while (it.More()) { subCount++; it.Next(); }
assert.ok(subCount >= 2, `OneShape 子形状数 >= 2 (got ${subCount})`);
it.delete();
oneShape.delete();
reader.delete();
ok('复合体 STEP 往返 + TopoDS_Iterator 子形状遍历 (>=2)');

// 8. fillet
const fbox = kernel.createBox({ dx: 20, dy: 20, dz: 20 });
const fid = kernel.fillet(fbox, 3);
assert.ok(typeof fid === 'number', 'fillet returns new id');
assert.ok(kernel.volume(fid) < 8000, `fillet volume ${kernel.volume(fid)} < 8000`);
ok('fillet 成功返回新 id，volume < 8000');

// 9. chamfer
const cbox = kernel.createBox({ dx: 20, dy: 20, dz: 20 });
const cid = kernel.chamfer(cbox, 3);
assert.ok(typeof cid === 'number', 'chamfer returns new id');
assert.ok(kernel.volume(cid) < 8000, `chamfer volume ${kernel.volume(cid)} < 8000`);
ok('chamfer 成功返回新 id，volume < 8000');

// 10. deleteBody + dispose
const countBefore = kernel.bodyCount();
kernel.deleteBody(tbox);
assert.equal(kernel.bodyCount(), countBefore - 1, 'bodyCount decreases after deleteBody');
kernel.dispose();
assert.equal(kernel.bodyCount(), 0, 'dispose clears bodies');
ok('deleteBody 后 bodyCount 正确；dispose 正常');

console.log(`\n全部通过：${pass} 项测试 ✔`);
process.exit(0);
