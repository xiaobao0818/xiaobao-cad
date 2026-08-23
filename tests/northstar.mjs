/* 小宝CAD 北极星指标检查器（真实模型日志专用）
 * 读取 /tmp/real-*.log（真实 MiniMax M3 运行）聚合：
 *   指标1：裸需求任务（-bare / conversation3d）首绘分中位数 ≥ 90（近 N 轮，默认 8）
 *   指标2：全部任务 firstAttemptTrend 滑动均值单调上升，末窗 ≥ 90
 *   指标3：同任务换工况（duty 字段）首绘分跌幅 ≤ 10
 *
 * 失败轮处理：一律计入并在结论旁标注，不再静默丢弃。
 *   曾经的 `scoreBefore===0 && note==='绘制未完成' → continue` 丢掉了 107 条里的 15 条、
 *   且全是失败轮，指标 3 的"达标"就是这么来的（丢掉换工况 5 轮里唯一失败的那轮）。
 *   现在每条指标同时给出「含失败轮 / 剔除失败轮」两个值，两者结论不一致时明确告警。
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
      if (e.taskId && typeof e.scoreBefore === 'number') entries.push(e);
    } catch (err) {}
  }
}
const seen = new Set();
const uniq = entries.filter((e) => (seen.has(e.ts) ? false : (seen.add(e.ts), true)));
const all = uniq.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
// mock 剧本分数写死，永不计入
const byTs = all.filter((e) => e.mode !== 'mock');

/** 失败轮判定：新日志看 outcome，老日志（无 outcome）退回原有的启发式 */
const isFail = (e) => (e.outcome
  ? e.outcome !== 'ok'
  : e.scoreBefore === 0 && e.note === '绘制未完成');
const kept = byTs.filter((e) => !isFail(e));
const failed = byTs.filter(isFail);
const legacy = failed.filter((e) => !e.outcome).length;

console.log(`\n数据源: ${files.length} 个日志文件 → ${all.length} 条去重条目`
  + (all.length !== byTs.length ? `（剔除 mock ${all.length - byTs.length} 条）` : ''));
console.log(`失败轮: ${failed.length}/${byTs.length} 条（${Math.round((failed.length / byTs.length) * 100)}%）`
  + (legacy ? `，其中 ${legacy} 条为老日志、无法区分超时与模型未产出` : ''));

/** 一条指标同时给出两个口径，结论不一致时告警 */
const verdict = (name, withFail, withoutFail, target, cmp = (v) => v >= target) => {
  const a = cmp(withFail), b = cmp(withoutFail);
  const mark = (v, ok) => `${v} ${ok ? '✅' : '❌'}`;
  console.log(`  含失败轮: ${mark(withFail, a)}   剔除失败轮: ${mark(withoutFail, b)}   目标 ${target}`);
  if (a !== b) console.log(`  ⚠️ 两个口径结论相反 —— ${name}是否达标取决于怎么处理失败轮，不能算达标`);
  return a && b;
};

// 指标1：裸需求任务近 N 轮首绘中位数
const isBare = (e) => /(-bare$|conversation3d)/.test(e.taskId || '');
const bareAll = byTs.filter(isBare).slice(-WINDOW);
const bareKept = kept.filter(isBare).slice(-WINDOW);
console.log(`\n【指标1】裸需求任务近 ${WINDOW} 轮首绘中位数`);
const m1 = verdict('指标1', bareFirstDrawMedian(bareAll).median, bareFirstDrawMedian(bareKept).median, 90);
console.log('  最近序列: ' + bareAll.map((e) => `${e.taskId}:${e.scoreBefore}${isFail(e) ? '(失败)' : ''}`).join(' | '));

// 指标2：全部任务首绘趋势（滑动均值单调性 + 末窗）
const lastAvgOf = (list) => {
  const t = firstAttemptTrend(list, { window: 5 });
  return t.length ? t[t.length - 1].avg5 : 0;
};
const trend = firstAttemptTrend(byTs, { window: 5 });
const avgSeries = trend.map((p) => p.avg5);
let mono = true;
for (let i = 1; i < avgSeries.length; i++) if (avgSeries[i] < avgSeries[i - 1] - 1) mono = false;
console.log(`\n【指标2】全部任务首绘滑动均值(窗5)  单调=${mono ? '✅' : '⚠️'}`);
const m2 = verdict('指标2', lastAvgOf(byTs), lastAvgOf(kept), 90);
console.log('  最近 6 个滑动均值(含失败轮): ' + avgSeries.slice(-6).join(' → '));

// 指标3：换工况跌幅
const dutyIds = [...new Set(byTs.filter((e) => e.duty).map((e) => e.taskId))];
let m3 = dutyIds.length > 0;
for (const tid of dutyIds) {
  const dAll = dutyDrop(byTs.filter((e) => e.taskId === tid));
  const dKept = dutyDrop(kept.filter((e) => e.taskId === tid));
  if (!dAll) continue;
  const worst = (d) => (d && d.dutyRuns.length ? Math.max(...d.dutyRuns.map((r) => r.drop)) : 0);
  console.log(`\n【指标3】${tid} 换工况最大跌幅（基准中位 ${dAll.baseMedian}，n=${dAll.nBase}）`);
  for (const r of dAll.dutyRuns) console.log(`  duty=${JSON.stringify(r.duty)} 首绘=${r.first} 跌幅=${r.drop} ${r.drop <= 10 ? '✅' : '❌'}`);
  const uniqueDuties = new Set(dAll.dutyRuns.map((r) => JSON.stringify(r.duty))).size;
  if (uniqueDuties < 3) {
    console.log(`  ⚠️ 只测了 ${uniqueDuties} 组工况，且已被反复训练 —— 这不是泛化测试，需要留出工况`);
  }
  m3 = verdict('指标3', worst(dAll), worst(dKept), 10, (v) => v <= 10) && m3;
}
if (!dutyIds.length) { console.log('\n【指标3】无换工况数据'); m3 = false; }

console.log(`\n========== 北极星总评: ${m1 && m2 && m3 ? '🎯 三条硬指标全部达标' : '⏳ 继续训练'} ==========`);
