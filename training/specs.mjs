/* ============================================================
 * 小宝CAD 工业级水泵设计规范库（注入训练任务提示）
 * 真实 MiniMax M3 训练时按任务附带对应设计规范，让 AI 画得更专业
 * ============================================================ */

export const PUMP_SPECS = {
  impeller: [
    '叶片数 5~7（离心泵常用 6 片），叶片厚度 3~6mm，轮盘厚度 ≥8mm',
    '叶片后弯，出口安放角 20°~30°',
    '轮毂孔与轴采用间隙配合（如 Φ60H7/f7，间隙 0.03~0.09mm）',
    '叶片沿圆周均布，角度偏差 <5°',
  ],
  casing: [
    '蜗壳隔舌间隙 = 叶轮外径的 5%~10%',
    '泵壳壁厚 ≥6mm（铸铁壳体），进出口法兰按公称压力 PN 选型',
    '泵壳内腔与叶轮同心度误差 <0.1mm',
  ],
  shaft: [
    '台阶轴轴肩过渡圆角 R≥2mm，避免应力集中',
    '轴径公差按 h6~h7，表面粗糙度 Ra≤0.8',
    '各轴段同轴度 <0.03mm',
  ],
  assembly: [
    '轴与叶轮孔 H7/f7 间隙配合（不得干涉）',
    '轴承座与泵壳同轴度 <0.05mm',
    '叶轮与泵壳轴向间隙 0.5~1mm',
  ],
  volute: [
    '蜗壳断面面积沿周向均匀增大（等速法设计）',
    '出口扩散管锥角 8°~12°',
  ],
  flange: [
    '法兰螺栓孔沿圆周均布、跨中布置（避免螺栓孔开在中心线上）',
    '螺栓孔中心距按法兰标准选型',
  ],
};

const TASK_SPECS = {
  impeller3d: ['impeller'],
  casing3d: ['casing'],
  shaft3d: ['shaft'],
  minipump3d: ['assembly', 'impeller'],
  multistage3d: ['assembly', 'impeller'],
  volute2d: ['volute'],
  flange2d: ['flange'],
  bracket2d: ['flange'],
  plate3d: ['flange'],
  pump2d: ['casing', 'volute'],
  sleeve3d: ['assembly'],
  pumpduty3d: ['impeller', 'casing', 'assembly'],
  conversation3d: ['impeller', 'casing', 'assembly'],
  pumpdrawing2d: ['casing', 'volute', 'assembly'],
  selfprime3d: ['impeller', 'casing', 'assembly'],
  drawingframe2d: ['assembly'],
  threeview2d: ['assembly', 'casing'],
  doublesuction3d: ['impeller', 'casing', 'assembly'],
  bom2d: ['assembly', '标准'],
  drawingchain2d: ['assembly', '标准', '材料'],
  axialflow3d: ['assembly', 'impeller'],
  pumpboth: ['impeller', 'casing', 'assembly'],
};

/** 任务对应的规范条目（去重） */
export function specsForTask(taskId) {
  const keys = TASK_SPECS[taskId] || [];
  const out = [];
  for (const k of keys) for (const s of PUMP_SPECS[k] || []) if (!out.includes(s)) out.push(s);
  return out;
}

/** 任务提示 + 工业设计规范（训练时注入） */
export function promptWithSpecs(task) {
  const specs = specsForTask(task.id);
  const lean = task.ws === '3d' ? '\n【建模纪律】按任务清单精确建模：只创建任务要求的零件，不添加任务之外的多余零件/圆角/倒角/装饰特征。' : '';
  if (!specs.length) return task.prompt + lean;
  return task.prompt + '\n【工业设计规范】\n- ' + specs.join('\n- ') + lean;
}
