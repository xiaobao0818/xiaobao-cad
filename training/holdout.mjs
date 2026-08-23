/* ============================================================
 * 小宝CAD 留出工况集（holdout duties）
 * 泛化评测专用：这些工况点从未用于训练/验收，评测时随机抽一组，
 * 用过即从留出集移除（写回 used 记录），不得回流到训练。
 *
 * 覆盖：低/中/高比转速（ns = 3.65·n·√Q / H^0.75）
 *   ns ≤ 60  低比转速（多级/锅炉给水）
 *   ns 60~120 中比转速（单级单吸）
 *   ns ≥ 120 高比转速（大流量/轴流）
 *
 * 注意：Q=100/H=32/n=2900 与 Q=200/H=50/n=1450 已被训练，禁止出现在这里。
 * ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';

export const HOLDOUT_DUTIES = [
  { Q: 40, H: 60, n: 2900, note: '低比转速·锅炉给水型' },
  { Q: 25, H: 80, n: 2900, note: '低比转速·高扬程' },
  { Q: 60, H: 45, n: 2900, note: '中低比转速' },
  { Q: 150, H: 25, n: 2900, note: '高比转速·大流量' },
  { Q: 80, H: 20, n: 2900, note: '高比转速·中流量' },
  { Q: 250, H: 18, n: 1450, note: '高比转速·大泵' },
  { Q: 120, H: 15, n: 1450, note: '高比转速' },
  { Q: 400, H: 10, n: 1450, note: '极高比转速·近轴流区' },
];

/** 用过即移除：返回一组未使用过的留出工况，并持久化到 used 列表。
 *  @param usedPath 持久化文件（默认 training/logs/holdout-used.json）
 *  @returns { duty, remaining } — 无剩余时 duty 为 null */
export function drawHoldoutDuty(usedPath = null) {
  const path = usedPath || 'training/logs/holdout-used.json';
  let used = [];
  try { used = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { /* 首次使用 */ }
  const usedKeys = new Set(used.map((u) => `${u.Q}/${u.H}/${u.n}`));
  const fresh = HOLDOUT_DUTIES.filter((d) => !usedKeys.has(`${d.Q}/${d.H}/${d.n}`));
  if (!fresh.length) return { duty: null, remaining: 0, used };
  const duty = fresh[Math.floor(Math.random() * fresh.length)];
  used.push({ ...duty, ts: Date.now() });
  writeFileSync(path, JSON.stringify(used, null, 2));
  return { duty, remaining: HOLDOUT_DUTIES.length - used.length, used };
}

/** 只读：当前未使用的留出工况（不消耗） */
export function remainingHoldoutDuties(usedPath = null) {
  const path = usedPath || 'training/logs/holdout-used.json';
  let used = [];
  try { used = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { /* 首次 */ }
  const usedKeys = new Set(used.map((u) => `${u.Q}/${u.H}/${u.n}`));
  return HOLDOUT_DUTIES.filter((d) => !usedKeys.has(`${d.Q}/${d.H}/${d.n}`));
}
