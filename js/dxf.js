/* ============================================================
 * 小宝CAD DXF 读写模块 —— 纯 ES 模块（无浏览器 API）
 * 导出：
 *   parseDXF(text) -> { units, layers, blocks, entities, currentLayer }
 *   writeDXF(scene) -> string
 * ============================================================ */
import { uid, D2R, R2D, TAU } from './util.js';

/* ============================================================
 * 通用小工具
 * ============================================================ */

/** 把任意值转为数字；非法/缺失返回 null */
function toNum(v) {
  if (v == null) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
/** 读取记录中某组码第 idx 个值（数字），缺失返回 null */
function vnum(rec, code, idx = 0) {
  const a = rec.get(code);
  return a ? toNum(a[idx]) : null;
}
/** 读取记录中某组码第 idx 个原始字符串值 */
function val(rec, code, idx = 0) {
  const a = rec.get(code);
  return a ? a[idx] : undefined;
}
/** 真彩色整数(24bit) → '#rrggbb' */
function rgbHex(v) {
  const n = Math.max(0, Math.min(0xffffff, Math.round(v)));
  return '#' + n.toString(16).padStart(6, '0');
}
/** '#rrggbb' → 十进制整数 */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  return m ? parseInt(m[1], 16) : 0;
}
/** 数字格式化：普通范围输出固定小数（误差 < 1e-9），极端值用科学计数 */
function fnum(v) {
  if (v == null || !Number.isFinite(v)) return '0';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e-6 && abs < 1e12) {
    let s = v.toFixed(9);
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return s;
  }
  return String(v);
}
/** 遍历 Map / 数组 / 任意 values() 容器 */
function valuesOf(coll) {
  if (!coll) return [];
  if (coll instanceof Map) return [...coll.values()];
  if (Array.isArray(coll)) return coll;
  if (typeof coll.values === 'function') return [...coll.values()];
  return [];
}

/* ============================================================
 * 词法：把文本切分为 [组码, 值] 序列
 * 组码允许带空格/制表符，值允许前导空格，行尾 \n 或 \r\n
 * ============================================================ */
function tokenize(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}
/** 收集一条记录（从 start 起，直到下一个组码 0 或结尾） */
function collectRecord(pairs, start) {
  const rec = new Map();
  let j = start;
  while (j < pairs.length && pairs[j][0] !== 0) {
    const [c, v] = pairs[j];
    if (!rec.has(c)) rec.set(c, []);
    rec.get(c).push(v);
    j++;
  }
  return { rec, next: j };
}
/** 跳过一条记录（不含组码 0 头），返回下一个组码 0 的位置 */
function skipRecord(pairs, i) {
  let j = i + 1;
  while (j < pairs.length && pairs[j][0] !== 0) j++;
  return j;
}
function skipSection(pairs, i) {
  while (i < pairs.length) {
    if (pairs[i][0] === 0 && String(pairs[i][1]).trim().toUpperCase() === 'ENDSEC') return i + 1;
    i++;
  }
  return i;
}

/* ============================================================
 * 实体基础
 * ============================================================ */
function baseEntity(type) {
  return { type, layer: null, color: null, ltype: null, lw: null };
}
/** 应用通用组码：8 图层、62/420 颜色、6 线型、370 线宽 */
function applyCommon(e, rec) {
  const layer = val(rec, 8);
  if (layer != null) e.layer = String(layer).trim() || '0';
  const c420 = vnum(rec, 420);
  const c62 = vnum(rec, 62);
  if (c420 != null) e.color = rgbHex(c420);
  else if (c62 != null) {
    if (c62 === 0 || c62 === 256) e.color = null;
    else if (c62 < 0) e.color = -c62;
    else e.color = c62;
  }
  const lt = val(rec, 6);
  if (lt != null) { const t = String(lt).trim(); if (t) e.ltype = t; }
  const lw = vnum(rec, 370);
  if (lw != null && lw > 0) e.lw = lw / 100;
  return e;
}
/** 补 id 与默认图层 */
function finalize(e) {
  if (e.layer == null) e.layer = '0';
  e.id = uid();
  return e;
}

/* ---------------- MTEXT 内容清理 ---------------- */
function cleanMText(s) {
  let t = String(s ?? '').replace(/\r\n?/g, '\n');
  t = t.replace(/\\P/gi, '\n');                 // 段落换行
  t = t.replace(/\\\{/g, '\u0000').replace(/\\\}/g, '\u0001'); // 字面大括号
  t = t.replace(/[{}]/g, '');                   // 删除大括号
  t = t.replace(/\u0000/g, '{').replace(/\u0001/g, '}');
  t = t.replace(/\\[A-Za-z][^;\\]*;?/g, '');    // 剥离 \A \H \W \C \F \f \Q \T \S 等控制序列
  t = t.replace(/\\~/g, ' ');                   // 不换行空格
  t = t.replace(/\\\\/g, '\\');                 // 反斜杠还原
  return t;
}

/* ============================================================
 * 单条实体记录解析（不含多记录类型 POLYLINE）
 * ============================================================ */
function parseEntityRecord(rec, type, depth) {
  let e;
  switch (type) {
    case 'LINE':
      e = baseEntity('line');
      e.x1 = vnum(rec, 10) ?? 0; e.y1 = vnum(rec, 20) ?? 0;
      e.x2 = vnum(rec, 11) ?? 0; e.y2 = vnum(rec, 21) ?? 0;
      break;
    case 'LWPOLYLINE': {
      e = baseEntity('polyline');
      const flags = vnum(rec, 70) ?? 0;
      e.closed = (flags & 1) !== 0;
      const xs = rec.get(10) || [], ys = rec.get(20) || [], bs = rec.get(42) || [];
      const n90 = vnum(rec, 90) ?? 0;
      const count = n90 > 0 ? n90 : Math.max(xs.length, ys.length);
      const pts = [];
      for (let k = 0; k < count; k++) {
        const x = vnum(rec, 10, k), y = vnum(rec, 20, k);
        if (x == null || y == null) continue;
        pts.push({ x, y, bulge: vnum(rec, 42, k) ?? 0 });
      }
      e.points = pts;
      break;
    }
    case 'CIRCLE':
      e = baseEntity('circle');
      e.cx = vnum(rec, 10) ?? 0; e.cy = vnum(rec, 20) ?? 0; e.r = vnum(rec, 40) ?? 0;
      break;
    case 'ARC':
      e = baseEntity('arc');
      e.cx = vnum(rec, 10) ?? 0; e.cy = vnum(rec, 20) ?? 0; e.r = vnum(rec, 40) ?? 0;
      e.startAngle = (vnum(rec, 50) ?? 0) * D2R;
      e.endAngle = (vnum(rec, 51) ?? 0) * D2R;
      e.ccw = true; // DXF 圆弧恒为逆时针
      break;
    case 'ELLIPSE': {
      e = baseEntity('ellipse');
      e.cx = vnum(rec, 10) ?? 0; e.cy = vnum(rec, 20) ?? 0;
      const mx = vnum(rec, 11) ?? 0, my = vnum(rec, 21) ?? 0; // 长轴端点（相对中心）
      const rx = Math.hypot(mx, my);
      const ratio = vnum(rec, 40) ?? 1;
      e.rx = rx; e.ry = rx * ratio; e.rot = Math.atan2(my, mx);
      if (rec.has(41) || rec.has(42)) {
        e.startAngle = vnum(rec, 41) ?? 0;
        e.endAngle = vnum(rec, 42) ?? TAU;
      }
      break;
    }
    case 'POINT':
      e = baseEntity('point');
      e.x = vnum(rec, 10) ?? 0; e.y = vnum(rec, 20) ?? 0;
      break;
    case 'TEXT': {
      e = baseEntity('text');
      e.x = vnum(rec, 10) ?? 0; e.y = vnum(rec, 20) ?? 0;
      e.height = vnum(rec, 40) ?? 0;
      e.text = val(rec, 1) != null ? String(val(rec, 1)) : '';
      e.rotation = (vnum(rec, 50) ?? 0) * D2R;
      const h = vnum(rec, 72) ?? 0;
      const v = vnum(rec, 73) ?? 0;
      e.halign = h === 1 ? 'center' : h === 2 ? 'right' : 'left';
      e.valign = v === 1 ? 'bottom' : v === 2 ? 'middle' : v === 3 ? 'top' : 'baseline';
      // 第二对齐点覆盖插入点
      const x2 = vnum(rec, 11), y2 = vnum(rec, 21);
      if (x2 != null) e.x = x2;
      if (y2 != null) e.y = y2;
      break;
    }
    case 'MTEXT': {
      e = baseEntity('text');
      e.x = vnum(rec, 10) ?? 0; e.y = vnum(rec, 20) ?? 0;
      e.height = vnum(rec, 40) ?? 0;
      let content = '';
      const c3 = rec.get(3) || [];
      for (const c of c3) content += String(c);
      const c1 = val(rec, 1);
      if (c1 != null) content += String(c1);
      e.text = cleanMText(content);
      e.rotation = vnum(rec, 50) ?? 0; // MTEXT 的 50 为弧度
      const at = (vnum(rec, 71) ?? 1) - 1;
      e.halign = (at % 3) === 0 ? 'left' : (at % 3) === 1 ? 'center' : 'right';
      e.valign = at < 3 ? 'top' : at < 6 ? 'middle' : 'bottom';
      break;
    }
    case 'INSERT': {
      if (depth > 8) { e = null; break; } // 嵌套深度限制
      const bn = val(rec, 2) != null ? String(val(rec, 2)).trim() : '';
      if (!bn) { e = null; break; }
      e = baseEntity('insert');
      e.block = bn;
      e.x = vnum(rec, 10) ?? 0; e.y = vnum(rec, 20) ?? 0;
      e.scaleX = vnum(rec, 41) ?? 1; e.scaleY = vnum(rec, 42) ?? 1;
      e.rotation = (vnum(rec, 50) ?? 0) * D2R;
      break;
    }
    case 'DIMENSION': {
      const flag = vnum(rec, 70) ?? 0;
      const t = flag & 0x0f; // 0 旋转线性 1 对齐 2 角度 3 直径 4 半径 5 三点角度
      e = baseEntity('dimension');
      if (t === 2 || t === 5) {
        e.subtype = 'angular';
        e.cx = vnum(rec, 10) ?? 0; e.cy = vnum(rec, 20) ?? 0;
        e.a1x = vnum(rec, 13) ?? 0; e.a1y = vnum(rec, 23) ?? 0;
        e.a2x = vnum(rec, 14) ?? 0; e.a2y = vnum(rec, 24) ?? 0;
        const px = vnum(rec, 15), py = vnum(rec, 25);
        if (px != null && py != null) e.r = Math.hypot(px - e.cx, py - e.cy);
        const tx = vnum(rec, 11), ty = vnum(rec, 21);
        if (tx != null) e.tx = tx;
        if (ty != null) e.ty = ty;
      } else if (t === 3 || t === 4) {
        e.subtype = t === 3 ? 'diametric' : 'radial';
        e.cx = vnum(rec, 10) ?? 0; e.cy = vnum(rec, 20) ?? 0;
        e.px = vnum(rec, 15) ?? 0; e.py = vnum(rec, 25) ?? 0;
        const r = Math.hypot(e.px - e.cx, e.py - e.cy);
        const tx = vnum(rec, 11), ty = vnum(rec, 21);
        e.tx = tx != null ? tx : e.cx;
        e.ty = ty != null ? ty : e.cy + r; // 缺省在圆心上方
      } else {
        e.subtype = 'linear';
        e.x1 = vnum(rec, 10) ?? 0; e.y1 = vnum(rec, 20) ?? 0;
        e.x2 = vnum(rec, 13) ?? 0; e.y2 = vnum(rec, 23) ?? 0;
        e.x3 = vnum(rec, 14) ?? 0; e.y3 = vnum(rec, 24) ?? 0;
        const a = vnum(rec, 50);
        if (a != null) e.angle = a * D2R;
        else if (t === 1) e.angle = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
        else e.angle = 0;
      }
      break;
    }
    case 'HATCH': {
      // 仅支持 72 == 1 的 polyline 边界
      if ((vnum(rec, 72) ?? 0) !== 1) { e = null; break; }
      const xs = rec.get(10) || [], ys = rec.get(20) || [];
      const pts = [];
      for (let k = 0; k < Math.max(xs.length, ys.length); k++) {
        const x = vnum(rec, 10, k), y = vnum(rec, 20, k);
        if (x == null || y == null) continue;
        pts.push({ x, y });
      }
      if (pts.length < 3) { e = null; break; }
      e = baseEntity('hatch');
      e.boundary = { kind: 'polyline', points: pts };
      const pname = val(rec, 2) != null ? String(val(rec, 2)).trim().toUpperCase() : '';
      e.solid = pname === 'SOLID' || ((vnum(rec, 70) ?? 0) & 1) !== 0;
      const sp = vnum(rec, 41); if (sp != null) e.spacing = sp;
      const ang = vnum(rec, 52); if (ang != null) e.angle = ang * D2R;
      break;
    }
    case 'SOLID':
    case 'TRACE': {
      const x1 = vnum(rec, 10) ?? 0, y1 = vnum(rec, 20) ?? 0;
      const x2 = vnum(rec, 11) ?? 0, y2 = vnum(rec, 21) ?? 0;
      const x3 = vnum(rec, 12) ?? 0, y3 = vnum(rec, 22) ?? 0;
      const x4 = vnum(rec, 13) ?? 0, y4 = vnum(rec, 23) ?? 0;
      e = baseEntity('polyline');
      e.closed = true;
      // 填充顺序 1-2-4-3
      e.points = [
        { x: x1, y: y1, bulge: 0 }, { x: x2, y: y2, bulge: 0 },
        { x: x4, y: y4, bulge: 0 }, { x: x3, y: y3, bulge: 0 },
      ];
      break;
    }
    default:
      e = null; // SPLINE 等未知类型跳过
  }
  if (!e) return null;
  applyCommon(e, rec);
  return finalize(e);
}

/* ============================================================
 * 在给定位置解析一条实体（含多记录 POLYLINE+VERTEX）
 * 返回 { entity, next }
 * ============================================================ */
function parseEntityAt(pairs, j, depth, data) {
  const type = String(pairs[j][1]).trim().toUpperCase();
  const { rec, next } = collectRecord(pairs, j + 1);

  if (type === 'POLYLINE') {
    const e = baseEntity('polyline');
    const flags = vnum(rec, 70) ?? 0;
    e.closed = (flags & 1) !== 0;
    e.points = [];
    let k = next;
    while (k < pairs.length) {
      const [c, v] = pairs[k];
      if (c === 0) {
        const vv = String(v).trim().toUpperCase();
        if (vv === 'SEQEND') { k = skipRecord(pairs, k); break; }
        if (vv === 'VERTEX') {
          const vr = collectRecord(pairs, k + 1);
          const vx = vnum(vr.rec, 10) ?? 0, vy = vnum(vr.rec, 20) ?? 0;
          e.points.push({ x: vx, y: vy, bulge: vnum(vr.rec, 42) ?? 0 });
          k = vr.next;
          continue;
        }
        break;
      }
      k++;
    }
    applyCommon(e, rec);
    return { entity: finalize(e), next: k };
  }

  const entity = parseEntityRecord(rec, type, depth);
  return { entity, next };
}

/* ============================================================
 * SECTION 解析
 * ============================================================ */
function parseHeader(pairs, i, data) {
  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code === 0 && String(value).trim().toUpperCase() === 'ENDSEC') return i + 1;
    if (code === 9) {
      const varName = String(value).trim().toUpperCase();
      const nv = pairs[i + 1];
      if (nv) {
        if (varName === '$INSUNITS') {
          const u = parseInt(String(nv[1]).trim(), 10);
          data.units = u === 1 ? 'inch' : u === 6 ? 'm' : 'mm';
        } else if (varName === '$CLAYER') {
          data.currentLayer = String(nv[1]).trim();
        }
      }
    }
    i++;
  }
  return i;
}

function parseLayerRecord(pairs, i, data) {
  const { rec, next } = collectRecord(pairs, i + 1);
  const name = val(rec, 2) != null ? String(val(rec, 2)).trim() : '';
  if (!name) return next;
  const layer = { name, color: null, on: true, locked: false, ltype: 'CONTINUOUS', lw: null };
  const c420 = vnum(rec, 420);
  const c62 = vnum(rec, 62);
  if (c420 != null) layer.color = rgbHex(c420);
  else if (c62 != null) {
    if (c62 < 0) { layer.on = false; const v = -c62; layer.color = (v === 0 || v === 256) ? null : v; }
    else if (c62 === 0 || c62 === 256) layer.color = null;
    else layer.color = c62;
  }
  const lt = val(rec, 6);
  if (lt != null) { const t = String(lt).trim(); if (t) layer.ltype = t; }
  const flags = vnum(rec, 70) ?? 0;
  if (flags & 1) layer.on = false;   // 冻结
  if (flags & 4) layer.locked = true; // 锁定
  const lw = vnum(rec, 370);
  if (lw != null && lw > 0) layer.lw = lw / 100;
  data.layers.push(layer);
  return next;
}

function parseTables(pairs, i, data) {
  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code === 0) {
      const v = String(value).trim().toUpperCase();
      if (v === 'ENDSEC') return i + 1;
      if (v === 'TABLE') {
        const nxt = pairs[i + 1];
        const tname = (nxt && nxt[0] === 2) ? String(nxt[1]).trim().toUpperCase() : '';
        i += 2;
        if (tname === 'LAYER') {
          while (i < pairs.length) {
            const [c2, v2] = pairs[i];
            if (c2 === 0) {
              const vv = String(v2).trim().toUpperCase();
              if (vv === 'ENDTAB') { i++; break; }
              if (vv === 'LAYER') { i = parseLayerRecord(pairs, i, data); continue; }
              i = skipRecord(pairs, i); // 其他表记录跳过
              continue;
            }
            i++;
          }
        } else {
          while (i < pairs.length) {
            if (pairs[i][0] === 0 && String(pairs[i][1]).trim().toUpperCase() === 'ENDTAB') { i++; break; }
            i++;
          }
        }
        continue;
      }
    }
    i++;
  }
  return i;
}

function parseBlocks(pairs, i, data) {
  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code === 0) {
      const v = String(value).trim().toUpperCase();
      if (v === 'ENDSEC') return i + 1;
      if (v === 'BLOCK') {
        const { rec, next } = collectRecord(pairs, i + 1);
        const name = val(rec, 2) != null ? String(val(rec, 2)).trim() : '';
        const block = { name, baseX: vnum(rec, 10) ?? 0, baseY: vnum(rec, 20) ?? 0, entities: [] };
        let j = next;
        while (j < pairs.length) {
          const [c2, v2] = pairs[j];
          if (c2 === 0) {
            const vv = String(v2).trim().toUpperCase();
            if (vv === 'ENDBLK') { j++; break; }
            if (vv === 'ENDSEC') break;
            const r = parseEntityAt(pairs, j, 1, data);
            if (r.entity) block.entities.push(r.entity);
            j = r.next;
            continue;
          }
          j++;
        }
        if (name) data.blocks.push(block);
        i = j;
        continue;
      }
    }
    i++;
  }
  return i;
}

function parseEntities(pairs, i, data) {
  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code === 0) {
      const v = String(value).trim().toUpperCase();
      if (v === 'ENDSEC') return i + 1;
      const r = parseEntityAt(pairs, i, 0, data);
      if (r.entity) data.entities.push(r.entity);
      i = r.next;
      continue;
    }
    i++;
  }
  return i;
}

/* ============================================================
 * parseDXF
 * ============================================================ */
export function parseDXF(text) {
  const data = { units: 'mm', layers: [], blocks: [], entities: [], currentLayer: '0' };
  const pairs = tokenize(text);
  let i = 0;
  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code === 0) {
      const v = String(value).trim().toUpperCase();
      if (v === 'SECTION') {
        const sec = (pairs[i + 1] && pairs[i + 1][0] === 2) ? String(pairs[i + 1][1]).trim().toUpperCase() : '';
        i += 2;
        if (sec === 'HEADER') i = parseHeader(pairs, i, data);
        else if (sec === 'TABLES') i = parseTables(pairs, i, data);
        else if (sec === 'BLOCKS') i = parseBlocks(pairs, i, data);
        else if (sec === 'ENTITIES') i = parseEntities(pairs, i, data);
        else i = skipSection(pairs, i);
        continue;
      }
    }
    i++;
  }
  return data;
}

/* ============================================================
 * writeDXF —— 输出 R12 风格文本 DXF
 * ============================================================ */
let _handle = 0;

function writeEntityColor(e, L) {
  const c = e.color;
  if (c == null) L(62, '256');
  else if (typeof c === 'number') L(62, String(c));
  else if (typeof c === 'string' && c.startsWith('#')) { L(62, '256'); L(420, String(hexToRgb(c))); }
}

function writeCommon(e, L) {
  L(5, (++_handle).toString(16).toUpperCase());
  if (e.layer != null) L(8, String(e.layer));
  writeEntityColor(e, L);
  if (e.ltype) L(6, String(e.ltype));
  if (e.lw != null && e.lw > 0) L(370, String(Math.round(e.lw * 100)));
}

function writeEntity(e, L) {
  switch (e.type) {
    case 'line':
      L(0, 'LINE'); writeCommon(e, L);
      L(10, fnum(e.x1)); L(20, fnum(e.y1)); L(11, fnum(e.x2)); L(21, fnum(e.y2));
      break;
    case 'circle':
      L(0, 'CIRCLE'); writeCommon(e, L);
      L(10, fnum(e.cx)); L(20, fnum(e.cy)); L(40, fnum(e.r));
      break;
    case 'arc': {
      L(0, 'ARC'); writeCommon(e, L);
      L(10, fnum(e.cx)); L(20, fnum(e.cy)); L(40, fnum(e.r));
      let sa = e.startAngle ?? 0, ea = e.endAngle ?? 0;
      if (e.ccw === false) { const t = sa; sa = ea; ea = t; } // 顺时针 → 交换端点
      L(50, fnum(sa * R2D)); L(51, fnum(ea * R2D));
      break;
    }
    case 'ellipse': {
      L(0, 'ELLIPSE'); writeCommon(e, L);
      L(10, fnum(e.cx)); L(20, fnum(e.cy));
      const rot = e.rot ?? 0;
      const rx = e.rx || 0;
      L(11, fnum(rx * Math.cos(rot))); L(21, fnum(rx * Math.sin(rot)));
      L(40, fnum(rx ? (e.ry / rx) : 1));
      if (e.startAngle !== undefined || e.endAngle !== undefined) {
        L(41, fnum(e.startAngle ?? 0)); L(42, fnum(e.endAngle ?? TAU));
      }
      break;
    }
    case 'point':
      L(0, 'POINT'); writeCommon(e, L);
      L(10, fnum(e.x)); L(20, fnum(e.y));
      break;
    case 'polyline': {
      L(0, 'LWPOLYLINE'); writeCommon(e, L);
      const pts = e.points || [];
      L(90, String(pts.length));
      L(70, e.closed ? '1' : '0');
      for (const p of pts) {
        L(10, fnum(p.x)); L(20, fnum(p.y)); L(42, fnum(p.bulge || 0));
      }
      break;
    }
    case 'text': {
      L(0, 'TEXT'); writeCommon(e, L);
      L(10, fnum(e.x)); L(20, fnum(e.y));
      L(40, fnum(e.height));
      L(1, String(e.text ?? '').replace(/[\r\n]+/g, ' '));
      L(50, fnum((e.rotation || 0) * R2D));
      const h = e.halign === 'center' ? 1 : e.halign === 'right' ? 2 : 0;
      const v = e.valign === 'bottom' ? 1 : e.valign === 'middle' ? 2 : e.valign === 'top' ? 3 : 0;
      L(72, String(h)); L(73, String(v));
      if (h !== 0 || v !== 0) { L(11, fnum(e.x)); L(21, fnum(e.y)); }
      break;
    }
    case 'insert':
      L(0, 'INSERT'); writeCommon(e, L);
      L(2, String(e.block ?? ''));
      L(10, fnum(e.x)); L(20, fnum(e.y));
      L(41, fnum(e.scaleX ?? 1)); L(42, fnum(e.scaleY ?? 1));
      L(50, fnum((e.rotation || 0) * R2D));
      break;
    case 'dimension': {
      L(0, 'DIMENSION'); writeCommon(e, L);
      if (e.subtype === 'radial' || e.subtype === 'diametric') {
        const isD = e.subtype === 'diametric';
        L(10, fnum(e.cx)); L(20, fnum(e.cy));
        L(15, fnum(e.px)); L(25, fnum(e.py));
        if (e.tx != null) L(11, fnum(e.tx));
        if (e.ty != null) L(21, fnum(e.ty));
        L(40, fnum(Math.hypot(e.px - e.cx, e.py - e.cy)));
        L(70, isD ? '3' : '4');
      } else if (e.subtype === 'angular') {
        L(10, fnum(e.cx)); L(20, fnum(e.cy));
        L(13, fnum(e.a1x)); L(23, fnum(e.a1y));
        L(14, fnum(e.a2x)); L(24, fnum(e.a2y));
        const a1 = Math.atan2(e.a1y - e.cy, e.a1x - e.cx);
        const a2 = Math.atan2(e.a2y - e.cy, e.a2x - e.cx);
        const r = (e.r != null && e.r > 0) ? e.r : Math.hypot(e.a1x - e.cx, e.a1y - e.cy);
        const mid = (a1 + a2) / 2;
        L(15, fnum(e.cx + r * Math.cos(mid))); L(25, fnum(e.cy + r * Math.sin(mid)));
        if (e.tx != null) L(11, fnum(e.tx));
        if (e.ty != null) L(21, fnum(e.ty));
        L(70, '2');
      } else {
        L(10, fnum(e.x1)); L(20, fnum(e.y1));
        L(13, fnum(e.x2)); L(23, fnum(e.y2));
        L(14, fnum(e.x3)); L(24, fnum(e.y3));
        L(70, '0');
        L(50, fnum((e.angle || 0) * R2D));
      }
      break;
    }
    case 'hatch': {
      // hatch → 闭合 LWPOLYLINE 近似边界
      const b = e.boundary;
      if (!b || b.kind !== 'polyline' || !b.points || b.points.length < 3) break;
      L(0, 'LWPOLYLINE'); writeCommon(e, L);
      L(90, String(b.points.length));
      L(70, '1');
      for (const p of b.points) { L(10, fnum(p.x)); L(20, fnum(p.y)); L(42, '0'); }
      break;
    }
    default:
      break; // 未知类型跳过
  }
}

function writeLayer(layer, L) {
  L(0, 'LAYER');
  L(2, layer.name != null ? String(layer.name) : '0');
  L(70, String(layer.locked ? 4 : 0));
  const c = layer.color;
  const neg = layer.on === false;
  if (typeof c === 'string' && c.startsWith('#')) {
    L(62, neg ? '-256' : '256');
    L(420, String(hexToRgb(c)));
  } else if (typeof c === 'number') {
    L(62, String(neg ? -Math.abs(c) : c));
  } else {
    L(62, neg ? '-7' : '256');
  }
  if (layer.ltype) L(6, String(layer.ltype));
  if (layer.lw != null && layer.lw > 0) L(370, String(Math.round(layer.lw * 100)));
}

function writeBlock(blk, L) {
  L(0, 'BLOCK');
  L(8, '0');
  L(2, String(blk.name ?? ''));
  L(70, '0');
  L(10, fnum(blk.baseX || 0)); L(20, fnum(blk.baseY || 0));
  L(3, String(blk.name ?? ''));
  L(1, '');
  for (const e of valuesOf(blk.entities)) writeEntity(e, L);
  L(0, 'ENDBLK');
}

export function writeDXF(scene) {
  _handle = 0;
  const out = [];
  const L = (code, value) => { out.push(String(code), String(value)); };

  // HEADER
  L(0, 'SECTION'); L(2, 'HEADER');
  L(9, '$ACADVER'); L(1, 'AC1009');
  L(9, '$INSUNITS'); L(70, '4');
  if (scene && scene.currentLayer) { L(9, '$CLAYER'); L(8, String(scene.currentLayer)); }
  L(0, 'ENDSEC');

  // TABLES / LAYER
  L(0, 'SECTION'); L(2, 'TABLES');
  L(0, 'TABLE'); L(2, 'LAYER');
  const layers = valuesOf(scene && scene.layers);
  L(70, String(layers.length));
  for (const layer of layers) writeLayer(layer, L);
  L(0, 'ENDTAB');
  L(0, 'ENDSEC');

  // BLOCKS
  const blocks = valuesOf(scene && scene.blocks);
  if (blocks.length) {
    L(0, 'SECTION'); L(2, 'BLOCKS');
    for (const blk of blocks) writeBlock(blk, L);
    L(0, 'ENDSEC');
  }

  // ENTITIES
  L(0, 'SECTION'); L(2, 'ENTITIES');
  for (const e of valuesOf(scene && scene.entities)) writeEntity(e, L);
  L(0, 'ENDSEC');

  L(0, 'EOF');
  return out.join('\n') + '\n';
}
