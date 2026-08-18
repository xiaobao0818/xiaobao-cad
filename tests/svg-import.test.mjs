/* 小宝CAD SVG 导入回归测试（node tests/svg-import.test.mjs）
 * 内置极简 XML→DOM-lite 解析器（Node 无 DOMParser），覆盖 M/L/H/V/C/A/Z/隐式重复/相对命令/transform/样式 */
import { strict as assert } from 'node:assert';
import { svgToEntities } from '../js/io.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

class FakeEl {
  constructor(tag, parent) { this.tagName = tag; this.parent = parent; this.children = []; this._attrs = {}; this._text = ''; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  get textContent() { return this._text; }
}
function fakeDOM(html) {
  const root = new FakeEl('svg', null);
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*?)(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(html))) {
    const text = html.slice(last, m.index);
    if (stack.length && text.trim()) stack[stack.length - 1]._text += text;
    last = re.lastIndex;
    const closing = m[1] === '/', tag = m[2].toLowerCase(), selfClose = m[4] === '/';
    if (closing) {
      const idx = stack.map((e) => e.tagName).lastIndexOf(tag);
      if (idx > 0) stack.length = idx;
    } else {
      const el = new FakeEl(tag, stack[stack.length - 1]);
      for (const am of m[3].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) el._attrs[am[1]] = am[2];
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
    }
  }
  return root;
}
const imp = (svg) => svgToEntities(svg, { documentElement: fakeDOM(svg) });

{
  const es = imp('<svg><path d="M0,0 L10,0"/></svg>');
  assert.equal(es.length, 1, 'M/L 路径应 1 个实体');
  assert(es[0].type === 'polyline' && es[0].points.length === 2 && es[0].points[1].x === 10 && es[0].points[1].y === 0);
  ok('SVG path M/L 导入');
}
{
  const es = imp('<svg><g transform="translate(0 80) scale(1 -1)"><line x1="0" y1="0" x2="10" y2="0" stroke="#ff0000" stroke-width="2"/></g></svg>');
  assert.equal(es.length, 1);
  const l = es[0];
  assert(Math.abs(l.y1 - 80) < 1e-9 && Math.abs(l.y2 - 80) < 1e-9, `翻转矩阵应把线放在 y=80，实际 y1=${l.y1}`);
  assert.equal(l.color, '#ff0000');
  assert.equal(l.lw, 2);
  ok('SVG 根翻转 transform + stroke/stroke-width 样式');
}
{
  const es = imp('<svg><path d="M 0 0 A 5 5 0 0 1 10 0"/></svg>');
  assert.equal(es.length, 1);
  const a = es[0];
  assert(a.type === 'arc' && Math.abs(a.cx - 5) < 1e-6 && Math.abs(a.cy) < 1e-6 && Math.abs(a.r - 5) < 1e-6 && a.ccw === true, `A 圆弧应为中心(5,0) r=5 CCW，实际 ${JSON.stringify(a)}`);
  ok('SVG path A 圆弧导入（保持真圆弧）');
}
{
  const es = imp('<svg><path d="M 0 0 C 0 10 10 10 10 0"/></svg>');
  assert.equal(es.length, 1);
  const p = es[0];
  assert(p.type === 'polyline' && p.points.length === 17 && p.points[0].x === 0 && p.points[16].x === 10 && p.points[16].y === 0);
  ok('SVG path C 三次贝塞尔采样');
}
{
  const es = imp('<svg><path d="M0 0 H10 V10 Z"/></svg>');
  assert.equal(es.length, 1);
  const p = es[0];
  assert(p.type === 'polyline' && p.closed === true && p.points.length === 3 && p.points[2].y === 10);
  ok('SVG path H/V/Z 闭合');
}
{
  const es = imp('<svg><g transform="rotate(90 5 5)"><line x1="5" y1="5" x2="15" y2="5"/></g></svg>');
  const l = es[0];
  assert(Math.abs(l.x1 - 5) < 1e-6 && Math.abs(l.y1 - 5) < 1e-6 && Math.abs(l.x2 - 5) < 1e-6 && Math.abs(l.y2 - 15) < 1e-6, `rotate(90 5 5) 后端点应 (5,15)，实际 (${l.x2},${l.y2})`);
  ok('SVG rotate 绕点变换');
}
{
  const es = imp('<svg><path d="m0 0 l10 0 10 10"/></svg>');
  const p = es[0];
  assert(p.points.length === 3 && p.points[2].x === 20 && p.points[2].y === 10, `相对+隐式重复应到 (20,10)，实际 (${p.points[2]?.x},${p.points[2]?.y})`);
  ok('SVG 相对命令 + 隐式重复');
}
{
  const es = imp('<svg><g transform="scale(2)"><circle cx="5" cy="5" r="2"/></g></svg>');
  const c = es[0];
  assert(c.type === 'circle' && Math.abs(c.cx - 10) < 1e-6 && Math.abs(c.cy - 10) < 1e-6 && Math.abs(c.r - 4) < 1e-6, `scale(2) 圆应 c(10,10) r=4，实际 ${JSON.stringify(c)}`);
  ok('SVG scale 变换圆');
}
{
  // 非等比缩放圆 → 椭圆
  const es = imp('<svg><g transform="scale(2 1)"><circle cx="5" cy="5" r="2"/></g></svg>');
  const e = es[0];
  assert(e.type === 'ellipse' && Math.abs(e.rx - 4) < 1e-6 && Math.abs(e.ry - 2) < 1e-6, `非等比圆应变椭圆 rx=4 ry=2，实际 ${JSON.stringify(e)}`);
  ok('SVG 非等比缩放圆→椭圆');
}

console.log(`全部通过：${n} 项`);
