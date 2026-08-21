/* 探针：验证 App.loadScene 在真实浏览器里是否抛错（window.CAD.scene 只有 getter） */
import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  timeout: 60000,
});
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:8899/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.CAD?.app, { timeout: 30000, polling: 500 });

  const r = await page.evaluate(async () => {
    const { Scene } = await import('/js/scene.js');
    const out = {};
    // 1) 直接调用 loadScene
    try {
      window.CAD.app.loadScene(Scene.load(window.CAD.scene.serialize()));
      out.loadScene = 'OK';
    } catch (e) { out.loadScene = 'THROW: ' + e.message; }
    // 2) 新建图纸（走 loadScene）
    try {
      window.CAD.scene.dirty = false;
      window.CAD.app.newDrawing();
      out.newDrawing = 'OK';
    } catch (e) { out.newDrawing = 'THROW: ' + e.message; }
    // 3) 自动保存恢复路径：写入 autosave 后重载页面前，先确认 CAD.scene 的属性描述符
    const d = Object.getOwnPropertyDescriptor(window.CAD, 'scene');
    out.sceneDescriptor = { hasGet: !!d.get, hasSet: !!d.set };
    return out;
  });
  console.log('  loadScene():   ', r.loadScene);
  console.log('  newDrawing():  ', r.newDrawing);
  console.log('  CAD.scene 描述符:', JSON.stringify(r.sceneDescriptor));

  // 4) 自动保存恢复：写入一张可识别的图纸 → 重载 → 看是否恢复
  await page.evaluate(async () => {
    const { Scene } = await import('/js/scene.js');
    const s = new Scene();
    s.addEntity({ type: 'circle', cx: 12345, cy: 0, r: 7, layer: '0' });
    localStorage.setItem('xbcad:autosave', JSON.stringify(s.serialize()));
  });
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.CAD?.app, { timeout: 30000, polling: 500 });
  await new Promise((r) => setTimeout(r, 1500));
  const restored = await page.evaluate(() => ({
    count: window.CAD.scene.count(),
    hasMarker: window.CAD.scene.all().some((e) => e.type === 'circle' && e.cx === 12345),
  }));
  console.log('  重载后自动保存恢复:', restored.hasMarker ? '✓ 已恢复标记图纸' : `✗ 未恢复（实体数 ${restored.count}，多半是回落到示例图纸）`);
} finally {
  await browser.close();
}
