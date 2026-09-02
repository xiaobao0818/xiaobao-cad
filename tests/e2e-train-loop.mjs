/* 小宝CAD 画图训练循环 端到端测试（真实浏览器 + mock AI 服务器）
 * 前置：python3 tests/mock-ai-server.py 运行在 8898；python3 -m http.server 8899 服务本项目
 * 运行：node tests/e2e-train-loop.mjs
 * 验证：AI 画图(带缺陷) → 确定性验收低分 → MiniMax 多模态审阅修复 → 再验收高分 → 日志落盘 */
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:8899';
const TASK = process.env.TASK || 'flange2d';
const ALL = process.env.ALL === '1';
const FB = process.env.FB === '1';
const CONT = process.env.CONT === '1';
const REAL = process.env.REAL === '1';
const ROUNDS = parseInt(process.env.ROUNDS || '1', 10);
const KEEP = process.env.KEEP === '1'; // 保留既有训练日志（分轮续跑：记忆/知识联动跨轮生效）
// EVAL=1：纯首绘评测——跳过多模态审阅与验收反馈，只测「模型第一次画成什么样」。
// 指标只看 scoreBefore，而每轮耗时几乎全在审阅 6 轮 + 反馈 2 轮（都带图片）上，
// 关掉后单轮从 15~30 分钟降到 2~4 分钟，用于快速铺满各任务的真实基线。
const EVAL = process.env.EVAL === '1';
const SKIP3D = process.env.SKIP3D === '1' || (process.env.TASK || 'flange2d') === 'flange2d' ? '1' : '';
const DUTY = process.env.DUTY || ''; // 换工况测试：DUTY=Q,H,n 覆盖任务工况（prompt 重渲染 + dutyChecks 重建）
// HOLDOUT=1：从留出工况集（training/holdout.mjs）随机抽一组未用过的工况评测，
// 用过即从留出集移除（持久化到 training/logs/holdout-used.json），不得回流训练。
let HOLDOUT_DUTY = '';
if (process.env.HOLDOUT === '1') {
  const { drawHoldoutDuty } = await import('../training/holdout.mjs');
  const r = drawHoldoutDuty();
  if (!r.duty) throw new Error('留出工况已全部用完（' + r.used.length + ' 组已评测），需要扩充留出集');
  HOLDOUT_DUTY = `${r.duty.Q},${r.duty.H},${r.duty.n}`;
  console.log(`  [holdout] 抽取留出工况 ${HOLDOUT_DUTY}（${r.duty.note}），剩余 ${r.remaining} 组`);
}

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const REAL_KEY = process.env.MINIMAX_KEY || '';
const LONG_WAIT = REAL ? 2700000 : 1500000;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  timeout: 60000,
  protocolTimeout: 600000,
});

try {
  // 清空训练日志，只跑 2D 法兰盘 1 轮（skip3d 加速）
  const page = await browser.newPage();
  page.on('targetcrashed', () => console.log('  [目标崩溃] 页面进程崩溃（疑似 OOM/渲染器挂起）'));
  page.on('console', (m) => { const t = m.text(); if (t.includes('[训练]') || t.includes('[3d]') || t.includes('[AI]') || t.includes('🔧') || m.type() === 'error') console.log('  [页]', t.slice(0, 1800)); });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  if (REAL) {
    // 真实 MiniMax M3：通过 evaluateOnNewDocument 注入设置（Key 只经环境变量，不落盘）
    await page.evaluateOnNewDocument((key) => {
      localStorage.setItem('xbcad:ai-settings', JSON.stringify({
        base: 'https://api.minimaxi.com', model: 'MiniMax-M3', key,
        temperature: 0.2, maxTokens: 8000, useTools: true, autoReview: false,
        visionBase: 'https://api.minimaxi.com', visionModel: 'MiniMax-M3', visionKey: key,
        reviewRounds: 6, deepThink: true, settingsVersion: 2,
      }));
    }, REAL_KEY);
  }
  await page.goto(`${BASE}/tests/train-loop.html?${REAL ? 'real=1' : 'mock=1'}${SKIP3D ? '&skip3d=1' : ''}${FB || EVAL ? '&noreview=1' : ''}${EVAL ? '&fbmax=0' : (process.env.FBMAX !== undefined ? '&fbmax=' + process.env.FBMAX : '')}${CONT ? '&continuous=1' : ''}${DUTY ? '&duty=' + DUTY : ''}${HOLDOUT_DUTY ? '&duty=' + HOLDOUT_DUTY : ''}`, { waitUntil: 'load', timeout: 60000 });
  if (!KEEP) await page.evaluate(() => localStorage.removeItem('xbcad:training-log'));

  // 选单任务：法兰盘，1 轮
  await page.waitForFunction(() => !!window.__aiPanel, { timeout: 60000, polling: 1000 });
  console.log('  [进度] AI 面板就绪');
  if (REAL) {
    // 兜底：若设置注入失败（偶发竞态），再次注入 Key 并重载面板设置
    const kNow = await page.evaluate(() => window.__aiPanel?.settings?.key || '');
    if (!kNow) {
      console.log('  [warn] 设置注入未生效，重试注入 Key');
      await page.evaluate((key) => {
        localStorage.setItem('xbcad:ai-settings', JSON.stringify({
          base: 'https://api.minimaxi.com', model: 'MiniMax-M3', key,
          temperature: 0.2, maxTokens: 8000, useTools: true, autoReview: false,
          visionBase: 'https://api.minimaxi.com', visionModel: 'MiniMax-M3', visionKey: key,
          reviewRounds: 6, deepThink: true, settingsVersion: 2,
        }));
        const p = window.__aiPanel;
        if (p && typeof p._loadSettings === 'function') p.settings = p._loadSettings();
        // 最后手段：直接强制赋值，避免任何加载竞态
        if (p && (!p.settings?.key) && typeof p.settings === 'object') p.settings.key = key;
        return window.__aiPanel?.settings?.key || '';
      }, REAL_KEY);
    }
    const kFinal = await page.evaluate(() => {
      const raw = localStorage.getItem('xbcad:ai-settings') || '';
      const p = window.__aiPanel;
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch (e) {}
      return { key: p?.settings?.key || '', rawLen: raw.length, storedKeyLen: String(parsed.key || '').length, panelId: p ? p._id || '?' : 'none' };
    });
    if (!kFinal.key) console.log(`  [warn] Key 注入最终仍失败（rawLen=${kFinal.rawLen} storedKeyLen=${kFinal.storedKeyLen} panel=${kFinal.panelId}）`);
    else console.log('  [ok] Key 已就绪（len=' + kFinal.key.length + '）');
  }
  if (!ALL) await page.select('#taskSel', TASK);
  await page.$eval('#rounds', (el, v) => { el.value = String(v); }, ROUNDS);
  await page.click('#btnStart');

  // 等待训练日志出现（画图 → 审阅 → 再打分 完成）
  // 韧性轮询：页面主线程可能被重渲染/布尔运算长时间占用导致 CDP 调用超时，
  // 捕获异常继续等，靠页面心跳区分「还在跑」与「已卡死」
  const pollDone = async (predSrc, timeoutMs, hbGap) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await page.evaluate((src, gap) => {
          const fn = new Function('return (' + src + ')')();
          const hb = window.__hb || 0;
          const hbStall = gap && hb ? Math.max(0, Date.now() - hb - 4000) : 0;
          return { done: !!fn(), hb, hbStall };
        }, predSrc, hbGap || 0);
        if (r.done) return true;
        if (r.hbStall > 0) console.log(`  [warn] 页面心跳停滞 ${(r.hbStall / 1000).toFixed(0)}s（渲染/布尔运算占用主线程）`);
      } catch (e) {
        console.log('  [warn] CDP 轮询中断（主线程繁忙），重试: ' + String(e.message || e).slice(0, 90));
        await new Promise((r) => setTimeout(r, 5000));
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  };
  if (!CONT) {
    const done = await pollDone(`() => {
      const log = JSON.parse(localStorage.getItem('xbcad:training-log') || '[]');
      return log.length >= 1 && document.getElementById('tProg').textContent === '训练完成';
    }`, LONG_WAIT, 600000);
    assert.ok(done, '训练未在时限内完成（页面可能卡死）');
  } else {
    // 持续模式永不“完成”：达到轮数后手动停止
    const done = await pollDone(`() => JSON.parse(localStorage.getItem('xbcad:training-log') || '[]').length >= 13`, LONG_WAIT, 600000);
    assert.ok(done, '持续训练未在时限内达到目标轮数');
    await page.click('#btnStop');
    await page.waitForFunction(() => document.getElementById('tProg').textContent === '已停止', { timeout: 120000, polling: 1000 });
  }

  const entries = await page.evaluate(() => JSON.parse(localStorage.getItem('xbcad:training-log') || '[]'));
  // 训练日志落盘（跨会话合并去重，KEEP 续跑真实累积）
  try {
    mkdirSync('training/logs', { recursive: true });
    let merged = entries;
    try {
      const prev = JSON.parse(readFileSync('training/logs/last-log.json', 'utf8'));
      const seen = new Set(prev.map((e) => e.ts));
      merged = [...prev, ...entries.filter((e) => !seen.has(e.ts))];
    } catch (e) { /* 首次运行 */ }
    writeFileSync('training/logs/last-log.json', JSON.stringify(merged, null, 2));
  } catch (e) { console.log('  [warn] 日志落盘失败:', e.message); }
  if (EVAL) {
    // 纯首绘评测：不做审阅/反馈，因此不断言收敛分，只校验「这一轮确实产生了可用的首绘读数」。
    // 失败轮（超时/未产出）不算断言失败——它是要被记录进指标的真实结果，由 northstar 统一处理。
    console.log(`  首绘评测：${entries.length} 轮`);
    assert.equal(entries.length, ROUNDS, `应完成 ${ROUNDS} 轮，实际 ${entries.length}`);
    for (const e of entries) {
      assert(Number.isFinite(e.scoreBefore), `${e.taskId} 未产生首绘读数`);
      assert.equal(e.reviewRounds, 0, `${e.taskId} 评测模式不应有多模态审阅（实际 ${e.reviewRounds} 轮）`);
      assert.equal(e.fbRounds, 0, `${e.taskId} 评测模式不应有验收反馈（实际 ${e.fbRounds} 轮）`);
      assert(e.mode === (REAL ? 'real' : 'mock'), `${e.taskId} 日志 mode 应为 ${REAL ? 'real' : 'mock'}，实际 ${e.mode}`);
      assert(['ok', 'timeout', 'noproduce'].includes(e.outcome), `${e.taskId} outcome 字段缺失或非法：${e.outcome}`);
    }
    const okRuns = entries.filter((e) => e.outcome === 'ok');
    const scores = okRuns.map((e) => e.scoreBefore).sort((a, b) => a - b);
    const median = scores.length ? (scores.length % 2 ? scores[(scores.length - 1) / 2]
      : Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2)) : 0;
    ok(`首绘评测完成：${okRuns.length}/${entries.length} 轮有效，首绘中位数 ${median}`
      + (okRuns.length < entries.length ? `（${entries.length - okRuns.length} 轮 ${[...new Set(entries.filter((e) => e.outcome !== 'ok').map((e) => e.outcome))].join('/')}）` : ''));
  } else if (CONT) {
    console.log(`  持续训练：${entries.length} 轮`);
    // 弱项优先特性：前 11 轮应覆盖全部 11 个任务（未练过优先）
    const first11 = entries.slice(0, 11).map((e) => e.taskId);
    assert.equal(new Set(first11).size, 11, `前 11 轮应覆盖 11 个不同任务（弱项优先），实际 ${new Set(first11).size}: ${first11.join(',')}`);
    assert(entries.every((e) => e.scoreAfter === 100), '持续训练每轮都应收敛到 100 分');
    ok(`持续训练模式：${entries.length} 轮全部收敛 100 分，前 11 轮覆盖全部任务（弱项优先）`);
  } else if (ALL) {
    console.log(`  全任务回归：${entries.length} 轮`);
    const tasks = new Set(entries.map((e) => e.taskId));
    assert.equal(tasks.size, 25, `应覆盖全部 25 个任务，实际 ${tasks.size}: ${[...tasks].join(',')}`);
    assert(entries.every((e) => e.scoreAfter === 100), `mock 剧本审阅修复后每个任务都应到 100 分：${entries.filter((e) => e.scoreAfter !== 100).map((e) => e.taskId).join(',')}`);
    assert(entries.every((e) => e.delta >= 0), '审阅不应降低分数');
    const improved = entries.filter((e) => e.delta > 0).length;
    assert(improved === 25, `全部 25 个任务的画图都带缺陷且审阅修复提升（实际提升 ${improved} 个）`);
    ok(`全任务训练回归：25/25 任务 审阅修复后均 100 分（${improved} 个任务 Δ>0）`);
  } else if (REAL) {
    const e = entries[entries.length - 1];
    console.log(`  真实 MiniMax 训练条目: ${JSON.stringify(e)}`);
    assert.equal(entries.length, ROUNDS, `应完成 ${ROUNDS} 轮，实际 ${entries.length}`);
    assert(entries.every((x) => Array.isArray(x.fails)), '每轮都应落盘失败明细（fails）');
    if (ROUNDS >= 2) {
      // 记忆注入的前提是此前有失败明细；若前几轮全满分则无薄弱点可记，属正常
      const hadFails = entries.slice(0, -1).some((x) => Array.isArray(x.fails) && x.fails.length);
      if (hadFails) {
        const memInjected = await page.evaluate(() => window.__aiPanel.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('【历史薄弱点')));
        assert(memInjected, '此前有失败时，后续轮次提示应注入历史薄弱点记忆');
      }
      ok(`跨轮薄弱点记忆已注入（${entries.filter((x) => x.fails.length).length}/${ROUNDS} 轮带失败明细）`);
    }
    assert.equal(e.taskId, TASK);
    assert(e.scoreAfter >= 90, `真实模型训练应收敛到 ≥90 分（实际 ${e.scoreAfter}，初绘 ${e.scoreBefore}）`);
    assert(e.scoreAfter >= e.scoreBefore, `训练后分数不应降低（${e.scoreBefore}→${e.scoreAfter}）`);
    assert(e.reviewRounds >= 1, `应至少 1 轮带截图的多模态审阅（实际 ${e.reviewRounds}）`);
    ok(`真实 MiniMax M3 训练验收：画图 ${e.scoreBefore} 分 → 多模态审阅后 ${e.scoreAfter} 分（${e.reviewRounds} 轮审阅 + ${e.fbRounds} 轮反馈）`);
    const checks = await page.evaluate(async (taskId) => {
      const { evaluate } = await import('/training/acceptance.mjs');
      const { taskById } = await import('/training/tasks.mjs');
      const task = taskById(taskId);
      const CAD = window.CAD;
      const input = task.ws === '2d' ? CAD.scene.all()
        : task.ws === 'both' ? { bodies: CAD.app3d?.model?.serialize().bodies || [], entities: CAD.scene.all() }
        : { bodies: CAD.app3d?.model?.serialize().bodies || [] };
      return evaluate(task, input).checks.map((c) => ({ pass: c.pass, detail: c.detail }));
    }, TASK);
    for (const c of checks) console.log(`    ${c.pass ? '✓' : '✗'} ${c.detail}`);
  } else if (FB) {
    const e = entries[entries.length - 1];
    console.log(`  训练条目: ${JSON.stringify(e)}`);
    assert.equal(e.taskId, TASK);
    assert(e.scoreBefore < 100, `初始应带缺陷（实际 ${e.scoreBefore}）`);
    assert.equal(e.scoreAfter, 100, `验收反馈闭环应修复到 100 分（实际 ${e.scoreAfter}）`);
    assert(e.fbRounds >= 1, `应至少 1 轮验收反馈（实际 ${e.fbRounds}）`);
    assert(e.reviewRounds === 0, 'noreview 模式不应有多模态审阅轮');
    ok(`验收反馈闭环：${e.scoreBefore} → ${e.scoreAfter}（${e.fbRounds} 轮反馈修复，无多模态审阅）`);
  } else {
    const e = entries[entries.length - 1];
    console.log(`  训练条目: ${JSON.stringify(e)}`);
    assert.equal(e.taskId, TASK, `应训练 ${TASK} 任务`);
    assert(e.scoreBefore < 100, `mock 剧本初始应带缺陷（实际 ${e.scoreBefore}）`);
    assert(e.scoreAfter > e.scoreBefore, `审阅后分数应提升（${e.scoreBefore}→${e.scoreAfter}）`);
    assert(e.delta > 0, '审阅后分数应提升');
    assert(e.reviewOutcome === '已满意', `审阅结论应已满意（实际 ${e.reviewOutcome}）`);
    assert(e.reviewRounds >= 1, `应至少 1 轮带截图审阅（实际 ${e.reviewRounds}）`);
    ok(`浏览器端到端训练闭环：验收 ${e.scoreBefore} → ${e.scoreAfter}（Δ+${e.delta}，${e.reviewOutcome}，${e.reviewRounds} 轮审阅）`);
  }

  // 验证统计页能读取同一日志并渲染
  const page2 = await browser.newPage();
  await page2.goto(`${BASE}/tests/train-stats.html`, { waitUntil: 'load', timeout: 60000 });
  await page2.waitForFunction(() => document.querySelector('#cards .v')?.textContent !== '0' || true, { timeout: 30000, polling: 1000 });
  const cardText = await page2.evaluate(() => document.getElementById('cards').innerText);
  assert(cardText.includes('总轮数'), '统计页应有指标卡片');
  console.log('  统计页渲染: ' + cardText.replace(/\n/g, ' | ').slice(0, 120));
  ok('统计页在真实浏览器中正常渲染');

  // 截图为证（训练循环页的验收结果）
  await page.screenshot({ path: '/tmp/train-loop-e2e.png' });
  ok('训练循环页截图已保存 /tmp/train-loop-e2e.png');
} finally {
  await browser.close();
}
console.log(`\n全部通过：${n} 项`);
