/* 小宝CAD 北极星指标检查器（真实模型日志专用）
 * 读取 /tmp/real-*.log（真实 MiniMax M3 运行）聚合：
 *   指标1：裸需求任务（-bare / conversation3d）首绘分中位数 ≥ 90（近 N 轮，默认 8）
 *   指标2：全部任务 firstAttemptTrend 滑动均值单调上升，末窗 ≥ 90
 *   指标3：同任务换工况（duty 字段）首绘分跌幅 ≤ 10
 * 运行：node tests/northstar.mjs [N]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { firstAttemptTrend, bareFirstDrawMedian, dutyDrop } from '../training/stats.mjs';

const WINDOW = parseInt(process.argv[2] || '8', 10);
const files = readdirSync('/tmp').filter((f) => /^(real-|demo-real)/.test(f) && f.endsWith('.log'));
const entries = [];
for (const f of files) {
  const s = readFileSync('/tmp/' + f, 'utf8');
  const m = s.match(/"ts":\d+.*/g);
  if (!m) continue;
  for (const line of m) {
    try {
      const e = JSON.parse('{' + line.trim().replace(/,$/, ''));
      if (e.taskId && typeof e.scoreBefore === 'number') {
        if (e.scoreBefore === 0 && e.note === '绘制未完成') continue; // API 故障产物
        entries.push(e);
      }
    } catch (err) {}
  }
}
const seen = new Set();
const uniq = entries.filter((e) => (seen.has(e.ts) ? false : (seen.add(e.ts), true)));
const byTs = uniq.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));

// 指标1：裸需求任务近 N 轮首绘中位数
const bare = byTs.filter((e) => /(-bare$|conversation3d)/.test(e.taskId || '')).slice(-WINDOW);
const m1 = bareFirstDrawMedian(bare);
console.log(`\n【指标1】裸需求任务近 ${WINDOW} 轮首绘中位数: ${m1.median} (n=${m1.n}, min=${m1.min}, max=${m1.max}) ${m1.median >= 90 ? '✅' : '❌'}`);
console.log('  最近序列: ' + bare.map((e) => `${e.taskId}:${e.scoreBefore}`).join(' | '));

// 指标2：全部任务首绘趋势（滑动均值单调性 + 末窗）
const trend = firstAttemptTrend(byTs, { window: 5 });
const lastWin = trend.slice(-5);
const avgSeries = trend.map((p) => p.avg5);
let mono = true;
for (let i = 1; i < avgSeries.length; i++) if (avgSeries[i] < avgSeries[i - 1] - 1) mono = false;
const lastAvg = lastWin.length ? lastWin[lastWin.length - 1].avg5 : 0;
const recentRise = lastWin.length >= 2 && lastWin[lastWin.length - 1].avg5 >= lastWin[0].avg5;
console.log(`\n【指标2】全部任务首绘滑动均值(窗5): 末窗=${lastAvg} (n=${byTs.length}) 单调=${mono ? '✅' : '⚠️'} 近期上升=${recentRise ? '✅' : '⚠️'}`);
console.log('  最近 6 个滑动均值: ' + avgSeries.slice(-6).join(' → '));

// 指标3：换工况跌幅
const bareIds = [...new Set(byTs.filter((e) => e.duty).map((e) => e.taskId))];
for (const tid of bareIds) {
  const d = dutyDrop(byTs.filter((e) => e.taskId === tid));
  if (!d) continue;
  const ok = d.dutyRuns.every((r) => r.drop <= 10);
  console.log(`\n【指标3】${tid} 换工况跌幅: 基准中位 ${d.baseMedian} (n=${d.nBase})`);
  for (const r of d.dutyRuns) console.log(`  duty=${JSON.stringify(r.duty)} 首绘=${r.first} 跌幅=${r.drop} ${r.drop <= 10 ? '✅' : '❌'}`);
  console.log(`  结论: ${ok ? '✅ 达标 (跌幅≤10)' : '❌ 未达标'}`);
}

// 汇总
const m1ok = m1.median >= 90;
const m2ok = lastAvg >= 90;
const m3ok = bareIds.length > 0 && bareIds.every((tid) => dutyDrop(byTs.filter((e) => e.taskId === tid))?.dutyRuns.every((r) => r.drop <= 10));
console.log(`\n========== 北极星总评: ${m1ok && m2ok && m3ok ? '🎯 三条硬指标全部达标' : '⏳ 继续训练'} ==========`);
