/* 小宝CAD 审查回归测试：锁定本轮修复的几何/命令缺陷（node tests/regression-fixes.test.mjs） */
import { strict as assert } from 'node:assert';
import {
  distPointArc, bulgeFromArc, arcFromBulge, rotationM,
} from '../js/util.js';
import { make, entityCurves, entityBBox, angleOnPiece, pieceAngleRange } from '../js/entities.js';
import { Scene } from '../js/scene.js';
import { registerTools } from '../js/tools.js';
import { CANCELLED, ENDED } from '../js/commands.js';

const P = (x, y) => ({ x, y });

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

/* ---------- 纯几何 ---------- */
{
  // CW 弧：45° 不在 CW 0°→90° 弧上，最近距离应取端点（r=5 → 5.0，旧代码给径向 2.07）
  const d = distPointArc({ x: 5, y: 5 }, 0, 0, 5, 0, Math.PI / 2, false);
  assert(Math.abs(d - 5) < 1e-9, `CW 弧距离=${d} 应为 5`);
  ok('CW 弧外点距离取端点（不再被径向低估）');
  // CW 弧上点（315°）应≈0
  const on = distPointArc({ x: 3.5355, y: -3.5355 }, 0, 0, 5, 0, Math.PI / 2, false);
  assert(on < 1e-3, `CW 弧上点距离=${on} 应≈0`);
  ok('CW 弧上点距离≈0');
}
{
  // 弧跨 0/2π：CCW 270°→90°，0° 在弧上、180° 不在
  const pc = { kind: 'arc', cx: 0, cy: 0, r: 10, startAngle: 3 * Math.PI / 2, endAngle: Math.PI / 2, ccw: true };
  assert(angleOnPiece(pc, 0) === true, '0° 应在跨越 0/2π 的弧上');
  assert(angleOnPiece(pc, Math.PI) === false, '180° 不应在弧上');
  assert(pieceAngleRange(pc)[0] > 4 && pieceAngleRange(pc)[1] > pieceAngleRange(pc)[0]);
  ok('弧跨 0/2π 的角度区间判定');
}
{
  // 优弧 bulge 往返：270° CCW 弧
  const b = bulgeFromArc({ ccw: true, startAngle: 0, endAngle: 3 * Math.PI / 2 });
  assert(b > 1, `优弧 bulge=${b} 应>1`);
  const back = arcFromBulge({ x: 0, y: 0 }, { x: 10, y: 0 }, b);
  assert(back && back.ccw === true && Math.abs(back.endAngle - back.startAngle) > Math.PI, '优弧往返应保持 CCW 大弧');
  const b2 = bulgeFromArc({ ccw: back.ccw, startAngle: back.startAngle, endAngle: back.endAngle });
  assert(Math.abs(b2 - b) < 1e-6, `优弧 bulge 往返=${b2} 应≈${b}`);
  ok('优弧 bulge ↔ 圆弧 对称往返');
}

/* ---------- 命令级（mock app/commander） ---------- */
class MockCommander {
  constructor() { this.cmds = {}; }
  register(name, fn, aliases = []) { this.cmds[name] = fn; for (const a of aliases) this.cmds[a] = fn; }
  async run(name) { await this.cmds[name](); }
}
function mockApp() {
  const scene = new Scene();
  const commander = new MockCommander();
  const app = {
    scene, commander,
    viewport: {
      scale: 1,
      worldToScreen: (p) => p,
      hitTest: (p, tol = 10) => {
        let best = null, bd = Infinity;
        for (const e of scene.entities.values()) {
          const d = e.__testDistance ? e.__testDistance(e, p) : null;
          if (d == null || d > tol) continue;
          if (d < bd) { bd = d; best = e; }
        }
        return best;
      },
    },
    notify: () => {},
  };
  // 为 mock 视图附加真实距离计算
  app._distFor = (e, p) => {
    const { HANDLERS } = mockImport;
    return HANDLERS[e.type]?.distance ? HANDLERS[e.type].distance(e, p, scene) : Infinity;
  };
  app.viewport.hitTest = (p, tol = 10) => {
    let best = null, bd = Infinity;
    for (const e of scene.entities.values()) {
      const d = app._distFor(e, p);
      if (d == null || d > tol) continue;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };
  return app;
}
let mockImport;
{
  mockImport = await import('../js/entities.js');
}
function script(app, points = []) {
  const q = [...points];
  app.commander.awaitPoint = async () => (q.length ? q.shift() : CANCELLED);
  app.commander.awaitNumber = async () => (q.length ? q.shift() : CANCELLED);
  app.commander.awaitDistance = async () => (q.length ? q.shift() : CANCELLED);
  app.commander.awaitAngle = async () => (q.length ? q.shift() : CANCELLED);
  app.commander.awaitText = async () => (q.length ? q.shift() : CANCELLED);
  app.commander.execAndEnd = (name) => app.commander.run(name);
  app.commander.cancel = () => {};
}

{
  const app = mockApp();
  registerTools(app);
  const s = app.scene;
  const l1 = make.line(P(0, 0), P(10, 0));
  const l2 = make.line(P(0, 0), P(0, 10));
  s.addEntity(l1); s.addEntity(l2);
  script(app, [{ x: 3, y: 0 }, { x: 0, y: 3 }, 2]);
  await app.commander.run('FILLET');
  const ents = [...s.entities.values()];
  assert.equal(ents.length, 3, `FILLET 后应 3 个实体（两修剪线+弧），实际 ${ents.length}`);
  const line1 = ents.find((e) => e.type === 'line' && Math.abs(e.y1 - e.y2) < 1e-9);
  const line2 = ents.find((e) => e.type === 'line' && Math.abs(e.x1 - e.x2) < 1e-9);
  const arc = ents.find((e) => e.type === 'arc');
  assert(line1 && Math.abs(line1.x1 - 2) < 1e-6 && Math.abs(line1.x2 - 10) < 1e-6, '水平线应修剪为 (2,0)-(10,0)');
  assert(line2 && Math.abs(line2.y1 - 2) < 1e-6 && Math.abs(line2.y2 - 10) < 1e-6, '垂直线应修剪为 (0,2)-(0,10)');
  assert(arc && Math.abs(arc.cx - 2) < 1e-6 && Math.abs(arc.cy - 2) < 1e-6 && Math.abs(arc.r - 2) < 1e-6, '圆角弧圆心 (2,2) r=2');
  ok('FILLET 会修剪两对象并画弧（旧缺陷：只画弧不修剪）');
}
{
  const app = mockApp();
  registerTools(app);
  const s = app.scene;
  s.addEntity(make.line(P(0, 0), P(10, 0)));
  script(app, [{ x: 9, y: 0 }, 1, { x: 9, y: 1 }]);
  await app.commander.run('OFFSET');
  const off = [...s.entities.values()].find((e) => e.type === 'line' && Math.abs(e.y1 - 1) < 1e-6);
  assert(off, '拾取靠近终点时偏移应仍在 +y 侧（旧缺陷：跑到 -y 侧）');
  ok('OFFSET 直线方向与拾取端点无关');
}
{
  const app = mockApp();
  registerTools(app);
  const s = app.scene;
  s.addEntity(make.polyline([P(0, 0), P(4, 0), P(4, 4), P(0, 4)], { closed: true }));
  script(app, [{ x: 2, y: 0 }, 1, { x: 2, y: 2 }]);
  await app.commander.run('OFFSET');
  const off = [...s.entities.values()].find((e) => e.type === 'polyline' && Math.abs(e.points[0].x - 1) < 1e-6);
  assert(off && Math.abs(off.points[0].y - 1) < 1e-6, 'CCW 闭合多边形点内部应向内偏移到 (1,1)（旧缺陷：向外）');
  ok('OFFSET 闭合多段线内外方向正确');
}
{
  const app = mockApp();
  registerTools(app);
  const s = app.scene;
  script(app, [{ x: 0, y: 0 }, { x: 5, y: -5 }, { x: 10, y: 0 }]);
  await app.commander.run('A');
  const arc = [...s.entities.values()].find((e) => e.type === 'arc');
  assert(arc && arc.ccw === true, `三点圆弧应取 CCW（旧缺陷：取反），实际 ccw=${arc?.ccw}`);
  assert(arc && Math.abs(arc.cx - 5) < 1e-6 && Math.abs(arc.cy) < 1e-6 && Math.abs(arc.r - 5) < 1e-6, '圆心 (5,0) r=5');
  ok('三点圆弧过第二点的方向正确');
}
{
  const app = mockApp();
  registerTools(app);
  const s = app.scene;
  const c = make.circle(P(10, 0), 1);
  s.addEntity(c);
  s.selection = new Set([c.id]);
  script(app, [{ x: 0, y: 0 }, 4, 90]);
  await app.commander.run('ARRAYPOLAR');
  const circles = [...s.entities.values()].filter((e) => e.type === 'circle');
  assert.equal(circles.length, 4, `应 4 个圆，实际 ${circles.length}`);
  const at90 = circles.find((e) => Math.abs(e.cx) < 1e-6 && Math.abs(e.cy - 10) < 1e-6);
  assert(at90, '90° 填充时第 4 项应落在 90°（旧缺陷：停在 67.5°）');
  ok('ARRAYPOLAR 部分填充角距正确');
}
{
  const app = mockApp();
  registerTools(app);
  const s = app.scene;
  const cutter = make.line(P(15, -5), P(15, 15));
  const pl = make.polyline([P(0, 0), P(10, 10), P(20, 0)]);
  s.addEntity(cutter); s.addEntity(pl);
  s.selection = new Set([cutter.id]);
  script(app, [{ x: 14, y: 6 }, ENDED]);
  await app.commander.run('TRIM');
  const pls = [...s.entities.values()].filter((e) => e.type === 'polyline');
  assert.equal(pls.length, 2, `修剪后应断裂为 2 条多段线，实际 ${pls.length}`);
  const keep1 = pls.find((e) => e.points.length === 2 && Math.abs(e.points[1].x - 10) < 1e-6);
  const keep2 = pls.find((e) => e.points.length === 2 && Math.abs(e.points[0].x - 15) < 1e-6);
  assert(keep1 && keep2, '中间顶点 (10,10) 与断口 (15,5) 都应在结果里（旧缺陷：丢失顶点并连假线段）');
  ok('TRIM 多段线中间段断裂重建正确');
}

/* ---------- INSERT 块基点 ---------- */
{
  const s = new Scene();
  const blk = { name: 'B', baseX: 5, baseY: 0, entities: new Map([[1, make.line(P(0, 0), P(10, 0))]]) };
  s.blocks.set('B', blk);
  const ins = make.insert('B', P(100, 100));
  s.addEntity(ins);
  const bb = entityBBox(ins, s);
  assert(bb && Math.abs(bb[0] - 95) < 1e-6 && Math.abs(bb[2] - 105) < 1e-6, `块基点 (5,0) 的插入 bbox 应 [95,105]，实际 [${bb}]`);
  ok('INSERT 块基点参与插入矩阵');
}
{
  // 弧跨 0 的求交：CCW 270°→90° 与水平线 y=0 应有交点 (10,0)
  const { entityIntersections } = await import('../js/entities.js');
  const arc = make.arc(P(0, 0), 10, 3 * Math.PI / 2, Math.PI / 2, { ccw: true });
  const line = make.line(P(-20, 0), P(20, 0));
  const s = new Scene();
  const hits = entityIntersections(arc, line, s);
  assert(hits.length === 1, `跨 0° 弧与线求交应恰 1 点（(10,0) 在弧上、(–10,0) 不在），实际 ${hits.length}`);
  assert(hits.some((p) => Math.abs(p.x - 10) < 1e-6 && Math.abs(p.y) < 1e-6), '应含交点 (10,0)');
  ok('弧跨 0/2π 求交不漏点');
}

{
  // undo 快照应包含图层与选择状态
  const s = new Scene();
  s.ensureLayer('0', { color: '#fff' });
  s.singleOp('加图层', () => { s.addLayer('L2', { color: '#f00' }); });
  assert(s.layers.has('L2'));
  s.undo();
  assert(!s.layers.has('L2'), 'undo 后图层变更应还原');
  ok('undo 还原图层状态');
}
{
  // 嵌套 undo group：内层 end 不应关闭外层
  const s = new Scene();
  s.beginUndoGroup('外层');
  s.addEntity(make.line(P(0, 0), P(10, 0)));
  s.beginUndoGroup('内层');
  s.addEntity(make.line(P(0, 0), P(0, 10)));
  s.endUndoGroup();   // 只关内层
  s.addEntity(make.line(P(0, 0), P(10, 10))); // 仍属外层
  s.endUndoGroup();
  assert.equal(s.entities.size, 3, `组内应 3 实体，实际 ${s.entities.size}`);
  s.undo();
  assert.equal(s.entities.size, 0, `undo 后应 0 实体，实际 ${s.entities.size}`);
  s.redo();
  assert.equal(s.entities.size, 3, `redo 后应恢复 3 实体，实际 ${s.entities.size}`);
  ok('嵌套 undo group 深度正确');
}
{
  // undo 还原选择状态
  const s = new Scene();
  const l = make.line(P(0, 0), P(10, 0));
  s.addEntity(l);
  s.select([l.id], 'set');
  s.singleOp('画圆', () => { s.addEntity(make.circle(P(5, 5), 2)); });
  s.select([], 'set');
  s.undo();
  assert(s.selection.size === 1 && s.selection.has(l.id), 'undo 后选择应还原为快照时的状态（含已选实体）');
  ok('undo 还原选择状态');
}

{
  // 坏数据防御：layers 为字符串 / 无 points 多段线
  const s = Scene.load({ app: 'xbcad', layers: 'bad-string', entities: [{ id: 'e1', type: 'polyline', layer: '0' }] });
  assert.equal(s.entities.size, 1, '无 points 多段线仍可加载');
  const { buildSceneSummary } = await import('../js/io.js');
  const sum = buildSceneSummary(s);
  assert(typeof sum === 'string' && sum.includes('1'), '摘要对无 points 多段线不崩溃');
  ok('Scene.load 坏数据防御 + 摘要容错');
}

console.log(`全部通过：${n} 项`);
