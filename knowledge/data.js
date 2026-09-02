/* ============================================================
 * 小宝CAD 平台知识库 · 工业级离心泵设计知识（结构化数据 + 检索）
 * 供 AI 助手 query_knowledge 工具 / 训练提示注入 / 知识库浏览页使用
 * ============================================================ */

export const PUMP_MATERIALS = [
  { part: '叶轮', items: [
    { name: 'ZG1Cr18Ni9Ti', use: '耐腐蚀介质（化工/海水）' },
    { name: 'HT200', use: '清水、常温（≤80℃）' },
    { name: 'ZCuSn10Pb1', use: '海水/盐水，耐磨耐蚀' },
    { name: 'ZG230-450', use: '大流量中低压叶轮' },
  ]},
  { part: '泵壳', items: [
    { name: 'HT200/HT250', use: '清水泵壳（铸铁）' },
    { name: 'ZG1Cr18Ni9Ti', use: '不锈钢泵壳（化工）' },
    { name: 'QT450-10', use: '球墨铸铁，耐压泵壳' },
  ]},
  { part: '泵轴', items: [
    { name: '2Cr13', use: '常用泵轴（马氏体不锈钢）' },
    { name: '45#钢', use: '普通清水泵轴（调质处理）' },
    { name: '316L', use: '强腐蚀介质' },
  ]},
  { part: '叶轮口环', items: [
    { name: 'ZCuSn10Pb1', use: '耐磨口环（与叶轮配对）' },
    { name: '2Cr13 淬硬', use: '硬口环，防咬合' },
  ]},
  { part: '轴套', items: [
    { name: '2Cr13 淬硬', use: '轴封处轴套' },
    { name: '316L', use: '腐蚀介质轴套' },
  ]},
  { part: '机械密封', items: [
    { name: 'SiC-SiC', use: '硬对硬，清水/含颗粒' },
    { name: 'SiC-石墨', use: '通用清水泵' },
    { name: 'WC-石墨', use: '高压泵' },
  ]},
];

export const FITS = [
  { code: 'H7/f7', kind: '间隙配合', use: '轴-叶轮轮毂', note: 'Φ60 间隙 0.030~0.090mm' },
  { code: 'H7/h6', kind: '间隙配合', use: '轴承座-轴承外圈', note: '可轻微滑动' },
  { code: 'H7/k6', kind: '过渡配合', use: '轴-联轴器/轴套', note: '定位准确' },
  { code: 'H7/js6', kind: '过渡配合', use: '叶轮-轴套端面定位', note: '' },
];

export const NS_TABLE = [
  { ns: '30~60', type: '低比转速', blades: '7~9', efficiency: '较低（η≈55~70%）', usage: '高扬程、小流量（锅炉给水）' },
  { ns: '60~120', type: '中比转速', blades: '6', efficiency: '中等（η≈70~82%）', usage: '常规工业泵' },
  { ns: '120~180', type: '高比转速', blades: '5', efficiency: '较高（η≈80~86%）', usage: '大流量、低扬程' },
  { ns: '180~300', type: '混流泵区', blades: '4~5', efficiency: '高（η≈85~90%）', usage: '农灌/循环水' },
];

export const FORMULAS = [
  { name: '比转速', expr: 'ns = 3.65·n·√Q / H^0.75', vars: 'Q(m³/s) H(m) n(rpm)', note: '决定叶轮形状与叶片数' },
  { name: '叶轮外径', expr: 'D2 = 60·ψ·√(2gH) / (π·n)', vars: 'ψ≈0.75~1.35（扬程系数）', note: 'ψ 按比转速插值' },
  { name: '进口直径', expr: 'D1 = √(4Q / (π·v1))', vars: 'v1≈2.2~3.8 m/s', note: '进口流速经验值' },
  { name: '轴径估算', expr: 'd ≥ 20·(P/n)^(1/3) mm', vars: 'P(kW) n(rpm)', note: '最小 20mm，校核强度后取整' },
  { name: '蜗壳基圆', expr: 'D3 = (1.03~1.08)·D2', note: '隔舌间隙≈5%D2' },
];

export const STANDARDS = [
  { code: 'GB/T 14689', name: '图纸幅面标准', note: '仅当任务要求出完整图纸（图框/标题栏）时适用：A3 竖向 420×297mm 标准幅面；图框外轮廓左下角对齐原点 (0,0)；内框装饰线距外框 10mm；标题栏紧贴图框右下角（右下顶点与外轮廓角点重合，常用 180×56，含图名/比例/图号/材料）；明细栏在标题栏上方。只画零件/部件图形时不需要图框' },
  { code: 'GB/T 10609.1', name: '标题栏标准', note: '标题栏位于图纸右下角，含图名、图号、比例、材料、单位；明细栏紧邻标题栏上方' },
  { code: 'GB/T 4458.4', name: '机械制图尺寸注法标准', note: '线性尺寸为主（40 张真实机械图实测约 74%，圆弧/型面类零件径向标注占比升至 ~15%）；直径标 ⌀、半径标 R、角度标度数；尺寸取整 mm 为主（约 86%）；不重复标注、文字放轮廓外' },
  { code: 'GB/T 5657', name: '离心泵技术条件（等同 ISO 5199）', note: '商用泵设计与验收基础标准' },
  { code: 'GB/T 3216', name: '回转动力泵 水力性能验收试验', note: 'Q/H/η 曲线试验规范' },
  { code: 'GB/T 3214', name: '水泵流量的测定方法', note: '' },
  { code: 'GB/T 13469', name: '离心泵、混流泵、轴流泵和旋涡泵系统经济运行', note: '' },
  { code: 'JB/T 8097', name: '泵的振动测量与评价', note: '' },
];

export const DOCS = [
  { id: 'design-flow', title: '离心泵设计流程', content: '1) 明确工况 Q/H/n 与介质；2) 计算比转速 ns 确定泵型与叶片数；3) 估算叶轮外径 D2 与进口直径 D1；4) 设计叶轮流道（后弯叶片 20°~30°）；5) 蜗壳按等速法设计（隔舌间隙 5%D2）；6) 轴径按功率与疲劳校核；7) 密封与轴承选型；8) 出图（总装图/零件图带尺寸标注）。' },
  { id: 'impeller-rules', title: '叶轮设计要点', content: '叶片数按 ns 选取（30~60→7~9，60~120→6，120~180→5）；叶片沿圆周均布、角度偏差<5°；出口安放角 20°~30° 后弯；叶片厚度 3~6mm；轮盘厚度≥8mm；轮毂孔与轴 H7/f7 间隙配合。' },
  { id: 'volute-rules', title: '蜗壳设计要点', content: '蜗壳断面面积沿周向均匀增大（等速法）；隔舌间隙=叶轮外径的 5%~10%；出口扩散管锥角 8°~12°；泵壳壁厚≥6mm（铸铁）；进出口法兰按公称压力 PN 选型；内腔与叶轮同心度<0.1mm。' },
  { id: 'shaft-rules', title: '泵轴设计要点', content: '台阶轴轴肩过渡圆角 R≥2mm 避免应力集中；轴径公差 h6~h7、粗糙度 Ra≤0.8；各轴段同轴度<0.03mm；材料 2Cr13/45#钢调质；按疲劳强度校核最危险截面。' },
  { id: 'doublesuction', title: '双吸泵设计要点', content: '双吸叶轮背靠背布置（水力对称、轴向力自平衡）；两个吸入室对称进流；流量约为单吸泵 2 倍、比转速按单侧流量计算；泵壳为双蜗壳或环形压水室；大流量给水工况常用。' },
  { id: 'selfpriming', title: '自吸泵设计要点', content: '泵体带储液腔与气水分离室，自吸高度一般≤5m；首次启动需灌液；回流孔与隔舌间隙按比转速设计；适用于无底阀、频繁启停场合。' },
  { id: 'multistage-rules', title: '多级泵设计要点', content: '各级叶轮同轴串联，扬程按级数叠加；级间导叶/径向导叶；轴长则需校核挠度与临界转速；平衡轴向力用平衡盘或背对背布置。' },
  { id: 'selection-example', title: '选型样例（工况→泵型）', content: 'Q=100m³/h、H=32m、n=2900rpm：ns≈131 → 中比转速单级单吸离心泵（如 IS100-65-200 系列）；Q=30m³/h、H=12m → 高比转速大流量泵；Q=5m³/h、H=80m → 低比转速多级泵（锅炉给水）；双吸泵适用于大流量中扬程（Q>200m³/h），自吸泵适用于频繁启停/无底阀场合。' },
  { id: 'performance-curves', title: '性能曲线解读', content: 'H-Q 曲线随流量增大扬程下降（陡降型适合流量波动场合）；P-Q 功率曲线决定电机选型（按最大功率点×1.15 裕量）；NPSHr 曲线决定安装高度（装置 NPSHa > NPSHr + 0.5m）；效率最高点为设计工况，选型应使工作点落在高效区（≥80% 最高效率）。' },
  { id: 'axialflow-rules', title: '轴流泵设计要点', content: '高比转速（ns>300）、大流量低扬程；叶片数少（4~6）、叶片扭曲（简化建模可用直盒体近似）；轮毂比 0.45~0.6；导叶将旋转动能转为压力能；泵壳为环形；适用农灌/循环水/排污。' },
  { id: 'seal-rules', title: '密封与轴承', content: '机械密封常用 SiC-石墨（清水）、SiC-SiC（含颗粒）；填料密封用于低压；轴承座与泵壳同轴度<0.05mm；叶轮与泵壳轴向间隙 0.5~1mm。' },
  { id: 'drafting-checklist', title: '商用图纸要素清单', content: '一套商用技术图纸 = 视图（主视图+必要投影）+ 尺寸标注（线性为主，直径 ⌀ / 半径 R，覆盖全部关键尺寸与总长总宽）+ 图框 + 标题栏（右下角）+ 明细栏。主视图应画出轮廓圆、轮毂圆、轴孔圆并标注直径；规格表中的每个尺寸都要有对应标注（真实图纸标注与规格吻合率 94%）。' },
];

export const PUMP_MODELS = [
  { model: 'IS50-32-125', series: 'IS 单级单吸', Q: 12.5, H: 20, n: 2900, powerKW: 1.5, dIn: 50, dOut: 32, note: '小流量中扬程清水' },
  { model: 'IS65-50-160', series: 'IS 单级单吸', Q: 25, H: 32, n: 2900, powerKW: 4, dIn: 65, dOut: 50, note: '常规工业清水' },
  { model: 'IS100-65-200', series: 'IS 单级单吸', Q: 100, H: 32, n: 2900, powerKW: 15, dIn: 100, dOut: 65, note: '大流量中扬程（本平台商用泵训练基准）' },
  { model: 'IS150-125-315', series: 'IS 单级单吸', Q: 200, H: 32, n: 1450, powerKW: 37, dIn: 150, dOut: 125, note: '大流量低转速' },
  { model: 'S300-58A', series: '双吸泵', Q: 288, H: 58, n: 1450, powerKW: 75, dIn: 300, dOut: 250, note: '大流量中扬程双吸' },
];

/* ---------------- 检索 ---------------- */
function matchable(doc, fields) {
  return fields.map((f) => String(doc[f] ?? '')).join(' ');
}

/** 关键词检索知识库：返回相关条目（按相关性排序，limit 条） */
export function searchKnowledge(query, { limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const keys = q.toLowerCase().split(/[\s,，。;；/、]+/).filter(Boolean);
  const score = (text) => {
    const t = text.toLowerCase();
    let s = 0;
    for (const k of keys) if (t.includes(k)) s += k.length > 1 ? 2 : 1;
    return s;
  };
  const hits = [];
  const push = (source, title, content, s) => { if (s > 0) hits.push({ source, title, content, s }); };
  for (const m of PUMP_MATERIALS) {
    const s = score(matchable(m, ['part']) + m.items.map((i) => matchable(i, ['name', 'use'])).join(' '));
    push('材料', m.part, m.items.map((i) => `${i.name}：${i.use}`).join('；'), s);
  }
  for (const f of FITS) push('公差配合', `${f.code}（${f.kind}）`, `${f.use}，${f.note}`.trim(), score(matchable(f, ['code', 'kind', 'use', 'note'])));
  for (const r of NS_TABLE) push('比转速选型', `ns ${r.ns} ${r.type}`, `叶片 ${r.blades}，效率 ${r.efficiency}，适用 ${r.usage}`, score(matchable(r, ['ns', 'type', 'usage'])));
  for (const f of FORMULAS) push('公式', f.name, `${f.expr}（${f.vars}）${f.note}`, score(matchable(f, ['name', 'expr', 'note'])));
  for (const st of STANDARDS) push('标准', `${st.code} ${st.name}`, st.note, score(matchable(st, ['code', 'name', 'note'])));
  for (const d of DOCS) push('设计文档', d.title, d.content, score(matchable(d, ['title', 'content'])));
  for (const pm of PUMP_MODELS) push('泵型号', `${pm.model}（${pm.series}）`, `Q=${pm.Q}m³/h H=${pm.H}m n=${pm.n}rpm 电机${pm.powerKW}kW 口径${pm.dIn}/${pm.dOut}：${pm.note}`, score(matchable(pm, ['model', 'series', 'note'])));
  return hits.sort((a, b) => b.s - a.s).slice(0, limit).map(({ s, ...rest }) => rest);
}

/** 检索结果 → 给 AI 的文本 */
export function searchText(query, { limit = 6 } = {}) {
  const hits = searchKnowledge(query, { limit });
  if (!hits.length) return `知识库中未找到与「${query}」直接相关的内容。可尝试：材料/公差/配合/比转速/叶片/蜗壳/轴/密封/标准/公式 等关键词。`;
  return hits.map((h) => `【${h.source}】${h.title}\n${h.content}`).join('\n\n');
}
