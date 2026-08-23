/* 留出工况集测试（node tests/holdout.test.mjs） */
import { strict as assert } from 'node:assert';
import { HOLDOUT_DUTIES, drawHoldoutDuty, remainingHoldoutDuties } from '../training/holdout.mjs';
import { specificSpeed } from '../training/pumpdesign.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

{
  // 留出集覆盖低/中/高比转速，且不含训练用工况
  assert.ok(HOLDOUT_DUTIES.length >= 6, `留出工况应 ≥6 组（实际 ${HOLDOUT_DUTIES.length}）`);
  const nsList = HOLDOUT_DUTIES.map((d) => specificSpeed(d.Q, d.H, d.n));
  assert.ok(nsList.some((ns) => ns <= 60), '应含低比转速（≤60）');
  assert.ok(nsList.some((ns) => ns > 60 && ns <= 120), '应含中比转速（60~120）');
  assert.ok(nsList.some((ns) => ns > 120), '应含高比转速（>120）');
  const trained = HOLDOUT_DUTIES.some((d) => (d.Q === 100 && d.H === 32 && d.n === 2900) || (d.Q === 200 && d.H === 50 && d.n === 1450));
  assert.ok(!trained, '留出集不得包含训练用工况（100/32/2900、200/50/1450）');
  ok(`留出工况集 ${HOLDOUT_DUTIES.length} 组，比转速覆盖 ${nsList.map((v) => v.toFixed(0)).join('/')}`);
}

{
  // 用过即移除：抽取不重复，耗尽后返回 null
  const tmp = '/tmp/holdout-test-' + Date.now() + '.json';
  const drawn = new Set();
  for (let i = 0; i < HOLDOUT_DUTIES.length; i++) {
    const r = drawHoldoutDuty(tmp);
    assert.ok(r.duty, `第 ${i + 1} 次应能抽取`);
    drawn.add(`${r.duty.Q}/${r.duty.H}/${r.duty.n}`);
  }
  assert.equal(drawn.size, HOLDOUT_DUTIES.length, '抽取不得重复');
  const exhausted = drawHoldoutDuty(tmp);
  assert.equal(exhausted.duty, null, '耗尽后应返回 null');
  assert.equal(remainingHoldoutDuties(tmp).length, 0, '耗尽后剩余 0');
  ok(`用过即移除：${HOLDOUT_DUTIES.length} 组全部抽取后无重复且耗尽`);
}

console.log(`全部通过：${n} 项`);
