/* ============================================================
 * 小宝CAD 画图训练 · 报告生成器（纯函数，Node/浏览器通用）
 * 训练日志 JSON → Markdown 报告（整体趋势/按任务/最近明细/薄弱点）
 * ============================================================ */
import { summarize } from './stats.mjs';
import { memoryNotes } from './memory.mjs';
import { knowledgeHintForFails } from './knowledge.mjs';

const dt = (ts) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : '—');
const pct = (v) => `${v}%`;

export function entriesToMarkdown(entries) {
  const s = summarize(entries);
  const list = Array.isArray(entries) ? entries : [];
  const L = [];
  L.push('# 小宝CAD 画图训练报告');
  L.push('');
  L.push(`- 时间范围：${dt(list[0]?.ts)} ~ ${dt(list[list.length - 1]?.ts)}`);
  L.push(`- 总轮数：${s.rounds} · 验收前均分 ${s.avgBefore} → 验收后均分 ${s.avgAfter}（Δ${s.avgDelta >= 0 ? '+' : ''}${s.avgDelta}）`);
  L.push(`- 审阅有效率：${pct(s.reviewEffectiveness)}（审阅后分数提升的轮次占比）`);
  L.push('');
  L.push('## 按任务');
  L.push('');
  L.push('| 任务 | 工作区 | 轮数 | 验收前 | 验收后 | Δ | 审阅有效率 | 满意度 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const t of s.tasks) {
    L.push(`| ${t.taskName} | ${t.ws.toUpperCase()} | ${t.rounds} | ${t.avgBefore} | ${t.avgAfter} | ${t.avgDelta >= 0 ? '+' : ''}${t.avgDelta} | ${pct(t.reviewEffectiveness)} | ${pct(t.satisfactionRate)} |`);
  }
  L.push('');
  L.push('## 最近轮次明细');
  L.push('');
  L.push('| 时间 | 任务 | 验收前 | 验收后 | 结论 | 审阅轮 | 反馈轮 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const e of list.slice(-15)) {
    L.push(`| ${dt(e.ts)} | ${e.taskName} | ${e.scoreBefore} | ${e.scoreAfter} | ${e.reviewOutcome || '—'} | ${e.reviewRounds} | ${e.fbRounds} |`);
  }
  const tasks = new Map();
  for (const e of list) if (!tasks.has(e.taskId)) tasks.set(e.taskId, e.taskName);
  const weak = [];
  for (const [id, name] of tasks) {
    const notes = memoryNotes(list, id, { maxNotes: 2 });
    if (!notes) continue;
    const histFails = list.filter((e) => e.taskId === id && Array.isArray(e.fails)).flatMap((e) => e.fails);
    const kb = knowledgeHintForFails(histFails);
    weak.push(`### ${name}\n${notes}${kb ? '\n\n' + kb : ''}`);
  }
  if (weak.length) {
    L.push('');
    L.push('## 薄弱点（供持续训练定向改进）');
    L.push('');
    L.push(weak.join('\n\n'));
  }
  return L.join('\n');
}
