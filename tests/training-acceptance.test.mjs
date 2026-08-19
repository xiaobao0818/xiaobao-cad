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
  assert.equal(TRAIN_TASKS.length, 4, '任务库应含 2D/3D 各 2 个任务');
  ok('训练任务库 4 个任务');
}

console.log(`全部通过：${n} 项`);
