/* 小宝CAD DXF 读写模块测试：writeDXF → parseDXF 往返 + 内联字符串解析 */
import { writeDXF, parseDXF } from '../js/dxf.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  ✗ 断言失败: ' + msg); }
  else console.log('  ✓ ' + msg);
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

/* ---------------- 构造 fake scene ---------------- */
const layers = new Map([
  ['0', { name: '0', color: '#ffffff', on: true, locked: false, ltype: 'CONTINUOUS' }],
  ['轮廓', { name: '轮廓', color: '#ff0000', on: true, locked: false, ltype: 'CONTINUOUS' }],
]);

const blockEntities = new Map([
  ['be1', { id: 'be1', type: 'circle', layer: '0', color: null, ltype: null, lw: null, cx: 0, cy: 0, r: 5 }],
  ['be2', { id: 'be2', type: 'line', layer: '0', color: null, ltype: null, lw: null, x1: -10, y1: 0, x2: 10, y2: 0 }],
]);

const blocks = new Map([
  ['B1', { name: 'B1', baseX: 0, baseY: 0, entities: blockEntities }],
]);

const entities = new Map();
let n = 0;
const add = (e) => { e.id = e.id || ('t' + (++n)); entities.set(e.id, e); };

add({ type: 'line', layer: '0', color: null, ltype: null, lw: null, x1: 0, y1: 0, x2: 10, y2: 20 });
add({ type: 'circle', layer: '轮廓', color: null, ltype: null, lw: null, cx: 5, cy: 6, r: 7.5 });
add({ type: 'arc', layer: '0', color: null, ltype: null, lw: null, cx: 0, cy: 0, r: 3, startAngle: 0, endAngle: Math.PI / 2, ccw: true });
add({ type: 'polyline', layer: '0', color: null, ltype: null, lw: null, closed: true, points: [{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 0.5 }, { x: 10, y: 10, bulge: 0 }, { x: 0, y: 10, bulge: 0 }] });
add({ type: 'text', layer: '0', color: null, ltype: null, lw: null, x: 2, y: 3, height: 4, text: '你好Hello', rotation: 0.5, halign: 'center', valign: 'middle' });
add({ type: 'ellipse', layer: '0', color: null, ltype: null, lw: null, cx: 1, cy: 2, rx: 8, ry: 4, rot: Math.PI / 4 });
add({ type: 'point', layer: '0', color: null, ltype: null, lw: null, x: 11, y: 22 });
add({ type: 'insert', layer: '0', color: null, ltype: null, lw: null, block: 'B1', x: 100, y: 200, scaleX: 2, scaleY: 3, rotation: Math.PI / 6 });

const scene = { layers, entities, blocks };

/* ---------------- 往返 ---------------- */
console.log('== writeDXF → parseDXF 往返 ==');
const text = writeDXF(scene);
const data = parseDXF(text);

assert(data.units === 'mm', '单位 mm');
assert(data.layers.length === 2, '图层数量 ' + data.layers.length);
assert(data.blocks.length === 1, '块数量 ' + data.blocks.length);
assert(data.blocks[0].name === 'B1', '块名 B1');
assert(data.blocks[0].entities.length === 2, '块内实体数量');
assert(data.entities.length === entities.size, `实体数量一致 ${data.entities.length} vs ${entities.size}`);

const byType = {};
for (const e of data.entities) byType[e.type] = (byType[e.type] || 0) + 1;
assert((byType.line || 0) === 1, 'line 数量');
assert((byType.circle || 0) === 1, 'circle 数量');
assert((byType.arc || 0) === 1, 'arc 数量');
assert((byType.polyline || 0) === 1, 'polyline 数量');
assert((byType.text || 0) === 1, 'text 数量');
assert((byType.ellipse || 0) === 1, 'ellipse 数量');
assert((byType.insert || 0) === 1, 'insert 数量');

const line = data.entities.find((e) => e.type === 'line');
assert(line && approx(line.x1, 0) && approx(line.y1, 0) && approx(line.x2, 10) && approx(line.y2, 20), '线端点');

const circle = data.entities.find((e) => e.type === 'circle');
assert(circle && approx(circle.r, 7.5), '圆半径');
assert(circle && approx(circle.cx, 5) && approx(circle.cy, 6), '圆心');
assert(circle && circle.layer === '轮廓', '圆所在图层');

const arc = data.entities.find((e) => e.type === 'arc');
assert(arc && approx(arc.r, 3), '弧半径');
assert(arc && approx(arc.startAngle, 0) && approx(arc.endAngle, Math.PI / 2), '弧角度');

const poly = data.entities.find((e) => e.type === 'polyline');
assert(poly && poly.points.length === 4, '多段线点数 ' + (poly && poly.points.length));
assert(poly && approx(poly.points[1].bulge, 0.5), '多段线 bulge ' + (poly && poly.points[1] && poly.points[1].bulge));
assert(poly && poly.closed === true, '多段线闭合');

const t = data.entities.find((e) => e.type === 'text');
assert(t && t.text === '你好Hello', '文字内容 ' + (t && t.text));
assert(t && t.halign === 'center' && t.valign === 'middle', '文字对齐');
assert(t && approx(t.rotation, 0.5), '文字旋转');

const ins = data.entities.find((e) => e.type === 'insert');
assert(ins && ins.block === 'B1', '插入块名');
assert(ins && approx(ins.x, 100) && approx(ins.y, 200), '插入点');
assert(ins && approx(ins.scaleX, 2) && approx(ins.scaleY, 3), '插入比例');
assert(ins && approx(ins.rotation, Math.PI / 6), '插入旋转');

/* ---------------- 内联 DXF 字符串解析 ---------------- */
console.log('== 内联 DXF 字符串解析 ==');
const inline = `  0
SECTION
  2
HEADER
  9
$INSUNITS
 70
    4
  0
ENDSEC
  0
SECTION
  2
TABLES
  0
TABLE
  2
LAYER
 70
1
  0
LAYER
  2
0
 70
0
 62
7
  6
CONTINUOUS
  0
ENDTAB
  0
ENDSEC
  0
SECTION
  2
ENTITIES
  0
LINE
  8
0
 10
  1.5
 20
2.5
 11
3.5
 21
4.5
  0
CIRCLE
  8
0
 10
0
 20
0
 40
9
  0
LWPOLYLINE
  8
0
 90
3
 70
1
 10
0
 20
0
 42
0.5
 10
5
 20
0
 10
5
 20
5
  0
ENDSEC
  0
EOF
`;

const d2 = parseDXF(inline);
assert(d2.units === 'mm', '内联单位 mm');
assert(d2.layers.length === 1 && d2.layers[0].name === '0', '内联图层');
assert(d2.entities.length === 3, '内联实体数量 ' + d2.entities.length);
assert(d2.entities[0].type === 'line' && approx(d2.entities[0].x1, 1.5) && approx(d2.entities[0].y1, 2.5), '内联线起点');
assert(d2.entities[1].type === 'circle' && approx(d2.entities[1].r, 9), '内联圆半径');
assert(d2.entities[2].type === 'polyline' && d2.entities[2].points.length === 3 && d2.entities[2].closed, '内联多段线');
assert(approx(d2.entities[2].points[0].bulge, 0.5), '内联多段线 bulge');

/* ---------------- 结果 ---------------- */
console.log('');
if (failures) {
  console.error(`✗ 共 ${failures} 处失败`);
  process.exit(1);
} else {
  console.log('✓ 全部测试通过');
}
