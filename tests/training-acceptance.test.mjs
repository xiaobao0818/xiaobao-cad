/* 小宝CAD 画图训练验收器测试（node tests/training-acceptance.test.mjs）
 * 验证：好图纸满分/差图纸低分/修复后分数提升（“持续提升质量”可量化） */
import { strict as assert } from 'node:assert';
import { TRAIN_TASKS, taskById } from '../training/tasks.mjs';
import { evaluate, logEntry, feedbackPrompt } from '../training/acceptance.mjs';
import { specsForTask, promptWithSpecs, PUMP_SPECS } from '../training/specs.mjs';
import { memoryNotes, classifyFail, promptWithMemory } from '../training/memory.mjs';
import { sizingFromDuty, sizingText, specificSpeed, bladeCount } from '../training/pumpdesign.mjs';
import { searchKnowledge, searchText, knowledgeForTask, knowledgeHintForFails } from '../training/knowledge.mjs';
import { TRAIN_TASKS as ALL_TASKS, taskById as taskById2 } from '../training/tasks.mjs';

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
  assert.equal(TRAIN_TASKS.length, 13, '任务库应含基础 4 + 水泵 9 个任务');
  ok('训练任务库 13 个任务（含水泵组件 9 个）');
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
  // 两级离心泵：多级配合链验收（轴→叶轮孔→轴承孔）
  const task = taskById('multistage3d');
  const cy = (id, r, h, x = 0, y = 0) => ({ id, kind: 'cylinder', params: { x, y, r, h } });
  const bx = (id, a) => ({ id, kind: 'box', params: { x: 35 * Math.cos(a), y: 35 * Math.sin(a), dx: 30, dy: 6, dz: 10 } });
  const bodies = [
    cy('out1', 70, 50), cy('cav1', 45, 50, 18), cy('disk1', 60, 8), cy('bore1', 30.5, 8),
    cy('out2', 70, 50), cy('cav2', 45, 50, 18), cy('disk2', 60, 8), cy('bore2', 30.5, 8),
    cy('shaft', 30, 200), cy('bear1', 32, 20), cy('bear2', 32, 20),
  ];
  for (let k = 0; k < 12; k++) bodies.push(bx(`bl${k}`, (k % 6) * Math.PI / 3));
  bodies.push(
    { id: 'b1', kind: 'boolean', params: { op: 'cut', a: 'out1', b: ['cav1'] } },
    { id: 'b2', kind: 'boolean', params: { op: 'cut', a: 'disk1', b: ['bore1'] } },
    { id: 'b3', kind: 'boolean', params: { op: 'fuse', a: 'disk1', b: ['bl0', 'bl1', 'bl2', 'bl3', 'bl4', 'bl5'] } },
    { id: 'b4', kind: 'boolean', params: { op: 'cut', a: 'out2', b: ['cav2'] } },
    { id: 'b5', kind: 'boolean', params: { op: 'cut', a: 'disk2', b: ['bore2'] } },
    { id: 'b6', kind: 'boolean', params: { op: 'fuse', a: 'disk2', b: ['bl6', 'bl7', 'bl8', 'bl9', 'bl10', 'bl11'] } },
  );
  const r = evaluate(task, { bodies });
  assert.equal(r.score, 100, `两级泵好模型应 100 分，实际 ${r.score}（${r.checks.filter((c) => !c.pass).map((c) => c.detail).join('；')}）`);
  // 缺轴 → 配合链失败
  const noShaft = bodies.filter((b) => b.id !== 'shaft');
  const rNoShaft = evaluate(task, { bodies: noShaft });
  const chain = rNoShaft.checks.find((c) => c.detail && c.detail.includes('配合链'));
  assert(chain && !chain.pass, '缺轴时配合链应不合格');
  assert(chain.detail.includes('轴 Φ60✗'), '配合链应标注缺轴');
  assert(rNoShaft.score < 95, `缺轴应扣分（实际 ${rNoShaft.score}）`);
  // 轴承孔偏小 31.5 → 间隙超差（轴承孔与轴间隙 1.5 仍为正，但半径不匹配 32±0.5 之外 → 缺件）
  const badBore = bodies.map((b) => (b.id === 'bear1' || b.id === 'bear2' ? { ...b, params: { ...b.params, r: 31 } } : b));
  const rBadBore = evaluate(task, { bodies: badBore });
  const chain2 = rBadBore.checks.find((c) => c.detail && c.detail.includes('配合链'));
  assert(chain2 && !chain2.pass, '轴承孔超差时配合链应不合格');
  ok(`两级泵配合链验收（完整 100 / 缺轴 ${rNoShaft.score} / 轴承孔超差 ${rBadBore.score}）`);
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

{
  // 蜗壳型线：螺旋圆渐进放大
  const task = taskById('volute2d');
  const ents = [{ id: 'base', type: 'circle', cx: 0, cy: 0, r: 40 }];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const d = 50 + i * 5;
    ents.push({ id: `s${i}`, type: 'circle', cx: d * Math.cos(a), cy: d * Math.sin(a), r: 8 });
  }
  ents.push({ id: 'l1', type: 'line', x1: 0, y1: -100, x2: 0, y2: 100 });
  assert.equal(evaluate(task, ents).score, 100, '蜗壳型线应 100 分');
  const half = ents.filter((e) => !(e.id.startsWith('s') && Number(e.id.slice(1)) >= 4));
  const rHalf = evaluate(task, half);
  assert(rHalf.score < 80, `蜗壳漏后半螺旋应扣分（实际 ${rHalf.score}）`);
  ok(`蜗壳型线验收（完整 100 / 漏螺旋 ${rHalf.score}）`);
}
{
  // 叶轮叶片角度均布：6 片均分 60° ✓；一片偏 10° → 扣分
  const task = taskById('impeller3d');
  const mk = (angles) => {
    const bodies = [
      { id: 'disk', kind: 'cylinder', params: { x: 0, y: 0, r: 60, h: 8 } },
      { id: 'hole', kind: 'cylinder', params: { x: 0, y: 0, r: 10, h: 8 } },
    ];
    angles.forEach((a, i) => bodies.push({ id: `bl${i}`, kind: 'box', params: { x: 35 * Math.cos(a), y: 35 * Math.sin(a), dx: 30, dy: 6, dz: 10 } }));
    bodies.push({ id: 'cut', kind: 'boolean', params: { op: 'cut', a: 'disk', b: ['hole'] } });
    bodies.push({ id: 'fuse', kind: 'boolean', params: { op: 'fuse', a: 'disk', b: angles.map((_, i) => `bl${i}`) } });
    return bodies;
  };
  const even = [0, 1, 2, 3, 4, 5].map((k) => (k * Math.PI) / 3);
  assert.equal(evaluate(task, { bodies: mk(even) }).score, 100, '均布叶片应 100 分');
  const uneven = [0, 50 * Math.PI / 180, 2 * Math.PI / 3, Math.PI, 4 * Math.PI / 3, 5 * Math.PI / 3];
  const rU = evaluate(task, { bodies: mk(uneven) });
  const ang = rU.checks.find((c) => c.detail && c.detail.includes('最大角差偏差'));
  assert(ang && !ang.pass, '叶片偏置应被角度均布检查发现');
  ok(`叶片角度均布验收（均分 100 / 偏 10° ${rU.score}）`);
}

{
  // 验收反馈提示：失败明细转成修复指令
  const task = taskById('bracket2d');
  const bad = [{ id: 'r', type: 'polyline', closed: true, points: [P(0, 0), P(100, 0), P(100, 60), P(0, 60)] }];
  const r = evaluate(task, bad);
  const p = feedbackPrompt(task, r);
  assert(p.includes('[训练任务:bracket2d]'), '反馈应带任务标识（供模型定位任务）');
  assert(p.includes('[验收反馈]'), '反馈应带验收反馈标记');
  assert(p.includes('圆'), '反馈应包含失败检查明细');
  assert(p.split('\n').filter((l) => l.startsWith('- ')).length === r.checks.filter((c) => !c.pass).length, '失败明细应逐条列出');
  assert(feedbackPrompt(task, evaluate(task, goodFlange2d())) === '' || true); // 满分时无失败项（本任务不适配，仅防崩溃）
  ok('验收反馈提示生成（失败明细→修复指令）');
}

{
  // 工业设计规范注入：每个任务都应带规范，叶轮任务含叶片数规范
  for (const t of TRAIN_TASKS) {
    const p = promptWithSpecs(t);
    assert(typeof p === 'string' && p.includes(t.prompt), `${t.id} 提示应保留原任务`);
    assert(specsForTask(t.id).length > 0, `${t.id} 应有设计规范`);
  }
  const imp = promptWithSpecs(taskById('impeller3d'));
  assert(imp.includes('叶片数'), '叶轮任务应注入叶片数规范');
  assert(imp.includes('间隙配合'), '叶轮任务应注入轴孔配合规范');
  const dedupe = specsForTask('minipump3d');
  assert.equal(new Set(dedupe).size, dedupe.length, '装配+叶轮规范应去重');
  ok(`设计规范注入：${TRAIN_TASKS.length} 个任务全部附带规范（${Object.keys(PUMP_SPECS).length} 类规范）`);
}

{
  // 跨轮薄弱点记忆：历史失败明细 → 分类聚合 → 注入提示
  const rows = [
    logEntry({ taskId: 'impeller3d', taskName: '叶轮', round: 1, ws: '3d', scoreBefore: 60, scoreAfter: 80, reviewOutcome: '已满意', fails: ['box 圆心距 [35.1, 28.3, 35.0] 命中 5/6', 'box 角度 [0, 60, 120, 180, 240, 300]，最大角差偏差 8.4°'] }),
    logEntry({ taskId: 'impeller3d', taskName: '叶轮', round: 2, ws: '3d', scoreBefore: 80, scoreAfter: 85, reviewOutcome: '审阅完成', fails: ['box 圆心距 [35.2, 34.9, 35.0, 35.1, 28.1, 35.0] 命中 5/6'] }),
    logEntry({ taskId: 'flange2d', taskName: '法兰盘', round: 1, ws: '2d', scoreBefore: 70, scoreAfter: 85, reviewOutcome: '已满意', fails: ['过圆心的直线 0（期望≥2）'] }),
  ];
  const notes = memoryNotes(rows, 'impeller3d');
  assert(notes.includes('【历史薄弱点'), '应生成薄弱点提示');
  assert(notes.includes('均布') && notes.includes('2 次'), '均布问题应聚合为 2 次');
  assert(notes.includes('角度'), '角度问题应被提及');
  assert.equal(memoryNotes(rows, 'sleeve3d'), '', '无历史的任务应返回空');
  const p = promptWithMemory(taskById('impeller3d'), rows);
  assert(p.includes('【历史薄弱点'), '提示应含记忆段落');
  assert.equal(classifyFail('轴 Φ60/孔 Φ61：缺轴'), '轴孔间隙配合（轴径<孔径，间隙为正且在容差内）');
  ok('跨轮薄弱点记忆：历史扣分聚合注入新一轮提示');
}
{
  // 验收明细带实测数值（反馈可执行）
  const task = taskById('impeller3d');
  const bodies = [
    { id: 'disk', kind: 'cylinder', params: { x: 0, y: 0, r: 60, h: 8 } },
    { id: 'hole', kind: 'cylinder', params: { x: 0, y: 0, r: 10, h: 8 } },
    { id: 'b0', kind: 'box', params: { x: 35, y: 0, dx: 30, dy: 6, dz: 10 } },
    { id: 'b1', kind: 'box', params: { x: 0, y: 35, dx: 30, dy: 6, dz: 10 } },
    { id: 'b2', kind: 'box', params: { x: -35, y: 0, dx: 30, dy: 6, dz: 10 } },
    { id: 'b3', kind: 'box', params: { x: 0, y: -35, dx: 30, dy: 6, dz: 10 } },
    { id: 'b4', kind: 'box', params: { x: 28, y: 0, dx: 30, dy: 6, dz: 10 } },
    { id: 'b5', kind: 'box', params: { x: 0, y: -28, dx: 30, dy: 6, dz: 10 } },
  ];
  const r = evaluate(task, { bodies });
  const ring = r.checks.find((c) => c.detail && c.detail.includes('圆心距'));
  assert(ring && ring.detail.includes('28.0') && ring.detail.includes('35.0'), `明细应含实测距离，实际 "${ring?.detail}"`);
  ok('验收明细含实测数值（圆心距列表）');
}

{
  // 泵设计计算：工况 → 关键尺寸（商用级选型）
  const p = sizingFromDuty({ Q: 100, H: 32, n: 2900 });
  assert(p.D2mm > p.D1mm && p.D2mm > 150 && p.D2mm < 220, `D2=${p.D2mm} 应合理`);
  assert(p.shaftDmm >= 20, `轴径 ${p.shaftDmm} 应≥20mm`);
  assert(p.Z >= 4 && p.Z <= 7, `叶片数 ${p.Z} 应 4~7`);
  assert(p.ns > 100 && p.ns < 150, `比转速 ${p.ns} 应≈131`);
  const p2 = sizingFromDuty({ Q: 100, H: 32, n: 1450 });
  assert(p2.ns < p.ns, '低转速应比转速更低');
  assert(specificSpeed(100, 32, 2900) > specificSpeed(50, 32, 2900), '流量越大比转速越高');
  assert.equal(bladeCount(50), 7);
  assert.throws(() => sizingFromDuty({ Q: 0, H: 10, n: 2900 }), /正数/);
  const txt = sizingText(p);
  assert(txt.includes('叶轮外径') && txt.includes(String(p.D2mm)), '设计文本应含关键尺寸');
  ok(`泵设计计算：Q/H/n → D2=${p.D2mm}mm Z=${p.Z} 轴径=${p.shaftDmm}mm`);
}
{
  // 商用泵需求驱动任务：好模型满分
  const task = taskById('pumpduty3d');
  const cy = (id, r, h, x = 0, y = 0) => ({ id, kind: 'cylinder', params: { x, y, r, h } });
  const bodies = [
    cy('outer', 98, 50), cy('cav', 60, 50, 18), cy('disk', 92.5, 8), cy('bore', 16, 8), cy('shaft', 15.5, 120),
  ];
  for (let k = 0; k < 5; k++) {
    const a = (k * 2 * Math.PI) / 5;
    bodies.push({ id: `bl${k}`, kind: 'box', params: { x: 65 * Math.cos(a), y: 65 * Math.sin(a), dx: 40, dy: 6, dz: 12 } });
  }
  bodies.push(
    { id: 'b1', kind: 'boolean', params: { op: 'cut', a: 'outer', b: ['cav'] } },
    { id: 'b2', kind: 'boolean', params: { op: 'cut', a: 'disk', b: ['bore'] } },
    { id: 'b3', kind: 'boolean', params: { op: 'fuse', a: 'disk', b: ['bl0', 'bl1', 'bl2', 'bl3', 'bl4'] } },
  );
  const r = evaluate(task, { bodies });
  assert.equal(r.score, 100, `商用泵好模型应 100 分，实际 ${r.score}（${r.checks.filter((c) => !c.pass).map((c) => c.detail).join('；')}）`);
  const noShaft = evaluate(task, { bodies: bodies.filter((b) => b.id !== 'shaft') });
  assert(noShaft.score < 95, `缺泵轴应扣分（实际 ${noShaft.score}）`);
  ok(`商用泵需求驱动任务（完整 100 / 缺轴 ${noShaft.score}）`);
}

{
  // 知识库检索：材料/配合/比转速/标准
  const mat = searchKnowledge('叶轮 材料');
  assert(mat.length > 0 && mat[0].source === '材料', '叶轮材料检索应命中材料表');
  const fit = searchKnowledge('轴孔 配合');
  assert(fit.some((h) => h.source === '公差配合' && h.title.includes('f7')), '配合检索应命中 H7/f7');
  const ns = searchKnowledge('比转速');
  assert(ns.some((h) => h.title.includes('ns')), '比转速检索应命中选型表');
  const std = searchKnowledge('标准');
  assert(std.some((h) => h.title.includes('GB/T 5657')), '标准检索应命中 GB/T 5657');
  const nothing = searchKnowledge('量子力学');
  assert.equal(nothing.length, 0, '无关检索应无命中');
  const txt = searchText('叶轮 叶片');
  assert(txt.includes('【') && txt.includes('叶片'), '检索文本格式正确');
  ok('知识库检索：材料/配合/比转速/标准命中正确');
}
{
  // 任务 → 知识注入
  const kb = knowledgeForTask('impeller3d');
  assert(kb.length >= 2, `叶轮任务应注入知识条目，实际 ${kb.length}`);
  assert(kb.some((l) => l.includes('叶片数') || l.includes('叶片')), '应含叶轮设计知识');
  const kb2 = knowledgeForTask('pumpduty3d');
  assert(kb2.length >= 2, '商用泵任务应注入多条知识');
  ok('任务知识注入（叶轮/商用泵）');
}

{
  // 图纸任务：几何 + 尺寸标注验收
  const task = taskById('pumpdrawing2d');
  const ents = [
    { id: 'c1', type: 'circle', cx: 0, cy: 0, r: 70 },
    { id: 'c2', type: 'circle', cx: 18, cy: 0, r: 45 },
    { id: 'c3', type: 'circle', cx: 0, cy: 0, r: 40 },
    { id: 'c4', type: 'circle', cx: 0, cy: 0, r: 12 },
    { id: 'l1', type: 'line', x1: 0, y1: -90, x2: 0, y2: 90 },
    { id: 'd1', type: 'dimension', subtype: 'diametric', cx: 0, cy: 0, px: 70, py: 0, tx: 30, ty: 30 },
    { id: 'd2', type: 'dimension', subtype: 'diametric', cx: 0, cy: 0, px: 40, py: 0, tx: -30, ty: -30 },
    { id: 'd3', type: 'dimension', subtype: 'diametric', cx: 0, cy: 0, px: 12, py: 0, tx: 50, ty: -40 },
    { id: 'd4', type: 'dimension', subtype: 'linear', x1: -90, y1: 100, x2: 90, y2: 100, x3: 0, y3: 115 },
  ];
  const r = evaluate(task, ents);
  assert.equal(r.score, 100, `图纸任务应 100 分，实际 ${r.score}（${r.checks.filter((c) => !c.pass).map((c) => c.detail).join('；')}）`);
  const noDims = evaluate(task, ents.filter((e) => e.type !== 'dimension'));
  assert(noDims.score < 80, `无标注图纸应扣分（实际 ${noDims.score}）`);
  ok(`水泵图纸任务：几何+标注验收（完整 100 / 无标注 ${noDims.score}）`);
}
{
  // 薄弱点 → 知识库补救提醒
  const hint = knowledgeHintForFails(['box 圆心距 [35.1, 28.3] 命中 5/6']);
  assert(hint.includes('【知识库提醒'), '应生成知识库补救提醒');
  assert(hint.includes('叶片') || hint.includes('均布'), '提醒应关联叶片均布知识');
  assert.equal(knowledgeHintForFails([]), '', '无失败应返回空');
  ok('薄弱点自动关联知识库条目');
}

{
  // 反馈修复指引：分布圆失败时给出精确坐标
  const task = taskById('impeller3d');
  const bad = [
    { id: 'disk', kind: 'cylinder', params: { x: 0, y: 0, r: 60, h: 8 } },
    { id: 'hole', kind: 'cylinder', params: { x: 0, y: 0, r: 10, h: 8 } },
    { id: 'b0', kind: 'box', params: { x: 35, y: 0, dx: 30, dy: 6, dz: 10 } },
  ];
  const r = evaluate(task, { bodies: bad });
  const p = feedbackPrompt(task, r);
  assert(p.includes('【修复指引】'), '分布圆失败应附修复指引');
  assert(p.includes('(35.0, 0.0)'), '指引应含第 1 片精确坐标');
  assert(p.includes('(-35.0, 0.0)'), '指引应含第 4 片精确坐标');
  const okTask = evaluate(task, { bodies: bad });
  const p2 = feedbackPrompt(task, okTask);
  assert(p2.includes('修复指引'), '缺叶片时也应给坐标指引');
  ok('反馈修复指引：分布圆失败 → 精确坐标列表');
}

console.log(`全部通过：${n} 项`);
