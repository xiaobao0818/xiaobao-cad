/* 小宝CAD 画图训练验收器测试（node tests/training-acceptance.test.mjs）
 * 验证：好图纸满分/差图纸低分/修复后分数提升（“持续提升质量”可量化） */
import { strict as assert } from 'node:assert';
import { TRAIN_TASKS, taskById } from '../training/tasks.mjs';
import { evaluate, logEntry } from '../training/acceptance.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };
const P = (x, y) => ({ x, y });

/* 构造一张“好”的法兰盘 2D 图 */
function goodFlange2d() {
  const ents = [];
  ents.push({ id: 'c1', type: 'circle', cx: 0, cy: 0, r: 50, layer: '0' });
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    ents.push({ id: `h${k}`, type: 'circle', cx: 35 * Math.cos(a), cy: 35 * Math.sin(a), r: 5, layer: '0' });
  }
  ents.push({ id: 'l1', type: 'line', x1: -60, y1: 0, x2: 60, y2: 0, layer: '中心线' });
  ents.push({ id: 'l2', type: 'line', x1: 0, y1: -60, x2: 0, y2: 60, layer: '中心线' });
  return ents;
}

{
  const task = taskById('flange2d');
  const r = evaluate(task, goodFlange2d());
  assert.equal(r.score, 100, `好图纸应 100 分，实际 ${r.score}`);
  ok('法兰盘好图纸 = 100 分');
}
{
  const task = taskById('flange2d');
  const bad = goodFlange2d().filter((e) => !(e.type === 'circle' && e.r === 5)); // 丢了全部 6 个孔
  const r = evaluate(task, bad);
  assert(r.score < 60, `缺孔的坏图纸应低分（实际 ${r.score}）`);
  ok(`法兰盘缺孔 = ${r.score} 分（<60 判为坏图纸）`);
}
{
  const task = taskById('flange2d');
  const bad = goodFlange2d().filter((e) => !(e.type === 'circle' && e.r === 5));
  const s1 = evaluate(task, bad).score;
  // “修复”：补上 6 个孔（模拟 MiniMax 审阅后模型修复）
  const fixed = [...bad];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    fixed.push({ id: `fix${k}`, type: 'circle', cx: 35 * Math.cos(a), cy: 35 * Math.sin(a), r: 5, layer: '0' });
  }
  const s2 = evaluate(task, fixed).score;
  assert(s2 > s1, `修复后分数应提升：${s1} → ${s2}`);
  assert.equal(s2, 100, '修复后应回到满分');
  ok(`修复闭环：${s1} 分 → ${s2} 分（量化质量提升）`);
}
{
  // 3D 四孔板：好模型满分
  const task = taskById('plate3d');
  const bodies = [
    { id: 'b1', kind: 'box', params: { dx: 100, dy: 80, dz: 10 }, color: '#7fb2e8' },
    { id: 'c1', kind: 'cylinder', params: { x: 35, y: 25, r: 8, h: 20 } },
    { id: 'c2', kind: 'cylinder', params: { x: -35, y: 25, r: 8, h: 20 } },
    { id: 'c3', kind: 'cylinder', params: { x: 35, y: -25, r: 8, h: 20 } },
    { id: 'c4', kind: 'cylinder', params: { x: -35, y: -25, r: 8, h: 20 } },
    { id: 'b1', kind: 'boolean', params: { op: 'cut', a: 'b1', b: ['c1', 'c2', 'c3', 'c4'] } },
  ];
  const r = evaluate(task, { bodies });
  assert.equal(r.score, 100, `四孔板好模型应 100 分，实际 ${r.score}（${r.checks.filter((c) => !c.pass).map((c) => c.detail).join('；')}）`);
  ok('四孔板好模型 = 100 分');
}
{
  const task = taskById('plate3d');
  const bad = { bodies: [{ id: 'b1', kind: 'box', params: { dx: 100, dy: 80, dz: 10 } }] }; // 只有板没挖孔
  const r = evaluate(task, bad);
  assert(r.score < 60, `没挖孔的坏模型应低分（实际 ${r.score}）`);
  ok(`四孔板未挖孔 = ${r.score} 分`);
}
{
  const task = taskById('sleeve3d');
  const r = evaluate(task, { bodies: [
    { id: 'a', kind: 'cylinder', params: { r: 40, h: 60 } },
    { id: 'b', kind: 'cylinder', params: { r: 25, h: 60 } },
    { id: 'c', kind: 'boolean', params: { op: 'cut', a: 'a', b: ['b'] } },
  ] });
  assert.equal(r.score, 100, `轴套好模型应 100 分，实际 ${r.score}`);
  ok('轴套好模型 = 100 分');
}
{
  const e = logEntry({ taskId: 'flange2d', taskName: '法兰盘', round: 1, ws: '2d', scoreBefore: 40, scoreAfter: 100, reviewOutcome: '已修复并满意', reviewRounds: 1 });
  assert.equal(e.delta, 60);
  assert(e.ts > 0);
  ok('训练日志条目字段完整');
}
{
  assert.equal(TRAIN_TASKS.length, 9, '任务库应含基础 4 + 水泵 5 个任务');
  ok('训练任务库 9 个任务（含水泵组件 5 个）');
}
/* ============ 水泵组件验收 ============ */
{
  // 叶轮：好模型满分（同轴轮盘+中心孔+6 叶片均布+布尔）
  const task = taskById('impeller3d');
  const bodies = [
    { id: 'disk', kind: 'cylinder', params: { x: 0, y: 0, r: 60, h: 8 } },
    { id: 'hole', kind: 'cylinder', params: { x: 0, y: 0, r: 10, h: 8 } },
  ];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    bodies.push({ id: `bl${k}`, kind: 'box', params: { x: 35 * Math.cos(a), y: 35 * Math.sin(a), dx: 30, dy: 6, dz: 10 } });
  }
  bodies.push({ id: 'cut', kind: 'boolean', params: { op: 'cut', a: 'disk', b: ['hole'] } });
  bodies.push({ id: 'fuse', kind: 'boolean', params: { op: 'fuse', a: 'disk', b: bodies.slice(2, 8).map((b) => b.id) } });
  const r = evaluate(task, { bodies });
  assert.equal(r.score, 100, `叶轮好模型应 100 分，实际 ${r.score}（${r.checks.filter((c) => !c.pass).map((c) => c.detail).join('；')}）`);
  ok('水泵叶轮好模型 = 100 分');
}
{
  // 叶轮缺叶片：均布与数量验收应扣分
  const task = taskById('impeller3d');
  const bodies = [
    { id: 'disk', kind: 'cylinder', params: { x: 0, y: 0, r: 60, h: 8 } },
    { id: 'hole', kind: 'cylinder', params: { x: 0, y: 0, r: 10, h: 8 } },
  ];
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3;
    bodies.push({ id: `bl${k}`, kind: 'box', params: { x: 35 * Math.cos(a), y: 35 * Math.sin(a), dx: 30, dy: 6, dz: 10 } });
  }
  const r = evaluate(task, { bodies });
  assert(r.score < 70, `叶轮缺 3 叶片应扣分（实际 ${r.score}）`);
  ok(`叶轮缺叶片 = ${r.score} 分`);
}
{
  // 台阶轴：同轴度 + 直径递减序列 + 总长求和
  const task = taskById('shaft3d');
  const good = [
    { id: 's1', kind: 'cylinder', params: { x: 0, y: 0, r: 30, h: 40 } },
    { id: 's2', kind: 'cylinder', params: { x: 0, y: 0, r: 25, h: 60 } },
    { id: 's3', kind: 'cylinder', params: { x: 0, y: 0, r: 20, h: 80 } },
    { id: 's4', kind: 'cylinder', params: { x: 0, y: 0, r: 15, h: 50 } },
    { id: 's5', kind: 'cylinder', params: { x: 0, y: 0, r: 10, h: 30 } },
  ];
  assert.equal(evaluate(task, { bodies: good }).score, 100, '五段同轴台阶轴应 100 分');
  // 偏心一段 → 同轴度扣分
  const off = good.map((b, i) => (i === 2 ? { ...b, params: { ...b.params, x: 30 } } : b));
  const rOff = evaluate(task, { bodies: off });
  assert(rOff.score < 100, `偏心轴应扣分（实际 ${rOff.score}）`);
  // 直径不分段（5 段同一半径）→ 台阶数验收扣分
  const flat = good.map((b) => ({ ...b, params: { ...b.params, r: 20 } }));
  const rFlat = evaluate(task, { bodies: flat });
  assert(rFlat.score < 100, `无台阶光轴应扣分（实际 ${rFlat.score}）`);
  ok(`台阶轴验收：同轴/台阶数/总长（偏心 ${rOff.score} 分、光轴 ${rFlat.score} 分）`);
}
{
  // 泵壳：偏心内腔 + 同轴外壳 + 双法兰
  const task = taskById('casing3d');
  const bodies = [
    { id: 'outer', kind: 'cylinder', params: { x: 0, y: 0, r: 70, h: 50 } },
    { id: 'base', kind: 'box', params: { x: 0, y: 0, z: -32, dx: 160, dy: 100, dz: 15 } },
    { id: 'f1', kind: 'cylinder', params: { x: 0, y: -90, r: 25, h: 12 } },
    { id: 'f2', kind: 'cylinder', params: { x: 95, y: 0, r: 25, h: 12 } },
    { id: 'cav', kind: 'cylinder', params: { x: 18, y: 0, r: 45, h: 50 } },
    { id: 'fuse', kind: 'boolean', params: { op: 'fuse', a: 'outer', b: ['base', 'f1', 'f2'] } },
    { id: 'cut', kind: 'boolean', params: { op: 'cut', a: 'outer', b: ['cav'] } },
  ];
  const r = evaluate(task, { bodies });
  assert.equal(r.score, 100, `泵壳好模型应 100 分，实际 ${r.score}（${r.checks.filter((c) => !c.pass).map((c) => c.detail).join('；')}）`);
  ok('水泵泵壳好模型 = 100 分');
}
{
  // 微型泵整机装配：轴孔间隙配合验收
  const task = taskById('minipump3d');
  const bodies = [
    { id: 'outer', kind: 'cylinder', params: { x: 0, y: 0, r: 70, h: 50 } },
    { id: 'cav', kind: 'cylinder', params: { x: 18, y: 0, r: 45, h: 50 } },
    { id: 'disk', kind: 'cylinder', params: { x: 0, y: 0, r: 60, h: 8 } },
    { id: 'bore', kind: 'cylinder', params: { x: 0, y: 0, r: 30.5, h: 8 } },
  ];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    bodies.push({ id: `bl${k}`, kind: 'box', params: { x: 35 * Math.cos(a), y: 35 * Math.sin(a), dx: 30, dy: 6, dz: 10 } });
  }
  bodies.push({ id: 'shaft', kind: 'cylinder', params: { x: 0, y: 0, r: 30, h: 120 } });
  bodies.push({ id: 'b1', kind: 'boolean', params: { op: 'cut', a: 'outer', b: ['cav'] } });
  bodies.push({ id: 'b2', kind: 'boolean', params: { op: 'cut', a: 'disk', b: ['bore'] } });
  bodies.push({ id: 'b3', kind: 'boolean', params: { op: 'fuse', a: 'disk', b: bodies.slice(4, 10).map((b) => b.id) } });
  const r = evaluate(task, { bodies });
  assert.equal(r.score, 100, `整机装配应 100 分，实际 ${r.score}（${r.checks.filter((c) => !c.pass).map((c) => c.detail).join('；')}）`);
  // 缺泵轴 → 配合验收失败
  const noShaft = bodies.filter((b) => b.id !== 'shaft');
  const rNoShaft = evaluate(task, { bodies: noShaft });
  assert(rNoShaft.score < 95, `缺泵轴应扣分（实际 ${rNoShaft.score}）`);
  const fit = rNoShaft.checks.find((c) => c.detail && c.detail.includes('轴 Φ60'));
  assert(fit && !fit.pass, '配合检查应报缺轴');
  // 干涉：孔 29 < 轴 30 → 配合失败
  const inter = bodies.map((b) => (b.id === 'bore' ? { ...b, params: { ...b.params, r: 29 } } : b));
  const rInter = evaluate(task, { bodies: inter });
  assert(rInter.score < 95, `轴孔干涉应扣分（实际 ${rInter.score}）`);
  const fitI = rInter.checks.find((c) => c.detail && c.detail.includes('轴 Φ60'));
  assert(fitI && !fitI.pass, '配合检查应报干涉');
  ok(`微型泵整机装配验收（完整 100 分 / 缺轴 ${rNoShaft.score} / 干涉 ${rInter.score}）`);
}
{
  // 水泵剖视图 2D
  const task = taskById('pump2d');
  const ents = [
    { id: 'c1', type: 'circle', cx: 0, cy: 0, r: 70 },
    { id: 'c2', type: 'circle', cx: 18, cy: 0, r: 45 },
    { id: 'c3', type: 'circle', cx: 0, cy: 0, r: 40 },
    { id: 'c4', type: 'circle', cx: 0, cy: 0, r: 12 },
    { id: 'l1', type: 'line', x1: 0, y1: -90, x2: 0, y2: 90 },
  ];
  assert.equal(evaluate(task, ents).score, 100, '水泵剖视图应 100 分');
  const missing = ents.filter((e) => e.id !== 'c3');
  const r = evaluate(task, missing);
  assert(r.score < 90, `漏叶轮圆应扣分（实际 ${r.score}）`);
  ok(`水泵剖视图验收（漏叶轮圆 ${r.score} 分）`);
}

console.log(`全部通过：${n} 项`);
