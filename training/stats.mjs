/* ============================================================
 * 小宝CAD 画图训练 · 日志统计分析（纯函数，Node/浏览器通用）
 * 输入：logEntry() 生成的条目数组
 * 输出：整体趋势 + 按任务聚合 + 审阅有效率（质量提升可量化）
 * ============================================================ */

/** 只保留真实模型轮次。mock 剧本分数是写死的，混进任何指标都会让结论失真。
 *  历史条目没有 mode 字段（回填脚本按时间间隔推断），未标记的一律不算真实。 */
export function realOnly(entries) {
  return (Array.isArray(entries) ? entries : []).filter((e) => e && e.mode === 'real');
}

/** 可用于能力评估的轮次：真实 + 非基础设施故障。
 *  timeout（等待超时）是跑测环境问题，剔除；noproduce（模型没画出东西）是能力问题，必须计入。
 *  返回 { list, excluded } —— 剔除数量要跟着指标一起报出来，否则又变成幸存者偏差。 */
export function evaluable(entries) {
  const real = realOnly(entries);
  const list = real.filter((e) => e.outcome !== 'timeout');
  return { list, excluded: real.length - list.length, total: real.length };
}

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

/** 首绘质量趋势：按时间序的首绘分数滑动平均（训练越久首绘应越高） */
export function firstAttemptTrend(entries, { window = 5 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const lo = Math.max(0, i - window + 1);
    const seg = list.slice(lo, i + 1);
    out.push({
      i: i + 1,
      taskId: list[i].taskId,
      scoreBefore: list[i].scoreBefore,
      avg5: Math.round(seg.reduce((s2, e) => s2 + e.scoreBefore, 0) / seg.length),
    });
  }
  return out;
}

/** 收敛趋势：按轮次序号聚合的分数曲线（跨任务/单任务） */
export function convergence(entries, { taskId = null } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => !taskId || e.taskId === taskId)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const byRound = new Map();
  for (const e of list) {
    if (!byRound.has(e.round)) byRound.set(e.round, []);
    byRound.get(e.round).push(e);
  }
  const curve = [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([round, es]) => ({
    round,
    rounds: es.length,
    firstAttempt: Math.round(es.reduce((s2, e) => s2 + e.scoreBefore, 0) / es.length),
    converged: Math.round(es.reduce((s2, e) => s2 + e.scoreAfter, 0) / es.length),
  }));
  return { taskId: taskId || 'all', rounds: list.length, curve };
}

/** 训练目标达成度：近期 N 轮平均验收分（≥90 视为“已学会该任务”） */
export function recentScore(entries, n = 10) {
  const list = (Array.isArray(entries) ? entries : []).slice(-n);
  if (!list.length) return { score: 0, rounds: 0, mastered: false };
  const score = Math.round(list.reduce((s, e) => s + (e.scoreAfter ?? e.scoreBefore ?? 0), 0) / list.length);
  return { score, rounds: list.length, mastered: score >= 90 };
}

/**
 * 裸需求北极星指标：首绘分中位数（只统计 -bare / conversation 类裸需求任务）
 * 指标1：中位数 ≥ 90
 */
export function bareFirstDrawMedian(entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && /(-bare$|conversation3d)/.test(e.taskId || ''))
    .map((e) => e.scoreBefore)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!list.length) return { median: 0, n: 0 };
  const mid = Math.floor(list.length / 2);
  const median = list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
  return { median, n: list.length, min: list[0], max: list[list.length - 1] };
}

/**
 * 换工况跌幅（指标3）：同一裸需求任务，基准工况首绘分 vs 换工况首绘分
 * 跌幅 = 基准中位首绘 − 换工况首绘；要求 ≤ 10
 * @param entries 日志条目（换工况条目带 duty 字段）
 * @param taskId 如 'pumpduty3d-bare'；缺省时按带 duty 条目的任务自动分组
 */
export function dutyDrop(entries, taskId = null) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && (!taskId || e.taskId === taskId));
  const withDuty = list.filter((e) => e.duty);
  const tid = taskId || withDuty[0]?.taskId || null;
  const base = list
    .filter((e) => !e.duty && (!tid || e.taskId === tid))
    .map((e) => e.scoreBefore)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!base.length || !withDuty.length) return null;
  const mid = Math.floor(base.length / 2);
  const baseMedian = base.length % 2 ? base[mid] : Math.round((base[mid - 1] + base[mid]) / 2);
  const dutyRuns = withDuty.map((e) => ({ duty: e.duty, first: e.scoreBefore }));
  const drops = dutyRuns.map((d) => ({ ...d, drop: baseMedian - d.first }));
  return { taskId: tid, baseMedian, nBase: base.length, dutyRuns: drops };
}
