/* ============================================================
 * 小宝CAD 训练库 · 知识库桥接：任务 ↔ 知识库
 * 训练提示注入相关知识条目 + AI 助手 query_knowledge 检索
 * ============================================================ */
import { searchKnowledge, searchText } from '../knowledge/data.js';
import { classifyFail } from './memory.mjs';

export { searchKnowledge, searchText };

/** 任务对应的知识库主题（用于训练提示注入） */
const TASK_TOPICS = {
  impeller3d: ['叶轮', '叶片', '材料'],
  casing3d: ['蜗壳', '泵壳', '材料'],
  shaft3d: ['轴', '公差'],
  minipump3d: ['叶轮', '配合', '密封'],
  multistage3d: ['配合', '轴承', '密封'],
  volute2d: ['蜗壳', '隔舌'],
  flange2d: ['法兰', '螺栓'],
  bracket2d: ['材料', '公差'],
  plate3d: ['公差', '螺栓'],
  pump2d: ['蜗壳', '叶轮'],
  sleeve3d: ['配合', '公差'],
  pumpduty3d: ['比转速', '叶轮', '蜗壳', '材料'],
  conversation3d: ['比转速', '叶轮', '蜗壳', '材料'],
  selfprime3d: ['自吸', '叶轮', '密封'],
  drawingframe2d: ['标准', '材料'],
  threeview2d: ['标准', '蜗壳'],
  doublesuction3d: ['双吸', '叶轮', '配合'],
  bom2d: ['标准', '材料'],
};

/** 历史失败明细 → 知识库补救提醒（薄弱点自动关联知识条目） */
export function knowledgeHintForFails(fails, { limit = 2 } = {}) {
  const topics = (Array.isArray(fails) ? fails : []).map((f) => classifyFail(f)).join(' ');
  if (!topics) return '';
  const hits = searchKnowledge(topics, { limit });
  if (!hits.length) return '';
  return '【知识库提醒（针对历史扣分项）】\n' + hits.map((h) => `- ${h.title}：${h.content}`).join('\n');
}

/** 任务知识片段（注入训练提示，最多 3 条） */
export function knowledgeForTask(taskId, { limit = 3 } = {}) {
  const topics = TASK_TOPICS[taskId] || [];
  const out = [];
  for (const t of topics) {
    const hits = searchKnowledge(t, { limit: 1 });
    for (const h of hits) {
      const line = `【知识库·${h.source}】${h.title}：${h.content}`;
      if (!out.includes(line)) out.push(line);
    }
  }
  return out.slice(0, limit);
}
