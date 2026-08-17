/* ============================================================
 * 小宝CAD 文件读写 —— 打开/保存/导出（DXF/JSON/SVG/PNG）
 * 以及供 AI 使用的图纸摘要生成、示例图纸
 * ============================================================ */
import { HANDLERS, newEntity, make, entityBBox } from './entities.js';
import { Scene } from './scene.js';
import { download, fmt, colorToCSS, escapeHtml, bboxUnion, arcFromBulge, D2R, R2D, normAngle, TAU } from './util.js';

/* ---------------- 文件读取 ---------------- */
export function fileToText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsText(file);
  });
}
export function fileExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export async function openFile(app, file) {
  const ext = fileExt(file.name);
  if (ext === 'dwg') {
    throw new Error(
      'DWG 是 Autodesk 专有格式，浏览器无法直接解析。\n' +
      '建议先用 ODA File Converter 或 LibreDWG（dwg2dxf 命令）转换为 DXF 后打开。\n' +
      '本软件原生支持：DXF / 小宝CAD(JSON) / SVG。'
    );
  }
  if (ext === 'dxf') {
    const CAD = window.CAD;
    if (!CAD?.dxf) throw new Error('DXF 模块未就绪，请刷新页面重试');
    const text = await fileToText(file);
    const data = CAD.dxf.parseDXF(text);
    applyDXFData(app.scene, data);
    return { type: 'dxf', count: app.scene.count() };
  }
  if (ext === 'json' || ext === 'xbcad') {
    const text = await fileToText(file);
    const json = JSON.parse(text);
    const s = Scene.load(json);
    app.loadScene(s);
    return { type: 'json', count: app.scene.count() };
  }
  if (ext === 'svg') {
    const text = await fileToText(file);
    const entities = svgToEntities(text);
    app.scene.singleOp('导入 SVG', () => app.scene.addEntities(entities));
    return { type: 'svg', count: entities.length };
  }
  throw new Error(`不支持的文件格式: .${ext}`);
}

/** 将 DXF 解析结果写入场景（重建图层/块/实体） */
export function applyDXFData(scene, data) {
  scene.layers = new Map();
  for (const l of data.layers || [{ name: '0', color: '#ffffff', on: true, locked: false, ltype: 'CONTINUOUS' }]) {
    scene.layers.set(l.name, { name: l.name, color: l.color || '#ffffff', on: l.on !== false, locked: !!l.locked, ltype: l.ltype || 'CONTINUOUS' });
  }
  if (!scene.layers.has('0')) scene.layers.set('0', { name: '0', color: '#ffffff', on: true, locked: false, ltype: 'CONTINUOUS' });
  if (!scene.layers.has(data.currentLayer)) scene.currentLayer = '0';
  else scene.currentLayer = data.currentLayer;
  scene.blocks = new Map((data.blocks || []).map((b) => [b.name, { name: b.name, baseX: b.baseX || 0, baseY: b.baseY || 0, entities: new Map((b.entities || []).map((e) => [e.id, e])) }]));
  scene.entities = new Map();
  scene.selection.clear();
  for (const e of data.entities || []) {
    if (!HANDLERS[e.type]) continue;
    if (e.layer == null) e.layer = '0';
    scene.ensureLayer(e.layer);
    scene.entities.set(e.id || `e${Math.random().toString(36).slice(2)}`, e);
  }
  scene.clearUndo();
  scene.dirty = false;
  scene._changeCount = 0;
  scene.emit('layers');
  scene.emit('change');
  scene.emit('selection');
}

/* ---------------- 摘要（供 AI / 日志） ---------------- */
function describeEntity(e) {
  const f = (v) => fmt(v, 2);
  switch (e.type) {
    case 'line': return `(${f(e.x1)},${f(e.y1)})-(${f(e.x2)},${f(e.y2)})`;
    case 'circle': return `圆心(${f(e.cx)},${f(e.cy)}) r=${f(e.r)}`;
    case 'arc': return `圆心(${f(e.cx)},${f(e.cy)}) r=${f(e.r)} 起${f(normAngle(e.startAngle) * R2D)}°~终${f(normAngle(e.endAngle) * R2D)}°`;
    case 'ellipse': return `中心(${f(e.cx)},${f(e.cy)}) ${f(e.rx)}×${f(e.ry)}`;
    case 'polyline': {
      const n = e.points.length;
      if (!n) return '空';
      return `${n}点 (${f(e.points[0].x)},${f(e.points[0].y)})…(${f(e.points[n - 1].x)},${f(e.points[n - 1].y)})${e.closed ? ' 闭合' : ''}`;
    }
    case 'text': return `"${String(e.text).slice(0, 24)}" @(${f(e.x)},${f(e.y)}) 高${f(e.height)}`;
    case 'point': return `(${f(e.x)},${f(e.y)})`;
    case 'insert': return `块[${e.block}] @(${f(e.x)},${f(e.y)})`;
    case 'dimension': {
      if (e.subtype === 'linear') return `线性 (${f(e.x1)},${f(e.y1)})-(${f(e.x2)},${f(e.y2)})`;
      if (e.subtype === 'radial' || e.subtype === 'diametric') return `${e.subtype === 'radial' ? '半径' : '直径'} 圆心(${f(e.cx)},${f(e.cy)})`;
      if (e.subtype === 'angular') return `角度 顶点(${f(e.cx)},${f(e.cy)})`;
      return '标注';
    }
    case 'hatch': return '填充';
    default: return '';
  }
}
export function buildDataSummary(data, { maxEntities = 60 } = {}) {
  const entities = data.entities || [];
  const counts = {};
  let bb = null;
  for (const e of entities) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    bb = bboxUnion(bb, entityBBox(e));
  }
  const layers = (data.layers || []).map((l) => `${l.name}(${typeof l.color === 'number' ? 'ACI' + l.color : l.color || '默认'}${l.on === false ? '/关闭' : ''}${l.locked ? '/锁定' : ''})`).join(', ') || '无';
  const lines = [
    `图纸摘要（单位: ${data.units || 'mm'}）`,
    `图层: ${layers}`,
    `实体总数: ${entities.length}` + (Object.keys(counts).length ? `（${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}）` : ''),
  ];
  if (bb) lines.push(`范围: X ${fmt(bb[0], 1)} ~ ${fmt(bb[2], 1)}, Y ${fmt(bb[1], 1)} ~ ${fmt(bb[3], 1)}`);
  lines.push(`实体明细（最多 ${maxEntities} 条）:`);
  let i = 0;
  for (const e of entities) {
    if (i++ >= maxEntities) { lines.push('…（其余省略，可通过查询工具获取）'); break; }
    lines.push(`  [${e.id}] ${e.type} 层=${e.layer || '0'} ${describeEntity(e)}`);
  }
  return lines.join('\n');
}
export function buildSceneSummary(scene, opts) {
  return buildDataSummary({ layers: [...scene.layers.values()], entities: scene.all(), units: scene.units }, opts);
}
export function buildDXFSummary(text) {
  if (!window.CAD?.dxf) throw new Error('DXF 模块未就绪');
  const data = window.CAD.dxf.parseDXF(text);
  return buildDataSummary(data);
}

/* ---------------- 导出 ---------------- */
export function saveNative(scene, name = '图纸') {
  const json = JSON.stringify(scene.serialize(), null, 1);
  download(`${name}.xbcad.json`, json, 'application/json');
}
export async function exportDXF(scene, name = '图纸') {
  const CAD = window.CAD;
  if (!CAD?.dxf) throw new Error('DXF 模块未就绪');
  const text = CAD.dxf.writeDXF(scene);
  download(`${name}.dxf`, text, 'application/dxf');
}
export function exportPNG(viewport, name = '图纸') {
  const c = viewport.toPNG(true);
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });
}
export function exportSVG(scene, name = '图纸') {
  const bb = scene.extents() || [0, 0, 200, 120];
  const W = bb[2] - bb[0] || 200, H = bb[3] - bb[1] || 120;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(bb[0], 3)} ${fmt(bb[1], 3)} ${fmt(W, 3)} ${fmt(H, 3)}">`);
  parts.push(`<g transform="translate(0 ${fmt(bb[1] + bb[3], 3)}) scale(1 -1)">`);
  const layerCol = (e) => {
    const l = scene.layers.get(e.layer);
    return colorToCSS(e.color, l?.color || '#ffffff');
  };
  const dashOf = (e) => {
    const l = scene.layers.get(e.layer);
    const t = e.ltype || l?.ltype || 'CONTINUOUS';
    const map = { DASHED: '10 5', DASHED2: '14 7', HIDDEN: '8 4', HIDDEN2: '12 6', CENTER: '18 4 3 4', CENTER2: '14 3 2 3', DASHDOT: '12 4 2 4', DOT: '2 4', PHANTOM: '16 4 2 4 2 4' };
    return map[t] ? ` stroke-dasharray="${map[t]}"` : '';
  };
  const emit = (e) => {
    const col = layerCol(e);
    const dash = dashOf(e);
    const w = e.lw && e.lw > 0 ? e.lw : 1;
    if (e.type === 'line') parts.push(`<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${col}" stroke-width="${w}"${dash}/>`);
    else if (e.type === 'circle') parts.push(`<circle cx="${e.cx}" cy="${e.cy}" r="${e.r}" fill="none" stroke="${col}" stroke-width="${w}"${dash}/>`);
    else if (e.type === 'arc') {
      const x1 = e.cx + e.r * Math.cos(e.startAngle), y1 = e.cy + e.r * Math.sin(e.startAngle);
      const x2 = e.cx + e.r * Math.cos(e.endAngle), y2 = e.cy + e.r * Math.sin(e.endAngle);
      const sweep = normAngle(e.endAngle - e.startAngle);
      const large = sweep > Math.PI ? 1 : 0;
      parts.push(`<path d="M ${x1} ${y1} A ${e.r} ${e.r} 0 ${large} 1 ${x2} ${y2}" fill="none" stroke="${col}" stroke-width="${w}"${dash}/>`);
    }
    else if (e.type === 'ellipse') parts.push(`<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" transform="rotate(${fmt((e.rot || 0) * R2D, 4)} ${e.cx} ${e.cy})" fill="none" stroke="${col}" stroke-width="${w}"${dash}/>`);
    else if (e.type === 'polyline' && e.points.length) {
      let d = `M ${e.points[0].x} ${e.points[0].y}`;
      const n = e.closed ? e.points.length : e.points.length - 1;
      for (let i = 0; i < n; i++) {
        const p1 = e.points[i], p2 = e.points[(i + 1) % e.points.length];
        const b = p1.bulge || 0;
        if (Math.abs(b) > 1e-6) {
          const arc = arcFromBulge(p1, p2, b);
          if (arc) {
            const sweep = normAngle(arc.endAngle - arc.startAngle);
            d += ` A ${arc.r} ${arc.r} 0 ${sweep > Math.PI ? 1 : 0} ${arc.ccw ? 1 : 0} ${p2.x} ${p2.y}`;
          } else d += ` L ${p2.x} ${p2.y}`;
        } else d += ` L ${p2.x} ${p2.y}`;
      }
      if (e.closed) d += ' Z';
      parts.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}"${dash}/>`);
    }
    else if (e.type === 'text') {
      const anchor = e.halign === 'center' ? 'middle' : e.halign === 'right' ? 'end' : 'start';
      parts.push(`<text x="${e.x}" y="${e.y}" font-size="${e.height}" fill="${col}" text-anchor="${anchor}" transform="translate(${e.x} ${e.y}) scale(1 -1) rotate(${fmt(-(e.rotation || 0) * R2D, 4)}) translate(${-e.x} ${-e.y})">${escapeHtml(e.text || '')}</text>`);
    }
    else if (e.type === 'insert') {
      const blk = scene.blocks.get(e.block);
      if (!blk) return;
      const c = Math.cos(e.rotation || 0), s = Math.sin(e.rotation || 0);
      const sx = e.scaleX ?? 1, sy = e.scaleY ?? 1;
      const a = c * sx, bb2 = s * sx, cc = -s * sy, dd = c * sy;
      const ee = e.x - a * blk.baseX - cc * blk.baseY, ff = e.y - bb2 * blk.baseX - dd * blk.baseY;
      parts.push(`<g transform="matrix(${a} ${bb2} ${cc} ${dd} ${ee} ${ff})">`);
      for (const be of blk.entities.values()) {
        if (be.layer === '0') { const t = { ...be, layer: e.layer }; emit(t); } else emit(be);
      }
      parts.push('</g>');
    }
    else if (e.type === 'hatch' && e.boundary) {
      const b = e.boundary;
      const fill = colorToCSS(e.color, col, 0.25);
      if (b.kind === 'circle') parts.push(`<circle cx="${b.cx}" cy="${b.cy}" r="${b.r}" fill="${fill}" stroke="${col}" stroke-width="1"/>`);
      else if (b.kind === 'ellipse') parts.push(`<ellipse cx="${b.cx}" cy="${b.cy}" rx="${b.rx}" ry="${b.ry}" fill="${fill}" stroke="${col}"/>`);
      else if (b.points?.length) {
        const d = b.points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ') + ' Z';
        parts.push(`<path d="${d}" fill="${fill}" stroke="${col}" stroke-width="1"/>`);
      }
    }
  };
  for (const e of scene.entities.values()) emit(e);
  parts.push('</g></svg>');
  download(`${name}.svg`, parts.join('\n'), 'image/svg+xml');
}

/* ---------------- SVG 导入（基础图元） ---------------- */
export function svgToEntities(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const out = [];
  const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  const getM = (el) => {
    const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const t = el.getAttribute('transform');
    if (t) {
      const tr = t.match(/translate\(([^)]+)\)/);
      if (tr) { const [x, y] = tr[1].split(/[\s,]+/).map((v) => num(v)); m.e = x; m.f = y; }
    }
    return m;
  };
  const X = (p, m) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
  const walk = (el, mIn) => {
    for (const child of el.children) {
      const m = getM(child);
      const mm = { a: mIn.a * m.a + mIn.c * m.b, b: mIn.b * m.a + mIn.d * m.b, c: mIn.a * m.c + mIn.c * m.d, d: mIn.b * m.c + mIn.d * m.d, e: mIn.a * m.e + mIn.c * m.f + mIn.e, f: mIn.b * m.e + mIn.d * m.f + mIn.f };
      const tag = child.tagName.toLowerCase();
      if (tag === 'g') walk(child, mm);
      else if (tag === 'line') {
        out.push(make.line(X({ x: num(child.getAttribute('x1')), y: num(child.getAttribute('y1')) }, mm), X({ x: num(child.getAttribute('x2')), y: num(child.getAttribute('y2')) }, mm)));
      } else if (tag === 'rect') {
        const x = num(child.getAttribute('x')), y = num(child.getAttribute('y'));
        const w = num(child.getAttribute('width')), h = num(child.getAttribute('height'));
        const c1 = X({ x, y }, mm), c2 = X({ x: x + w, y: y + h }, mm);
        out.push(make.rectangle(c1, c2));
      } else if (tag === 'circle') {
        out.push(make.circle(X({ x: num(child.getAttribute('cx')), y: num(child.getAttribute('cy')) }, mm), num(child.getAttribute('r'))));
      } else if (tag === 'ellipse') {
        const c = X({ x: num(child.getAttribute('cx')), y: num(child.getAttribute('cy')) }, mm);
        out.push(make.ellipse(c, num(child.getAttribute('rx')), num(child.getAttribute('ry'))));
      } else if (tag === 'polyline' || tag === 'polygon') {
        const pts = (child.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
        const points = [];
        for (let i = 0; i + 1 < pts.length; i += 2) points.push(X({ x: pts[i], y: pts[i + 1] }, mm));
        if (points.length >= 2) out.push(make.polyline(points, { closed: tag === 'polygon' }));
      } else if (tag === 'path') {
        const d = (child.getAttribute('d') || '').trim();
        const m = d.match(/^M\s*([\d.+-]+)[,\s]+([\d.+-]+)\s*(L[\d.,\s+-]*)?/i);
        if (m) {
          const points = [X({ x: num(m[1]), y: num(m[2]) }, mm)];
          const rest = (m[3] || '').match(/[\d.+-]+[,\s]+[\d.+-]+/g) || [];
          for (let i = 0; i + 1 < rest.length; i += 2) {
            const [x, y] = rest[i].split(/[,\s]+/).map(Number);
            points.push(X({ x, y }, mm));
          }
          if (points.length >= 2) out.push(make.polyline(points, { closed: /z/i.test(d) }));
        }
      } else if (tag === 'text') {
        const p = X({ x: num(child.getAttribute('x')), y: num(child.getAttribute('y')) }, mm);
        const fs = num(child.getAttribute('font-size'), 16);
        out.push(make.text(p, child.textContent || '', fs));
      }
    }
  };
  walk(doc.documentElement, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  return out;
}

/* ---------------- 示例图纸 ---------------- */
export function makeDemoScene(scene) {
  scene.layers = new Map();
  scene.ensureLayer('0', { color: '#ffffff' });
  scene.ensureLayer('轮廓', { color: '#e8e8e8' });
  scene.ensureLayer('中心线', { color: '#e05656', ltype: 'CENTER' });
  scene.ensureLayer('标注', { color: '#5db3ff' });
  scene.ensureLayer('文字', { color: '#7ee08a' });
  scene.currentLayer = '轮廓';
  scene.entities = new Map();
  scene.selection.clear();
  const L = '轮廓', C = '中心线', D = '标注', T = '文字';
  const P = (x, y) => ({ x, y });
  // 底板
  scene.addEntity(make.rectangle(P(0, 0), P(120, 80), { layer: L }));
  // 四个安装孔 + 中心线
  for (const [hx, hy] of [[15, 15], [105, 15], [15, 65], [105, 65]]) {
    scene.addEntity(make.circle(P(hx, hy), 6, { layer: L }));
    scene.addEntity(make.line(P(hx - 12, hy), P(hx + 12, hy), { layer: C }));
    scene.addEntity(make.line(P(hx, hy - 12), P(hx, hy + 12), { layer: C }));
  }
  // 中部腰形槽：两端圆 + 相切直线
  scene.addEntity(make.circle(P(30, 40), 6, { layer: L }));
  scene.addEntity(make.circle(P(90, 40), 6, { layer: L }));
  scene.addEntity(make.line(P(30, 46), P(90, 46), { layer: L }));
  scene.addEntity(make.line(P(30, 34), P(90, 34), { layer: L }));
  scene.addEntity(make.line(P(21, 40), P(99, 40), { layer: C }));
  // 顶部装饰弧
  scene.addEntity(make.arc(P(60, 80), 20, Math.PI, TAU, { layer: L }));
  // 标注
  scene.addEntity(newEntity('dimension', { subtype: 'linear', layer: D, x1: 0, y1: 0, x2: 120, y2: 0, x3: 60, y3: -14, angle: 0 }));
  scene.addEntity(newEntity('dimension', { subtype: 'linear', layer: D, x1: 120, y1: 0, x2: 120, y2: 80, x3: 136, y3: 40, angle: Math.PI / 2 }));
  scene.addEntity(newEntity('dimension', { subtype: 'radial', layer: D, cx: 15, cy: 15, px: 21, py: 15, tx: -8, ty: 32 }));
  // 文字
  scene.addEntity(make.text(P(60, 95), '小宝CAD 示例图纸', 7, 0, { layer: T, halign: 'center', valign: 'bottom' }));
  scene.addEntity(make.text(P(60, -26), '单位: mm  比例 1:1', 3.5, 0, { layer: T, halign: 'center', valign: 'middle' }));
  scene.clearUndo();
  scene.dirty = false;
  scene._changeCount = 0;
  scene.emit('layers');
  scene.emit('change');
}
