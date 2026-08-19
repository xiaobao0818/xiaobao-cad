/* ============================================================
 * 小宝CAD 画图训练任务库（供训练循环页与验收器使用）
 * 每个任务：AI 自然语言指令 + 确定性验收标准（几何/结构）
 * 训练闭环：AI 画图 → 验收打分 → MiniMax M3 多模态审阅 → 修复 → 再打分
 * ============================================================ */

export const TRAIN_TASKS = [
  {
    id: 'flange2d',
    ws: '2d',
    name: '法兰盘俯视图（2D）',
    prompt: '请画一个法兰盘俯视图：外圆直径 100（圆心在原点），在半径 35 的圆周上均布 6 个直径 10 的小孔，并画互相垂直的中心线穿过圆心。',
    checks: [
      { type: 'count', kind: 'circle', min: 7, weight: 2 },
      { type: 'circleAt', cx: 0, cy: 0, r: 50, tol: 1, weight: 3 },
      { type: 'holesOnRing', cx: 0, cy: 0, radius: 35, rTol: 1.5, holeR: 5, holeRTol: 1, count: 6, weight: 4 },
      { type: 'linesThrough', cx: 0, cy: 0, min: 2, tol: 3, weight: 2 },
      { type: 'bbox', w: 110, h: 110, tol: 15, weight: 2 },
    ],
  },
  {
    id: 'bracket2d',
    ws: '2d',
    name: '支架轮廓图（2D）',
    prompt: '请画一个支架的外形轮廓：100×60 的矩形外框（左下角在原点），内部在 (20,30) 和 (80,30) 各有一个半径 10 的圆孔。',
    checks: [
      { type: 'count', kind: 'circle', min: 2, weight: 2 },
      { type: 'closedPolylineBbox', w: 100, h: 60, tol: 2, weight: 3 },
      { type: 'circleAt', cx: 20, cy: 30, r: 10, tol: 1, weight: 3 },
      { type: 'circleAt', cx: 80, cy: 30, r: 10, tol: 1, weight: 3 },
    ],
  },
  {
    id: 'plate3d',
    ws: '3d',
    name: '四孔安装板（3D）',
    prompt: '请建一个四孔安装板的三维模型：100×80×10 的长方体板（中心在原点），四个角各打一个半径 8 的通孔（孔心在 (±35,±25)），用差集挖孔。',
    checks: [
      { type: 'featureCount', min: 5, weight: 2 },
      { type: 'kindCount', kind: 'box', min: 1, weight: 2 },
      { type: 'kindCount', kind: 'cylinder', min: 4, weight: 3 },
      { type: 'kindCount', kind: 'boolean', min: 1, weight: 3 },
      { type: 'primDim', kind: 'box', field: 'dx', approx: 100, tol: 3, weight: 2 },
      { type: 'primDim', kind: 'box', field: 'dy', approx: 80, tol: 3, weight: 2 },
      { type: 'primParam', kind: 'cylinder', field: 'r', approx: 8, tol: 1, minCount: 4, weight: 3 },
      { type: 'primPos', kind: 'cylinder', x: 35, y: 25, tol: 2, minCount: 1, weight: 2 },
    ],
  },
  {
    id: 'sleeve3d',
    ws: '3d',
    name: '轴套（3D）',
    prompt: '请建一个轴套的三维模型：外圆柱半径 40、高 60，中心挖一个半径 25 的同心通孔（差集）。',
    checks: [
      { type: 'featureCount', min: 3, weight: 2 },
      { type: 'kindCount', kind: 'cylinder', min: 2, weight: 3 },
      { type: 'kindCount', kind: 'boolean', min: 1, weight: 3 },
      { type: 'primParam', kind: 'cylinder', field: 'r', approx: 40, tol: 2, minCount: 1, weight: 2 },
      { type: 'primParam', kind: 'cylinder', field: 'r', approx: 25, tol: 2, minCount: 1, weight: 2 },
      { type: 'primParam', kind: 'cylinder', field: 'h', approx: 60, tol: 2, minCount: 2, weight: 2 },
    ],
  },

  /* ============ 工业级水泵组件训练（用户核心场景） ============ */
  {
    id: 'impeller3d',
    ws: '3d',
    name: '水泵叶轮（3D）',
    prompt: '请建一个离心泵叶轮：轮盘为半径 60、厚 8 的圆盘（中心在原点），轮毂处挖半径 10 的中心通孔，圆周半径 35 上均布 6 片叶片（每片约 30×6×10），并把叶片与轮盘合并为整体。',
    checks: [
      { type: 'featureCount', min: 9, weight: 2 },
      { type: 'kindCount', kind: 'cylinder', min: 2, weight: 2 },
      { type: 'kindCount', kind: 'box', min: 6, weight: 3 },
      { type: 'kindCount', kind: 'boolean', min: 1, weight: 3 },
      { type: 'primDim', kind: 'cylinder', field: 'r', approx: 60, tol: 2, weight: 2 },
      { type: 'primParam', kind: 'cylinder', field: 'r', approx: 10, tol: 1, minCount: 1, weight: 2 },
      { type: 'ringDist', kind: 'box', cx: 0, cy: 0, radius: 35, tol: 2, minCount: 6, weight: 4 },
    ],
  },
  {
    id: 'casing3d',
    ws: '3d',
    name: '水泵泵壳（3D）',
    prompt: '请建一个离心泵泵壳（简化蜗壳）：外圆柱半径 70、高 50（中心在原点），底部加 160×100×15 的安装底座，进水口法兰（半径 25、厚 12）在 (0,-90)，出水口法兰（半径 25、厚 12）在 (95,0)，最后用半径 45 的偏心内腔（圆心偏移 x=18）挖出流道。',
    checks: [
      { type: 'featureCount', min: 6, weight: 2 },
      { type: 'kindCount', kind: 'cylinder', min: 4, weight: 2 },
      { type: 'kindCount', kind: 'box', min: 1, weight: 2 },
      { type: 'kindCount', kind: 'boolean', min: 2, weight: 3 },
      { type: 'primDim', kind: 'cylinder', field: 'r', approx: 70, tol: 2, weight: 2 },
      { type: 'primParam', kind: 'cylinder', field: 'r', approx: 45, tol: 2, minCount: 1, weight: 2 },
      { type: 'primPos', kind: 'cylinder', x: 18, y: 0, tol: 2, minCount: 1, weight: 2 },
      { type: 'coaxial', kind: 'cylinder', cx: 0, cy: 0, tol: 2, minCount: 1, weight: 2 },
    ],
  },
  {
    id: 'shaft3d',
    ws: '3d',
    name: '泵轴·台阶轴（3D）',
    prompt: '请建一根五段台阶轴（各段同轴，直径逐段递减）：第 1 段半径 30 长 40，第 2 段半径 25 长 60，第 3 段半径 20 长 80，第 4 段半径 15 长 50，第 5 段半径 10 长 30。',
    checks: [
      { type: 'featureCount', min: 5, weight: 2 },
      { type: 'kindCount', kind: 'cylinder', min: 5, weight: 2 },
      { type: 'coaxial', kind: 'cylinder', cx: 0, cy: 0, tol: 2, minCount: 5, weight: 4 },
      { type: 'primSeq', kind: 'cylinder', field: 'r', dir: 'dec', minCount: 5, weight: 3 },
      { type: 'dimSum', kind: 'cylinder', field: 'h', approx: 260, tol: 5, weight: 3 },
      { type: 'primParam', kind: 'cylinder', field: 'r', approx: 30, tol: 1, minCount: 1, weight: 2 },
    ],
  },
  {
    id: 'pump2d',
    ws: '2d',
    name: '水泵剖视图（2D）',
    prompt: '请画水泵的剖视图：竖直中心线穿过原点；泵壳外轮廓圆半径 70（圆心原点）；内腔圆半径 45（圆心 (18,0)，偏心）；叶轮圆半径 40（圆心原点）；轮毂圆半径 12（圆心原点）。',
    checks: [
      { type: 'count', kind: 'circle', min: 4, weight: 2 },
      { type: 'circleAt', cx: 0, cy: 0, r: 70, tol: 1, weight: 2 },
      { type: 'circleAt', cx: 18, cy: 0, r: 45, tol: 1, weight: 3 },
      { type: 'circleAt', cx: 0, cy: 0, r: 40, tol: 1, weight: 3 },
      { type: 'circleAt', cx: 0, cy: 0, r: 12, tol: 1, weight: 3 },
      { type: 'linesThrough', cx: 0, cy: 0, min: 1, tol: 2, weight: 2 },
    ],
  },
];

export const taskById = (id) => TRAIN_TASKS.find((t) => t.id === id) || null;
