/* 小宝CAD 训练日志统计分析测试（node tests/training-stats.test.mjs） */
import { strict as assert } from 'node:assert';
import { summarize, qualityTrend, recentScore, convergence, firstAttemptTrend } from '../training/stats.mjs';
import { entriesToMarkdown } from '../training/report.mjs';
import { logEntry } from '../training/acceptance.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const entries = [
  logEntry({ taskId: 'flange2d', taskName: '法兰盘', round: 1, ws: '2d', scoreBefore: 54, scoreAfter: 100, reviewOutcome: '已满意', reviewRounds: 1, ts: 1000 }),
  logEntry({ taskId: 'flange2d', taskName: '法兰盘', round: 2, ws: '2d', scoreBefore: 100, scoreAfter: 100, reviewOutcome: '已满意', reviewRounds: 0, ts: 2000 }),
  logEntry({ taskId: 'minipump3d', taskName: '微型泵整机', round: 1, ws: '3d', scoreBefore: 74, scoreAfter: 100, reviewOutcome: '已满意', reviewRounds: 1, ts: 3000 }),
  logEntry({ taskId: 'minipump3d', taskName: '微型泵整机', round: 2, ws: '3d', scoreBefore: 83, scoreAfter: 91, reviewOutcome: '审阅完成', reviewRounds: 1, ts: 4000 }),
];

{
  const s = summarize(entries);
  assert.equal(s.rounds, 4);
  assert.equal(s.avgBefore, Math.round((54 + 100 + 74 + 83) / 4), `avgBefore 应 ${Math.round((54 + 100 + 74 + 83) / 4)}，实际 ${s.avgBefore}`);
  assert.equal(s.avgAfter, Math.round((100 + 100 + 100 + 91) / 4));
  assert.equal(s.tasks.length, 2, '应按任务聚合为 2 组');
  const mp = s.tasks.find((t) => t.taskId === 'minipump3d');
  assert.equal(mp.rounds, 2);
  assert.equal(mp.avgBefore, 79);
  assert.equal(mp.avgAfter, 96);
  assert.equal(mp.reviewEffectiveness, 100, '两轮均有 Δ>0');
  assert.equal(mp.satisfactionRate, 50, '1/2 已满意');
  ok(`整体统计：${s.avgBefore} → ${s.avgAfter}（Δ+${s.avgDelta}），审阅有效率 ${s.reviewEffectiveness}%`);
}
{
  const trend = qualityTrend(entries);
  assert.equal(trend.length, 4);
  assert(trend[0].ts === 1000 && trend[3].ts === 4000, '应按时间排序');
  assert.deepEqual(trend.map((t) => t.i), [1, 2, 3, 4]);
  ok('质量曲线按时间排序');
}
{
  const r = recentScore(entries, 2);
  assert.equal(r.rounds, 2);
  assert.equal(r.score, Math.round((100 + 91) / 2));
  assert(r.mastered, '近 2 轮平均 ≥90 应判为已掌握');
  const r2 = recentScore([], 5);
  assert.equal(r2.rounds, 0);
  ok('近期达成度（≥90 分判“已学会该任务”）');
}
{
  const s = summarize([]);
  assert.equal(s.rounds, 0);
  assert.equal(s.tasks.length, 0);
  const s2 = summarize(null);
  assert.equal(s2.rounds, 0);
  ok('空/空值日志防御');
}

{
  const md = entriesToMarkdown(entries);
  assert(md.startsWith('# 小宝CAD 画图训练报告'), '报告应有标题');
  assert(md.includes('## 按任务'), '应有按任务章节');
  assert(md.includes('## 最近轮次明细'), '应有明细章节');
  assert(md.includes('微型泵整机'), '应包含任务名');
  assert(md.includes('78') && md.includes('98'), '应包含整体均分');
  const empty = entriesToMarkdown([]);
  assert(empty.includes('总轮数：0'), '空日志不崩溃');
  ok('Markdown 训练报告生成');
}

{
  // 报告薄弱点联动知识库
  const rows = entries.map((e, i) => ({ ...e, fails: i === 0 ? ['box 圆心距 [35.1, 28.3] 命中 5/6'] : e.fails }));
  const md = entriesToMarkdown(rows);
  assert(md.includes('知识库提醒') || md.includes('叶片'), '报告薄弱点应联动知识库条目');
  ok('报告薄弱点自动关联知识库建议');
}

{
  const c = convergence(entries);
  assert.equal(c.rounds, 4);
  assert(c.curve.length >= 1, '应有收敛曲线');
  assert(c.curve[0].firstAttempt > 0 && c.curve[0].converged >= c.curve[0].firstAttempt, '收敛后分数应≥首绘');
  const single = convergence(entries, { taskId: 'minipump3d' });
  assert.equal(single.taskId, 'minipump3d');
  ok('收敛趋势：轮次×首绘/收敛分数曲线');
}

{
  const t = firstAttemptTrend(entries);
  assert.equal(t.length, 4);
  assert(t.every((p) => p.avg5 >= 0), '滑动平均应非负');
  const rising = firstAttemptTrend([...entries, logEntry({ taskId: 'flange2d', taskName: '法兰盘', round: 3, ws: '2d', scoreBefore: 96, scoreAfter: 100, reviewOutcome: '已满意' })]);
  assert(rising[4].avg5 >= rising[0].avg5, '训练越多首绘趋势应上升（或不降）');
  ok('首绘质量趋势：滑动平均随训练轮次上升');
}

console.log(`全部通过：${n} 项`);
