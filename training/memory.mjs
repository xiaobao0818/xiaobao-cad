/* ============================================================
 * 小宝CAD 画图训练 · 跨轮薄弱点记忆（纯函数，Node/浏览器通用）
 * 从历史训练日志提取某任务反复被扣分的检查类别，
 * 注入新一轮训练提示——让真实模型"记住"历史错误，持续提升质量
 * ============================================================ */

const CLASSIFY = [
  [/均布|圆心距/, '叶片/孔沿圆周均布（圆心距应精确落在设计半径上）'],
  [/角度|角差/, '叶片/孔角度均布（相邻角差应≈360°/数量）'],
  [/同轴|偏心量/, '同轴度（各级轴线应重合，偏心量≈0）'],
  [/配合|间隙|干涉|缺轴|缺孔/, '轴孔间隙配合（轴径<孔径，间隙为正且在容差内）'],
  [/配合链/, '多级配合链（轴→叶轮孔→轴承孔逐级同轴、间隙逐级为正）'],
  [/台阶|直径段/, '台阶轴分段（不同直径段数应达到要求）'],
  [/求和|总长/, '轴向尺寸求和（各段长度之和应精确）'],
  [/螺旋|渐进/, '蜗壳螺旋型线（切圆圆心半径随角度单调增大）'],
  [/数量/, '实体数量（应有实体缺失或过多）'],
  [/闭合轮廓|范围/, '外形轮廓尺寸（轮廓应闭合且尺寸精确）'],
  [/过圆心|直线/, '中心线（应画互相垂直的中心线穿过圆心）'],
  [/未找到/, '关键圆/几何缺失（应画指定半径与位置的圆）'],
  [/特征数/, '特征数量不足'],
];

export function classifyFail(detail) {
  const s = String(detail || '');
  for (const [re, label] of CLASSIFY) if (re.test(s)) return label;
  return s.length > 24 ? s.slice(0, 24) + '…' : s;
}

/** 从历史日志提取任务薄弱点（按出现次数排序，取前 maxNotes 条） */
export function memoryNotes(entries, taskId, { maxNotes = 3 } = {}) {
  const rows = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && e.taskId === taskId && Array.isArray(e.fails) && e.fails.length
  );
  if (!rows.length) return '';
  const counter = new Map();
  for (const e of rows) {
    for (const f of e.fails) {
      const key = classifyFail(f);
      counter.set(key, (counter.get(key) || 0) + 1);
    }
  }
  const top = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxNotes);
  if (!top.length) return '';
  return '【历史薄弱点（此前训练多次被扣分，请务必注意修正）】\n' +
    top.map(([k, c]) => `- ${k}：历史 ${c} 次未通过`).join('\n');
}

/** 组装训练提示：任务 + 设计规范 + 历史薄弱点记忆 */
export function promptWithMemory(task, entries) {
  const parts = [task.prompt];
  const mem = memoryNotes(entries, task.id);
  if (mem) parts.push(mem);
  return parts.join('\n\n');
}
