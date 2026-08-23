/* 小宝CAD 训练日志合并（一次性迁移工具 + 后续可复用）
 * 数据源统一：/tmp/real-*.log 是原始运行记录；training/logs/last-log.json 是唯一统计口径。
 * 本脚本把 /tmp 里独有的条目并入 last-log.json（按 ts 去重），并修正回填误标：
 *   - /tmp 有记录但 last-log 缺失 → 并入（老日志无 mode/outcome，标记 modeInferred:true，
 *     outcome 按启发式：scoreBefore===0 且 note==='绘制未完成' → 'noproduce'（模型未产出），
 *     其余 → 'ok'。注意：老日志无法区分 timeout/noproduce，noproduce 是保守归类，
 *     阶段1 EVAL 数据会带来带真实 outcome 的条目。）
 *   - 同一 ts 在 last-log 被标 mock 但 /tmp 是真实运行 → 改为 real（保留 modeInferred:true，
 *     因为它来自回填推断而非运行时刻写入）。
 * 运行：node tests/merge-logs.mjs
 * 完成标志：northstar.mjs 与 dump-training.mjs 报出的真实轮次数一致。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const LOG = 'training/logs/last-log.json';
const tmpFiles = readdirSync('/tmp').filter((f) => /^(real-|demo-real)/.test(f) && f.endsWith('.log'));

/** 从运行日志文本提取条目（兼容带 duty/failsBefore 的 JSON） */
function extract(file) {
  const s = readFileSync('/tmp/' + file, 'utf8');
  const out = [];
  const m = s.match(/"ts":\d+.*/g);
  if (!m) return out;
  for (const line of m) {
    try {
      const e = JSON.parse('{' + line.trim().replace(/,$/, ''));
      if (e.taskId && typeof e.scoreBefore === 'number') out.push(e);
    } catch (err) { /* 跳过解析失败的行 */ }
  }
  return out;
}

const tmpEntries = [];
for (const f of tmpFiles) tmpEntries.push(...extract(f));
const tmpUniq = [...new Map(tmpEntries.map((e) => [e.ts, e])).values()];

const ll = JSON.parse(readFileSync(LOG, 'utf8'));
const llRealTs = new Set(ll.filter((e) => e.mode === 'real').map((e) => e.ts));
const llAllTs = new Set(ll.map((e) => e.ts));

let merged = 0, fixed = 0;
for (const e of tmpUniq) {
  if (llRealTs.has(e.ts)) continue; // 已存在
  if (llAllTs.has(e.ts)) {
    // 同 ts 但 last-log 里是 mock（回填误标真实轮）→ 修正
    const idx = ll.findIndex((x) => x.ts === e.ts);
    if (idx >= 0 && ll[idx].mode === 'mock') {
      ll[idx].mode = 'real';
      ll[idx].modeInferred = true;
      ll[idx].outcome = ll[idx].outcome || 'ok';
      fixed++;
    }
    continue;
  }
  // 老日志：无 mode/outcome，保守补标（不当作运行时刻写入的事实）
  const legacyFail = e.scoreBefore === 0 && e.note === '绘制未完成';
  ll.push({
    ts: e.ts,
    mode: 'real',
    modeInferred: true, // 老日志回填：mode 由文件名推断，不是写入时确定
    outcome: legacyFail ? 'noproduce' : (e.outcome || 'ok'),
    taskId: e.taskId, taskName: e.taskName || e.taskId, round: e.round || 1, ws: e.ws || '',
    scoreBefore: e.scoreBefore, scoreAfter: e.scoreAfter ?? e.scoreBefore,
    delta: (e.scoreAfter ?? e.scoreBefore) - e.scoreBefore,
    reviewOutcome: e.reviewOutcome || (legacyFail ? '未执行' : '已满意'),
    reviewRounds: e.reviewRounds || 0, fbRounds: e.fbRounds || 0,
    fails: e.fails || [], failsBefore: e.failsBefore || [],
    duty: e.duty, note: e.note || '',
  });
  merged++;
}

ll.sort((a, b) => (a.ts || 0) - (b.ts || 0));
writeFileSync(LOG, JSON.stringify(ll, null, 2));
const realCount = ll.filter((e) => e.mode === 'real').length;
console.log(`合并完成：并入 ${merged} 条、修正误标 ${fixed} 条`);
console.log(`last-log.json 现有真实轮次：${realCount}（total ${ll.length}）`);
