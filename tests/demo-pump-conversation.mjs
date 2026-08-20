/* 小宝CAD 商用泵端到端演示：一句需求 → 设计计算 → 商用级水泵模型
 * 用法：
 *   node tests/demo-pump-conversation.mjs            # mock 模式（可重复、零成本）
 *   REAL=1 MINIMAX_KEY=... node tests/demo-pump-conversation.mjs  # 真实 MiniMax M3
 * 展示完整链路：自然语言需求 → pump_sizing 设计计算 → 参数化建模 → 多模态审阅 → 验收打分 */
import puppeteer from 'puppeteer-core';

const REAL = process.env.REAL === '1';
const KEY = process.env.MINIMAX_KEY || '';
const REQUEST = process.env.REQUEST ||
  '客户要求一台单级单吸离心泵：流量 100m³/h，扬程 32m，转速 2900rpm，介质清水。请先计算设计参数，再按参数创建商用级装配模型（泵壳+叶轮+轴，带内腔流道与间隙配合）。';
const DEMO_TASK = process.env.TASK || 'conversation3d'; // 或 drawingchain2d（图纸演示）

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  timeout: 60000,
  protocolTimeout: 1800000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  if (REAL) {
    await page.evaluateOnNewDocument((k) => {
      localStorage.setItem('xbcad:ai-settings', JSON.stringify({
        base: 'https://api.minimaxi.com', model: 'MiniMax-M3', key: k,
        temperature: 0.2, maxTokens: 8000, useTools: true, autoReview: false,
        visionBase: 'https://api.minimaxi.com', visionModel: 'MiniMax-M3', visionKey: k,
        reviewRounds: 6, deepThink: true, settingsVersion: 2,
      }));
    }, KEY);
  }
  await page.goto(`http://localhost:8899/tests/train-loop.html?${REAL ? 'real=1' : 'mock=1'}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => !!window.__aiPanel && !!window.CAD?.scene, { timeout: 60000, polling: 1000 });
  await page.waitForFunction(() => window.CAD.app3d?.ready === true, { timeout: 600000, polling: 2000 }).catch(() => console.log('  [warn] 3D 内核未就绪（继续，模型操作仍可用）'));
  const result = await page.evaluate(async (req, taskId) => {
    const CAD = window.CAD;
    const panel = window.__aiPanel;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { evaluate } = await import('/training/acceptance.mjs');
    const { taskById } = await import('/training/tasks.mjs');
    const task = taskById(taskId); // 裸对话需求 / 图纸集（与 mock 自然语言识别一致）
    // 场景清空 + 按任务工作区（2D 图纸任务在 2D 区，3D 建模任务在 3D 区）
    const ws = task.ws === '3d' ? '3d' : '2d';
    CAD.app.showWorkspace(ws);
    await wait(300);
    if (ws === '3d') CAD.app3d.model.clear();
    else CAD.scene.singleOp('清空', () => CAD.scene.removeEntities([...CAD.scene.entities.keys()]));
    const inputOf = () => (ws === '3d' ? { bodies: CAD.app3d.model.serialize().bodies } : CAD.scene.all());
    // 一句需求（无 [训练任务:] 标记，纯自然语言）
    panel.ask(req);
    const t0 = Date.now();
    while (Date.now() - t0 < (900000)) { if (!panel._busy) break; await wait(200); }
    // 自动审阅 + 验收反馈闭环（与训练管线一致的完整质量修复链路）
    const { feedbackPrompt } = await import('/training/acceptance.mjs');
    let score = 0, fbRounds = 0;
    if (!panel._busy) {
      panel._manualReview();
      while (Date.now() - t0 < 1800000) { if (!panel._busy) break; await wait(200); }
    }
    const model = CAD.app3d.model;
    const evalNow = () => evaluate(task, inputOf());
    score = evalNow().score;
    while (score < 90 && fbRounds < 3) {
      const p = feedbackPrompt(task, evalNow());
      if (!p) break;
      fbRounds++;
      panel.ask(p);
      const tt = Date.now();
      while (Date.now() - tt < 900000) { if (!panel._busy) break; await wait(200); }
      score = evalNow().score;
    }
    const checks = evalNow().checks.map((c) => ({ pass: c.pass, detail: c.detail }));
    const bodies = ws === '3d' ? model.serialize().bodies : CAD.scene.all();
    return {
      ws: CAD.workspace,
      features: bodies.length,
      visible: ws === '3d' ? model.visibleCount() : bodies.length,
      score,
      fbRounds,
      checks,
      conv: panel.messages.filter((m) => ['user', 'assistant', 'system'].includes(m.role)).slice(-12)
        .map((m) => `${m.role === 'user' ? '👤' : m.role === 'assistant' ? '🤖' : 'ℹ️'} ${typeof m.content === 'string' ? m.content.slice(0, 120) : '(多模态消息)'}`),
    };
  }, REQUEST, DEMO_TASK);
  console.log('== 一句需求 ==');
  console.log('👤 ' + REQUEST);
  console.log('== AI 助手响应（节选） ==');
  for (const line of result.conv) console.log('  ' + line.replace(/\n/g, ' '));
  console.log(`== 验收结果：${result.score} 分（特征 ${result.features}，可见 ${result.visible}） ==`);
  for (const c of result.checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.detail}`);
  console.log(result.score >= 90 ? 'DEMO_PASS ✅ 一句需求 → 商用级水泵模型' : 'DEMO_PARTIAL ⚠ 未达 90 分（可继续对话让 AI 修复）');
  process.exitCode = result.score >= 90 ? 0 : 1;
} finally {
  await browser.close();
}
