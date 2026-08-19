/* ============================================================
 * 小宝CAD 画图训练 · 日志统计分析（纯函数，Node/浏览器通用）
 * 输入：logEntry() 生成的条目数组
 * 输出：整体趋势 + 按任务聚合 + 审阅有效率（质量提升可量化）
 * ============================================================ */

export function summarize(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const byTask = new Map();
  for (const e of list) {
    const key = e.taskId || e.taskName || '?';
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(e);
  }
  const tasks = [...byTask.entries()].map(([key, es]) => {
    const avg = (f) => (es.length ? Math.round(es.reduce((s, e) => s + f(e), 0) / es.length) : 0);
    const improved = es.filter((e) => e.delta > 0).length;
    const satisfied = es.filter((e) => e.reviewOutcome === '已满意').length;
    return {
      taskId: es[0]?.taskId || key,
      taskName: es[0]?.taskName || key,
      ws: es[0]?.ws || '',
      rounds: es.length,
      avgBefore: avg((e) => e.scoreBefore),
      avgAfter: avg((e) => e.scoreAfter),
      avgDelta: avg((e) => e.delta),
      reviewEffectiveness: es.length ? Math.round((improved / es.length) * 100) : 0,
      satisfactionRate: es.length ? Math.round((satisfied / es.length) * 100) : 0,
    };
  });

  const avg = (f) => (list.length ? Math.round(list.reduce((s, e) => s + f(e), 0) / list.length) : 0);
  const improved = list.filter((e) => e.delta > 0).length;
  return {
    rounds: list.length,
    avgBefore: avg((e) => e.scoreBefore),
    avgAfter: avg((e) => e.scoreAfter),
    avgDelta: avg((e) => e.delta),
    reviewEffectiveness: list.length ? Math.round((improved / list.length) * 100) : 0,
    tasks,
  };
}

/** 按时间顺序的质量曲线（供趋势图） */
export function qualityTrend(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e === 'object')
    .slice()
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map((e, i) => ({ i: i + 1, ts: e.ts, taskId: e.taskId, scoreBefore: e.scoreBefore, scoreAfter: e.scoreAfter, delta: e.delta }));
}

/** 训练目标达成度：近期 N 轮平均验收分（≥90 视为“已学会该任务”） */
export function recentScore(entries, n = 10) {
  const list = (Array.isArray(entries) ? entries : []).slice(-n);
  if (!list.length) return { score: 0, rounds: 0, mastered: false };
  const score = Math.round(list.reduce((s, e) => s + (e.scoreAfter ?? e.scoreBefore ?? 0), 0) / list.length);
  return { score, rounds: list.length, mastered: score >= 90 };
}
