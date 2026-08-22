/* ============================================================
 * 小宝CAD 工业级离心泵设计计算（商用选型/相似设计基础）
 * 输入工况（流量/扬程/转速）→ 输出关键设计尺寸
 * 公式基于泵设计经典经验公式（简化工程版，供 AI 助手与训练验收使用）
 * ============================================================ */

const G = 9.81;
const RHO = 1000; // kg/m³（清水）

/** 比转速 ns = 3.65 n √Q / H^0.75（Q: m³/s，H: m，n: rpm） */
export function specificSpeed(Qm3h, H, n) {
  const Q = Qm3h / 3600;
  return (3.65 * n * Math.sqrt(Q)) / Math.pow(H, 0.75);
}

/** 叶片数经验取值（按比转速） */
export function bladeCount(ns) {
  if (ns <= 60) return 7;
  if (ns <= 120) return 6;
  if (ns <= 180) return 5;
  return 4;
}

/** 叶轮出口宽度 b2（m） */
export function outletWidth(D2) {
  return 0.1 * D2;
}

/**
 * 由工况计算泵设计参数（商用级简化设计）
 * @param Q 流量 m³/h
 * @param H 扬程 m
 * @param n 转速 rpm
 */
export function sizingFromDuty({ Q, H, n }) {
  if (!(Q > 0) || !(H > 0) || !(n > 0)) throw new Error('流量/扬程/转速必须为正数');
  const ns = specificSpeed(Q, H, n);
  // 扬程系数 ψ 按比转速插值（经验）
  const psi = Math.max(0.75, Math.min(1.35, 1.25 - 0.001 * ns));
  // 叶轮外径：u2 = ψ√(2gH)，D2 = 60 u2 / (π n)
  const u2 = psi * Math.sqrt(2 * G * H);
  const D2 = (60 * u2) / (Math.PI * n); // m
  // 进口直径：进口流速 v1 ≈ 2.5~3.5 m/s
  const v1 = Math.max(2.2, Math.min(3.8, 2.6 + 0.001 * ns));
  const D1 = Math.sqrt((4 * (Q / 3600)) / (Math.PI * v1)); // m
  const Z = bladeCount(ns);
  const b2 = outletWidth(D2);
  // 蜗壳基圆（隔舌间隙 5% D2）
  const D3 = 1.06 * D2;
  const b3 = b2 + 0.05 * D2;
  // 出口直径 ≈ 0.85 D1
  const outletD = 0.85 * D1;
  // 轴功率估算（η=0.78）+ 轴径（τ=20MPa 简化）
  const powerKW = (RHO * G * (Q / 3600) * H) / (0.78 * 1000);
  const shaftD = Math.max(0.02, 0.02 * Math.pow(powerKW / (n / 1000), 1 / 3)); // m，最小 20mm
  return {
    Q, H, n, ns: Math.round(ns * 10) / 10, psi: Math.round(psi * 100) / 100,
    D2mm: Math.round(D2 * 1000), D1mm: Math.round(D1 * 1000),
    Z, b2mm: Math.round(b2 * 1000),
    D3mm: Math.round(D3 * 1000), b3mm: Math.round(b3 * 1000),
    outletDmm: Math.round(outletD * 1000),
    shaftDmm: Math.round(shaftD * 1000),
    powerKW: Math.round(powerKW * 10) / 10,
  };
}

/** 设计参数 → 给 AI 的文本说明（工具返回） */
export function sizingText(p) {
  const ringR = Math.round(0.7 * (p.D2mm / 2));
  const bladeAngles = [];
  const bladePos = [];
  for (let k = 0; k < p.Z; k++) {
    const a = (2 * Math.PI * k) / p.Z;
    bladeAngles.push(Math.round((360 * k) / p.Z));
    bladePos.push(`(${Math.round(ringR * Math.cos(a))}, ${Math.round(ringR * Math.sin(a))})`);
  }
  return [
    `离心泵设计参数（Q=${p.Q}m³/h，H=${p.H}m，n=${p.n}rpm）：`,
    `· 比转速 ns=${p.ns}（${p.ns <= 60 ? '低比转速' : p.ns <= 120 ? '中比转速' : '高比转速'}，扬程系数 ψ=${p.psi}）`,
    `· 叶轮外径 D2=${p.D2mm}mm，出口宽度 b2=${p.b2mm}mm，叶片数 Z=${p.Z}（后弯叶片，出口角 20°~30°）`,
    `· 进口直径 D1=${p.D1mm}mm，出口直径=${p.outletDmm}mm`,
    `· 蜗壳基圆 D3=${p.D3mm}mm（隔舌间隙≈5%D2），蜗壳宽度 b3=${p.b3mm}mm`,
    `· 轴径 d=${p.shaftDmm}mm（轴功率≈${p.powerKW}kW，间隙配合轮毂孔=轴径+0.5mm）`,
    `· ${p.Z} 片叶片中心均布在半径 ${ringR}mm 的分布圆上，各片中心坐标精确为：${bladePos.join('、')}（第 k 片 = (${ringR}·cos(360°·k/${p.Z}), ${ringR}·sin(360°·k/${p.Z}))）。创建时必须逐片使用上面列出的不同坐标（x,y 各不相同），严禁全部使用同一个坐标。`,
    '按上述尺寸精确建模（验收按这些精确值检查，不要自行改尺寸）：泵壳外圆柱半径=D3/2、叶轮轮盘半径=D2/2、泵轴半径=轴径/2、轮毂孔半径=轴径/2+0.5、叶片盒体中心=上面的分布圆坐标。',
    '零件清单只含：泵壳（外圆柱+偏心内腔差集）、叶轮（轮盘+叶片+轮毂孔差集）、泵轴。不要额外添加法兰、底座、隔舌、管嘴、密封、轴承座等零件（会判冗余扣分）。',
  ].join('\n');
}

/** 由工况生成验收检查项（裸需求任务：模型必须先 pump_sizing 算出尺寸才能通过）
 *  所有期望值都从设计计算推导，换一组工况（如 Q=200/H=50/n=1450）检查项自动缩放 */
export function dutyChecks(duty) {
  const p = sizingFromDuty(duty);
  const ringR = Math.round(0.7 * (p.D2mm / 2));
  const shaftR = p.shaftDmm / 2;
  return [
    { type: 'featureCount', min: 12, max: 22, weight: 2 },
    { type: 'kindCount', kind: 'cylinder', min: 5, weight: 2 },
    { type: 'kindCount', kind: 'box', min: p.Z, weight: 2 },
    { type: 'kindCount', kind: 'boolean', min: 3, weight: 3 },
    { type: 'primParam', kind: 'cylinder', field: 'r', approx: p.D3mm / 2, tol: 2, minCount: 1, weight: 3 },
    { type: 'primParam', kind: 'cylinder', field: 'r', approx: p.D2mm / 2, tol: 2, minCount: 1, weight: 3 },
    { type: 'ringDist', kind: 'box', cx: 0, cy: 0, radius: ringR, tol: 1.5, minCount: p.Z, weight: 3 },
    { type: 'angularEven', kind: 'box', cx: 0, cy: 0, radius: ringR, tol: 2, maxDevDeg: 4, weight: 2 },
    { type: 'coaxial', kind: 'cylinder', cx: 0, cy: 0, tol: 2, minCount: 3, weight: 3 },
    { type: 'fitClearance', outerR: shaftR, boreR: shaftR + 0.5, outerTol: 0.6, boreTol: 0.6, minGap: 0.2, maxGap: 1.5, weight: 4 },
  ];
}
