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
    // 浏览器内直接解析 DWG（LibreDWG WASM）
    try {
      const { parseDWG } = await import('./dwg.js');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const data = await parseDWG(bytes);
      applyDXFData(app.scene, data);
      return { type: 'dwg', count: app.scene.count(), note: 'DWG 已解析（标注/样条/填充等复杂对象已跳过）' };
    } catch (e) {
      throw new Error(
        'DWG 解析失败：' + (e && e.message ? e.message : e) + '\n' +
        '可改用 ODA File Converter 或 LibreDWG 转换为 DXF 后打开。'
      );
    }
  }
  if (ext === 'dxf') {
    const CAD = window.CAD;
    if (!CAD?.dxf) throw new Error('DXF 模块未就绪，请刷新页面重试');
    const buf = await file.arrayBuffer();
    let text;
    try {
      // 按 $DWGCODEPAGE 选择解码（ANSI_936=GBK 中文 / ANSI_932=Shift-JIS 日文等老图纸）
      const head = new TextDecoder('latin1').decode(buf.slice(0, 16384));
      const cp = head.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([A-Za-z0-9_]+)/i);
      const page = cp ? String(cp[1]).toUpperCase() : '';
      if (page.includes('932')) text = new TextDecoder('shift_jis').decode(buf);
      else if (page.includes('936')) text = new TextDecoder('gbk').decode(buf);
      else if (page.includes('950')) text = new TextDecoder('big5').decode(buf);
      else text = new TextDecoder('utf-8').decode(buf);
    } catch (e) {
      text = await fileToText(file);
    }
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
  scene.units = data.units || 'mm';
  scene.emit('layers');
  scene.emit('change');
  scene.emit('selection');
  scene.emit('blocks');
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
      const pts = e.points || [];
      const n = pts.length;
      if (!n) return '空';
      return `${n}点 (${f(pts[0].x)},${f(pts[0].y)})…(${f(pts[n - 1].x)},${f(pts[n - 1].y)})${e.closed ? ' 闭合' : ''}`;
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

/* ---------------- SVG 导入（完整 path 命令 + transform + 样式） ---------------- */
export function svgToEntities(text, doc) {
  if (!doc) doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const out = [];
  const TAU = Math.PI * 2;
  const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

  /* 矩阵工具 */
  const mulM = (m, n) => ({
    a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
  });
  const X = (p, m) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
  /** 完整解析 SVG transform：matrix/translate/scale/rotate/skewX/skewY（可多个串联） */
  const parseTransform = (t) => {
    let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    if (!t) return m;
    const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
    let mt;
    while ((mt = re.exec(t))) {
      const args = mt[2].trim().split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
      const name = mt[1].toLowerCase();
      if (name === 'matrix' && args.length >= 6) {
        m = mulM(m, { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] });
      } else if (name === 'translate') {
        m = mulM(m, { a: 1, b: 0, c: 0, d: 1, e: args[0] || 0, f: args[1] || 0 });
      } else if (name === 'scale') {
        const sx = args.length ? args[0] : 1, sy = args.length > 1 ? args[1] : sx;
        m = mulM(m, { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
      } else if (name === 'rotate') {
        const ang = (args[0] || 0) * Math.PI / 180;
        if (args.length >= 3) {
          m = mulM(m, { a: 1, b: 0, c: 0, d: 1, e: args[1], f: args[2] });
          m = mulM(m, { a: Math.cos(ang), b: Math.sin(ang), c: -Math.sin(ang), d: Math.cos(ang), e: 0, f: 0 });
          m = mulM(m, { a: 1, b: 0, c: 0, d: 1, e: -args[1], f: -args[2] });
        } else {
          m = mulM(m, { a: Math.cos(ang), b: Math.sin(ang), c: -Math.sin(ang), d: Math.cos(ang), e: 0, f: 0 });
        }
      } else if (name === 'skewx') {
        m = mulM(m, { a: 1, b: 0, c: Math.tan((args[0] || 0) * Math.PI / 180), d: 1, e: 0, f: 0 });
      } else if (name === 'skewy') {
        m = mulM(m, { a: 1, b: Math.tan((args[0] || 0) * Math.PI / 180), c: 0, d: 1, e: 0, f: 0 });
      }
    }
    return m;
  };

  /** 样式：stroke/fill → 实体颜色，stroke-width → 线宽 */
  const styleOf = (el, parent) => {
    const o = { ...parent };
    const stroke = el.getAttribute('stroke');
    const fill = el.getAttribute('fill');
    const col = stroke && stroke !== 'none' ? stroke : fill && fill !== 'none' ? fill : null;
    if (col) o.color = col;
    const w = num(el.getAttribute('stroke-width'));
    if (w > 0) o.lw = w;
    return o;
  };

  /** path d 解析：M/L/H/V/C/S/Q/T/A/Z（大小写、隐式重复），曲线采样为折线，圆弧保持为真圆弧 */
  const parsePath = (d, m, style) => {
    const ents = [];
    const tokens = d.match(/[MLHVCSQTAZmlhvcsqtaz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    let cx = 0, cy = 0, sx = 0, sy = 0;
    let lineRun = [];
    let pendingClose = false;
    const flushLine = () => {
      const pts = [...lineRun];
      lineRun = [];
      if (pendingClose && pts.length >= 3) { pendingClose = false; ents.push(make.polyline(pts, { closed: true, ...style })); return; }
      pendingClose = false;
      if (pts.length >= 2) ents.push(make.polyline(pts, { ...style }));
    };
    const lineTo = (x, y) => { if (!lineRun.length) lineRun.push({ x: cx, y: cy }); lineRun.push({ x, y }); cx = x; cy = y; };
    const cubic = (x1, y1, x2, y2, x, y) => {
      flushLine();
      const n = 16, pts = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n, u = 1 - t;
        pts.push(X({
          x: u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
          y: u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
        }, m));
      }
      ents.push(make.polyline(pts, { ...style }));
      cx = x; cy = y;
    };
    const quad = (x1, y1, x, y) => {
      flushLine();
      const n = 16, pts = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n, u = 1 - t;
        pts.push(X({ x: u * u * cx + 2 * u * t * x1 + t * t * x, y: u * u * cy + 2 * u * t * y1 + t * t * y }, m));
      }
      ents.push(make.polyline(pts, { ...style }));
      cx = x; cy = y;
    };
    const arcTo = (rx0, ry0, rotDeg, large, sweep, x2, y2) => {
      const x1 = cx, y1 = cy;
      let rx = Math.abs(rx0), ry = Math.abs(ry0);
      if (rx < 1e-9 || ry < 1e-9) { lineTo(x2, y2); return; }
      const phi = (rotDeg || 0) * Math.PI / 180;
      const cosp = Math.cos(phi), sinp = Math.sin(phi);
      const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
      const x1p = cosp * dx + sinp * dy, y1p = -sinp * dx + cosp * dy;
      let L = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
      if (L > 1) { const s = Math.sqrt(L); rx *= s; ry *= s; }
      const nume = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
      const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
      const coef = (large !== sweep) ? 1 : -1;
      const sq = coef * Math.sqrt(Math.max(0, nume / den));
      const cxp = sq * ((rx * y1p) / ry), cyp = sq * (-(ry * x1p) / rx);
      const cxl = cosp * cxp - sinp * cyp + (x1 + x2) / 2;
      const cyl = sinp * cxp + cosp * cyp + (y1 + y2) / 2;
      const th1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
      const th2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
      let dth = th2 - th1;
      if (!sweep && dth > 0) dth -= TAU; else if (sweep && dth < 0) dth += TAU;
      const det = m.a * m.d - m.b * m.c;
      const similar = Math.abs(rx - ry) < 1e-6
        && Math.abs(Math.hypot(m.a, m.b) - Math.hypot(m.c, m.d)) < 1e-6
        && Math.abs(m.a * m.c + m.b * m.d) < 1e-6 * Math.hypot(m.a, m.b) * Math.hypot(m.c, m.d);
      if (!similar) {
        // 椭圆弧或非相似变换 → 采样为折线
        flushLine();
        const n = Math.max(12, Math.ceil(Math.abs(dth) / (Math.PI / 16)));
        const pts = [];
        for (let k = 0; k <= n; k++) {
          const th = th1 + (dth * k) / n;
          pts.push(X({ x: cxl + rx * Math.cos(th) * cosp - ry * Math.sin(th) * sinp, y: cyl + rx * Math.cos(th) * sinp + ry * Math.sin(th) * cosp }, m));
        }
        ents.push(make.polyline(pts, { ...style }));
      } else {
        flushLine();
        const scale = Math.hypot(m.a, m.b);
        const cM = X({ x: cxl, y: cyl }, m);
        const p1M = X({ x: x1, y: y1 }, m), p2M = X({ x: x2, y: y2 }, m);
        const a1 = Math.atan2(p1M.y - cM.y, p1M.x - cM.x);
        const a2 = Math.atan2(p2M.y - cM.y, p2M.x - cM.x);
        const ccw = (sweep === 1) === (det >= 0);
        ents.push(make.arc(cM, rx * scale, a1, a2, { ccw, ...style }));
      }
      cx = x2; cy = y2;
    };
    let next = null, lastCubic = null, lastQuad = null;
    for (let i = 0; i < tokens.length;) {
      if (/^[a-zA-Z]$/.test(tokens[i])) {
        if (tokens[i].toUpperCase() === 'Z') { // Z 无参数，必须在此处理（其后无数字时循环会直接结束）
          pendingClose = true;
          flushLine();
          cx = sx; cy = sy;
          next = null;
        } else next = tokens[i];
        i++; continue;
      }
      if (!next) { i++; continue; }
      const U = next.toUpperCase();
      const N = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[U];
      if (i + N - 1 >= tokens.length) break; // 参数不足（容错）
      const args = tokens.slice(i, i + N).map(Number);
      i += N;
      const rel = next === next.toLowerCase();
      if (U === 'M' || U === 'L') {
        const nx = rel ? cx + args[0] : args[0], ny = rel ? cy + args[1] : args[1];
        if (U === 'M') { flushLine(); cx = nx; cy = ny; sx = nx; sy = ny; next = 'L'; }
        else lineTo(nx, ny);
      } else if (U === 'H') { const nx = rel ? cx + args[0] : args[0]; lineTo(nx, cy); cx = nx; }
      else if (U === 'V') { const ny = rel ? cy + args[0] : args[0]; lineTo(cx, ny); cy = ny; }
      else if (U === 'C') {
        const x1 = rel ? cx + args[0] : args[0], y1 = rel ? cy + args[1] : args[1];
        const x2 = rel ? cx + args[2] : args[2], y2 = rel ? cy + args[3] : args[3];
        const x = rel ? cx + args[4] : args[4], y = rel ? cy + args[5] : args[5];
        lastCubic = { x2, y2 };
        cubic(x1, y1, x2, y2, x, y);
      } else if (U === 'S') {
        const x1 = lastCubic ? 2 * cx - lastCubic.x2 : cx, y1 = lastCubic ? 2 * cy - lastCubic.y2 : cy;
        const x2 = rel ? cx + args[0] : args[0], y2 = rel ? cy + args[1] : args[1];
        const x = rel ? cx + args[2] : args[2], y = rel ? cy + args[3] : args[3];
        lastCubic = { x2, y2 };
        cubic(x1, y1, x2, y2, x, y);
      } else if (U === 'Q') {
        const x1 = rel ? cx + args[0] : args[0], y1 = rel ? cy + args[1] : args[1];
        const x = rel ? cx + args[2] : args[2], y = rel ? cy + args[3] : args[3];
        lastQuad = { x1, y1 };
        quad(x1, y1, x, y);
      } else if (U === 'T') {
        const x1 = lastQuad ? 2 * cx - lastQuad.x1 : cx, y1 = lastQuad ? 2 * cy - lastQuad.y1 : cy;
        const x = rel ? cx + args[0] : args[0], y = rel ? cy + args[1] : args[1];
        lastQuad = { x1, y1 };
        quad(x1, y1, x, y);
      } else if (U === 'A') {
        const x = rel ? cx + args[5] : args[5], y = rel ? cy + args[6] : args[6];
        arcTo(args[0], args[1], args[2], args[3], args[4], x, y);
      } else if (U === 'Z') {
        pendingClose = true;
        flushLine();
        cx = sx; cy = sy;
        next = null;
      }
    }
    flushLine();
    return ents;
  };

  const walk = (el, mIn, styleIn) => {
    const style = styleOf(el, styleIn);
    for (const child of el.children) {
      const mm = mulM(mIn, parseTransform(child.getAttribute('transform')));
      const tag = child.tagName.toLowerCase();
      const st = styleOf(child, style);
      if (tag === 'g' || tag === 'svg') walk(child, mm, st);
      else if (tag === 'line') {
        out.push(make.line(X({ x: num(child.getAttribute('x1')), y: num(child.getAttribute('y1')) }, mm), X({ x: num(child.getAttribute('x2')), y: num(child.getAttribute('y2')) }, mm), st));
      } else if (tag === 'rect') {
        const x = num(child.getAttribute('x')), y = num(child.getAttribute('y'));
        const w = num(child.getAttribute('width')), h = num(child.getAttribute('height'));
        const c1 = X({ x, y }, mm), c2 = X({ x: x + w, y: y + h }, mm);
        out.push(make.rectangle(c1, c2, st));
      } else if (tag === 'circle') {
        const cx0 = num(child.getAttribute('cx')), cy0 = num(child.getAttribute('cy')), r = num(child.getAttribute('r'));
        const c = X({ x: cx0, y: cy0 }, mm);
        const ex = X({ x: cx0 + r, y: cy0 }, mm), ey = X({ x: cx0, y: cy0 + r }, mm);
        const rxn = Math.hypot(ex.x - c.x, ex.y - c.y), ryn = Math.hypot(ey.x - c.x, ey.y - c.y);
        if (Math.abs(rxn - ryn) < 1e-6) out.push(make.circle(c, rxn, st));
        else out.push(make.ellipse(c, rxn, ryn, Math.atan2(ex.y - c.y, ex.x - c.x), st));
      } else if (tag === 'ellipse') {
        const cx0 = num(child.getAttribute('cx')), cy0 = num(child.getAttribute('cy'));
        const c = X({ x: cx0, y: cy0 }, mm);
        const ex = X({ x: cx0 + num(child.getAttribute('rx')), y: cy0 }, mm), ey = X({ x: cx0, y: cy0 + num(child.getAttribute('ry')) }, mm);
        out.push(make.ellipse(c, Math.hypot(ex.x - c.x, ex.y - c.y), Math.hypot(ey.x - c.x, ey.y - c.y), Math.atan2(ex.y - c.y, ex.x - c.x), st));
      } else if (tag === 'polyline' || tag === 'polygon') {
        const pts = (child.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
        const points = [];
        for (let i = 0; i + 1 < pts.length; i += 2) points.push(X({ x: pts[i], y: pts[i + 1] }, mm));
        if (points.length >= 2) out.push(make.polyline(points, { closed: tag === 'polygon', ...st }));
      } else if (tag === 'path') {
        const d = (child.getAttribute('d') || '').trim();
        if (d) out.push(...parsePath(d, mm, st));
      } else if (tag === 'text') {
        const p = X({ x: num(child.getAttribute('x')), y: num(child.getAttribute('y')) }, mm);
        const fs = num(child.getAttribute('font-size'), 16);
        out.push(make.text(p, child.textContent || '', fs, 0, st));
      }
    }
  };
  const rootM = parseTransform(doc.documentElement.getAttribute('transform'));
  walk(doc.documentElement, rootM, {});
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
