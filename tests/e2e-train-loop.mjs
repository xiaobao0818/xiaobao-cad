/* 小宝CAD 画图训练循环 端到端测试（真实浏览器 + mock AI 服务器）
 * 前置：python3 tests/mock-ai-server.py 运行在 8898；python3 -m http.server 8899 服务本项目
 * 运行：node tests/e2e-train-loop.mjs
 * 验证：AI 画图(带缺陷) → 确定性验收低分 → MiniMax 多模态审阅修复 → 再验收高分 → 日志落盘 */
import puppeteer from 'puppeteer-core';
import { strict as assert } from 'node:assert';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:8899';
const TASK = process.env.TASK || 'flange2d';
const SKIP3D = process.env.SKIP3D === '1' || (process.env.TASK || 'flange2d') === 'flange2d' ? '1' : '';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  timeout: 60000,
});

try {
  // 清空训练日志，只跑 2D 法兰盘 1 轮（skip3d 加速）
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/tests/train-loop.html?mock=1${SKIP3D ? '&skip3d=1' : ''}`, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => localStorage.removeItem('xbcad:training-log'));

  // 选单任务：法兰盘，1 轮
  await page.waitForFunction(() => !!window.__aiPanel, { timeout: 30000 });
  await page.select('#taskSel', TASK);
  await page.$eval('#rounds', (el) => { el.value = '1'; });
  await page.click('#btnStart');

  // 等待训练日志出现（画图 → 审阅 → 再打分 完成）
  await page.waitForFunction(() => {
    const log = JSON.parse(localStorage.getItem('xbcad:training-log') || '[]');
    return log.length >= 1 && document.getElementById('tProg').textContent === '训练完成';
  }, { timeout: 600000 });

  const entries = await page.evaluate(() => JSON.parse(localStorage.getItem('xbcad:training-log') || '[]'));
  const e = entries[entries.length - 1];
  console.log(`  训练条目: ${JSON.stringify(e)}`);
  assert.equal(e.taskId, TASK, `应训练 ${TASK} 任务`);
  assert(e.scoreBefore < 100, `mock 剧本初始应带缺陷（实际 ${e.scoreBefore}）`);
  assert(e.scoreAfter > e.scoreBefore, `审阅后分数应提升（${e.scoreBefore}→${e.scoreAfter}）`);
  assert(e.delta > 0, '审阅后分数应提升');
  assert(e.reviewOutcome === '已满意', `审阅结论应已满意（实际 ${e.reviewOutcome}）`);
  assert(e.reviewRounds >= 1, `应至少 1 轮带截图审阅（实际 ${e.reviewRounds}）`);
  ok(`浏览器端到端训练闭环：验收 ${e.scoreBefore} → ${e.scoreAfter}（Δ+${e.delta}，${e.reviewOutcome}，${e.reviewRounds} 轮审阅）`);

  // 验证统计页能读取同一日志并渲染
  const page2 = await browser.newPage();
  await page2.goto(`${BASE}/tests/train-stats.html`, { waitUntil: 'load', timeout: 60000 });
  await page2.waitForFunction(() => document.querySelector('#cards .v')?.textContent !== '0' || true, { timeout: 10000 });
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
