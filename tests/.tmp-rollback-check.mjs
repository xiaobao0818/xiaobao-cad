/* 验证「训练质量回退保护」修复：强制走回滚分支，确认快照真的被还原
 * 判定：回滚后分数 == 审阅前分数（状态完整回到快照），且 note 为「已回滚到审阅前快照」而非「回滚失败」 */
import puppeteer from 'puppeteer-core';
import { strict as assert } from 'node:assert';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:8899';
const TASK = process.env.TASK || 'flange2d';
const SKIP3D = TASK === 'flange2d' || TASK === 'bracket2d';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  timeout: 60000,
  protocolTimeout: 1800000,
});
try {
  const page = await browser.newPage();
  const pageLogs = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('[训练]') || m.type() === 'error') { pageLogs.push(t); console.log('  [页]', t.slice(0, 220)); } });
  page.on('pageerror', (e) => { pageLogs.push('PAGEERROR ' + e.message); console.log('  [pageerror]', e.message); });

  await page.goto(`${BASE}/tests/.tmp-rollback-check.html?mock=1${SKIP3D ? '&skip3d=1' : ''}`, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => localStorage.removeItem('xbcad:training-log'));
  await page.waitForFunction(() => !!window.__aiPanel, { timeout: 60000, polling: 1000 });
  await page.select('#taskSel', TASK);
  await page.$eval('#rounds', (el) => { el.value = '1'; });
  await page.click('#btnStart');
  await page.waitForFunction(() => {
    const log = JSON.parse(localStorage.getItem('xbcad:training-log') || '[]');
    return log.length >= 1 && document.getElementById('tProg').textContent === '训练完成';
  }, { timeout: 1500000, polling: 1000 });

  const e = (await page.evaluate(() => JSON.parse(localStorage.getItem('xbcad:training-log') || '[]'))).pop();
  console.log('\n  训练条目:', JSON.stringify(e));

  assert(!pageLogs.some((l) => l.includes('is not defined')), '不应出现 ReferenceError（旧代码的 snapBefore/Scene 未定义）');
  assert(!/回滚失败/.test(e.note), `回滚不应失败，实际 note: ${e.note}`);
  assert(/已回滚到审阅前快照/.test(e.note), `应记录回滚成功，实际 note: ${e.note}`);
  assert.equal(e.scoreAfter, e.scoreBefore,
    `回滚后应完整还原到审阅前状态（分数应等于审阅前 ${e.scoreBefore}，实际 ${e.scoreAfter}）`);
  console.log(`\n  ✓ [${TASK}] 强制回滚：审阅把分数改到 ${/（(\d+)→(\d+)）/.exec(e.note)?.[2] ?? '?'}，回滚后完整还原到 ${e.scoreAfter} 分（==审阅前 ${e.scoreBefore}）`);
  console.log(`  ✓ [${TASK}] note: ${e.note}`);
} finally {
  await browser.close();
}
