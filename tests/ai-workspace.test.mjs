/* AI 工作区隔离测试：2D 区只允许 2D 工具，3D 区只允许 3D 工具 */
import { strict as assert } from 'node:assert';
import AIChatPanel from '../js/ai.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

function makePanel(workspace, ai3d) {
  const panel = Object.create(AIChatPanel.prototype);
  panel.CAD = {
    workspace,
    ai3d: ai3d || null,
    scene: null,
    viewport: { requestRender: () => {} },
    commander: { execAndEnd: () => {} },
  };
  panel._extraTools = [];
  panel._extraPrompt = '';
  panel.messages = [{ role: 'system', content: '' }];
  panel._registerTools();
  // 模拟 3D 工具注册
  if (ai3d) {
    panel._extraTools = [
      { type: 'function', function: { name: 'create_primitive_3d', parameters: {} } },
      { type: 'function', function: { name: 'boolean_3d', parameters: {} } },
      { type: 'function', function: { name: 'list_3d', parameters: {} } },
    ];
  }
  return panel;
}

console.log('== 工作区工具隔离 ==');
{
  const p2 = makePanel('2d', null);
  assert(p2._allTools().length > 10); // 全部 2D 工具
  assert(p2._allTools().every((t) => !/3d/.test(t.function.name)));
  ok('2D 工作区：只暴露 2D 工具');
  assert.throws(() => p2._callTool('create_primitive_3d', {}), /不支持工具/);
  ok('2D 工作区：调用 3D 工具被拒绝');
  assert(p2._systemContent().includes('2D 制图'));
  ok('2D 工作区：系统提示标明 2D 制图');
}
{
  const p3 = makePanel('3d', { create_primitive_3d: () => 'ok' });
  assert.equal(p3._allTools().length, 3); // 仅 3D 工具
  assert(p3._allTools().every((t) => /3d/.test(t.function.name)));
  ok('3D 工作区：只暴露 3D 工具');
  assert.throws(() => p3._callTool('draw_entities', {}), /不支持工具/);
  ok('3D 工作区：调用 2D 工具被拒绝');
  assert.equal(p3._callTool('create_primitive_3d', {}), 'ok');
  ok('3D 工作区：3D 工具正常执行');
  assert(p3._systemContent().includes('3D 实体建模'));
  ok('3D 工作区：系统提示标明 3D 建模');
}
{
  // 3D 工作区但内核未就绪（无 3D 工具注册）
  const p4 = makePanel('3d', null);
  assert.equal(p4._allTools().length, 0);
  assert(p4._systemContent().includes('三维内核尚未就绪'));
  ok('3D 工作区未就绪：明确提示等待内核加载');
}
{
  // 切换工作区后动态生效
  const p5 = makePanel('2d', { create_primitive_3d: () => 'ok' });
  p5._extraTools = [{ type: 'function', function: { name: 'create_primitive_3d', parameters: {} } }];
  p5.CAD.workspace = '3d';
  assert.equal(p5._allTools().length, 1);
  p5.CAD.workspace = '2d';
  assert(p5._allTools().length > 10);
  ok('工作区切换：工具集动态跟随');
}

console.log('== MiniMax 设置迁移 ==');
{
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  const panel = Object.create(AIChatPanel.prototype);
  // 旧 DeepSeek 默认 + 视觉 Key → 迁移并提升 Key
  localStorage._d['xbcad:ai-settings'] = JSON.stringify({ base: 'https://api.deepseek.com', model: 'deepseek-chat', key: 'sk-old', visionKey: 'mm-key-123' });
  const s1 = panel._loadSettings();
  assert.equal(s1.base, 'https://api.minimaxi.com');
  assert.equal(s1.model, 'MiniMax-M3');
  assert.equal(s1.key, 'mm-key-123');
  assert.equal(s1.visionKey, '');
  assert.equal(s1.settingsVersion, 2);
  ok('旧 DeepSeek 配置自动迁移到 MiniMax，视觉 Key 提升为主 Key');
  // 自定义接口不被迁移
  localStorage._d['xbcad:ai-settings'] = JSON.stringify({ base: 'http://localhost:8898', model: 'mock', key: 'k' });
  const s2 = panel._loadSettings();
  assert.equal(s2.base, 'http://localhost:8898');
  assert.equal(s2.model, 'mock');
  ok('自定义接口配置不受迁移影响');
}

console.log(`\n全部通过：${n} 项`);
