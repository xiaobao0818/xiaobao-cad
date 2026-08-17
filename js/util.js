/* ============================================================
 * 小宝CAD 工具函数库 —— 几何计算 / 格式化 / 事件 / 颜色 / 矩阵
 * ============================================================ */
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const TAU = Math.PI * 2;
export const EPS = 1e-9;

let _uid = 0;
export function uid() {
  return 'e' + (++_uid).toString(36) + Date.now().toString(36).slice(-5);
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ---------------- 格式化 ---------------- */
export function fmt(v, precision = 4) {
  if (!Number.isFinite(v)) return '';
  const p = 10 ** precision;
  const r = Math.abs(v) < 1e-12 ? 0 : Math.round(v * p) / p;
  return String(r);
}
export function fmtCoord(p) { return `${fmt(p.x, 3)}, ${fmt(p.y, 3)}`; }

export function parseNumber(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/);
  return m ? parseFloat(m[0]) : null;
}
/** 解析坐标："x,y" 绝对、@x,y 相对、@距离<角度 相对极坐标 */
export function parsePoint(str, base) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;
  const rel = s.startsWith('@');
  const body = rel ? s.slice(1) : s;
  let m = body.match(/^([+-]?\d*\.?\d+)\s*<\s*([+-]?\d*\.?\d+)$/);
  if (m) {
    const d = parseFloat(m[1]), a = parseFloat(m[2]) * D2R;
    if (rel && base) return polar(base, a, d);
    return { x: Math.cos(a) * d, y: Math.sin(a) * d, rel };
  }
  m = body.split(',').map((t) => parseFloat(t.trim()));
  if (m.length === 2 && m.every(Number.isFinite)) {
    if (rel && base) return { x: base.x + m[0], y: base.y + m[1], rel };
    return { x: m[0], y: m[1], rel };
  }
  return null;
}
/** 解析长度：纯数字为绝对值，"@数字" 为相对值 */
export function parseLength(str, base = 0) {
  if (typeof str !== 'string') return null;
  const t = str.trim();
  const rel = t.startsWith('@');
  const n = parseNumber(rel ? t.slice(1) : t);
  if (n === null) return null;
  return rel ? base + n : n;
}

/* ---------------- 基础工具 ---------------- */
export function deepClone(o) {
  return typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o));
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function download(filename, content, mime = 'application/octet-stream') {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, new Set()); this._l.get(ev).add(fn); return this; }
  off(ev, fn) { this._l.get(ev)?.delete(fn); return this; }
  emit(ev, ...args) { this._l.get(ev)?.forEach((fn) => { try { fn(...args); } catch (e) { console.error('[event]', ev, e); } }); }
}

/* ---------------- 颜色 / 线型 ---------------- */
export const ACI = [
  '#000000', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff',
  '#808080', '#c0c0c0', '#ff0000', '#ff7f7f', '#cc0000', '#cc6666', '#990000', '#996666',
  '#804040', '#806060', '#4d3333', '#ffbfbf', '#ff0000', '#ff7f7f', '#bf3f3f', '#ff9f9f',
];
export function colorToCSS(color, layerColor = '#ffffff', alpha = 1) {
  let c = color;
  if (c === null || c === undefined || c === 'ByLayer' || c === 'bylayer') c = layerColor || '#ffffff';
  if (typeof c === 'number') c = ACI[c % 256] || '#ffffff';
  if (typeof c !== 'string') c = '#ffffff';
  if (c.startsWith('#') && c.length === 7 && alpha !== 1) {
    const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return c;
}
export const LINETYPES = {
  CONTINUOUS: [],
  BYLAYER: [],
  DASHED: [10, 5],
  DASHED2: [14, 7],
  HIDDEN: [8, 4],
  HIDDEN2: [12, 6],
  CENTER: [18, 4, 3, 4],
  CENTER2: [14, 3, 2, 3],
  DASHDOT: [12, 4, 2, 4],
  DASHDOT2: [16, 4, 2, 4, 2, 4],
  DOT: [2, 4],
  PHANTOM: [16, 4, 2, 4, 2, 4],
};
export function dashPattern(name) { return LINETYPES[name] || LINETYPES.CONTINUOUS; }

/* ---------------- 几何 ---------------- */
export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
export function angleOf(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }
export function polar(p, ang, d) { return { x: p.x + Math.cos(ang) * d, y: p.y + Math.sin(ang) * d }; }
export function normAngle(a) { a %= TAU; return a < 0 ? a + TAU : a; }

/** 两线段交点（含端点），返回 {x,y,t,u} 或 null */
export function segSegIntersection(p1, p2, p3, p4, tol = 1e-9) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < tol) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y, t: clamp(t, 0, 1), u: clamp(u, 0, 1) };
}
/** 直线（无限）与圆的交点，返回 [{x,y,t}] */
export function lineCircleIntersections(p1, p2, cx, cy, r, tol = 1e-9) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const a = dx * dx + dy * dy;
  if (a < tol) return [];
  const fx = p1.x - cx, fy = p1.y - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  disc = Math.sqrt(disc);
  const out = [];
  for (const t of [(-b - disc) / (2 * a), (-b + disc) / (2 * a)]) {
    out.push({ x: p1.x + t * dx, y: p1.y + t * dy, t });
  }
  return out;
}
/** 两圆交点 */
export function circleCircleIntersections(c1, r1, c2, r2, tol = 1e-9) {
  const d = dist(c1, c2);
  if (d < tol || d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const mx = c1.x + (a * (c2.x - c1.x)) / d, my = c1.y + (a * (c2.y - c1.y)) / d;
  const rx = -(c2.y - c1.y) * (h / d), ry = (c2.x - c1.x) * (h / d);
  if (h < tol) return [{ x: mx, y: my }];
  return [{ x: mx + rx, y: my + ry }, { x: mx - rx, y: my - ry }];
}
/** 角度是否在 [start,end] 弧段内（弧段跨度 < 2π，CCW） */
export function angleInRange(a, start, end, tol = 1e-9) {
  const s = normAngle(start), e = normAngle(end), x = normAngle(a);
  return s <= e ? x >= s - tol && x <= e + tol : x >= s - tol || x <= e + tol;
}
/** 弧段扫过角度（0..2π），start->end 为 CCW 时 sweep=end-start (mod 2π) */
export function arcSweep(start, end) { return normAngle(end - start); }

export function distPointSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function nearestOnSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = clamp(t, 0, 1);
  return { x: a.x + t * dx, y: a.y + t * dy, t };
}
/** 点到圆弧距离 */
export function distPointArc(p, cx, cy, r, start, end) {
  const a = Math.atan2(p.y - cy, p.x - cx);
  const radial = Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
  if (angleInRange(a, start, end)) return radial;
  const e1 = { x: cx + r * Math.cos(start), y: cy + r * Math.sin(start) };
  const e2 = { x: cx + r * Math.cos(end), y: cy + r * Math.sin(end) };
  return Math.min(radial, dist(p, e1), dist(p, e2));
}
/** 由弦两端点与凸度求圆弧（bulge = tan(θ/4)，正为逆时针） */
export function arcFromBulge(p1, p2, bulge) {
  const alpha = 4 * Math.atan(bulge);
  if (Math.abs(alpha) < 1e-9) return null;
  const d = dist(p1, p2);
  const r = d / (2 * Math.sin(Math.abs(alpha) / 2));
  const phi = angleOf(p1, p2);
  const h = d / (2 * Math.tan(Math.abs(alpha) / 2));
  const side = alpha > 0 ? phi + Math.PI / 2 : phi - Math.PI / 2;
  const cx = (p1.x + p2.x) / 2 + Math.cos(side) * h;
  const cy = (p1.y + p2.y) / 2 + Math.sin(side) * h;
  const start = Math.atan2(p1.y - cy, p1.x - cx);
  let end = Math.atan2(p2.y - cy, p2.x - cx);
  if (alpha > 0) { while (end <= start) end += TAU; }
  else { while (end >= start) end -= TAU; }
  return { cx, cy, r, startAngle: start, endAngle: end, ccw: alpha > 0 };
}
/** 圆弧 → 凸度 */
export function bulgeFromArc(piece) {
  let sweep = piece.ccw ? arcSweep(piece.startAngle, piece.endAngle) : arcSweep(piece.endAngle, piece.startAngle);
  if (sweep > Math.PI) sweep -= TAU; // 半圆以上符号约定保持一致
  return piece.ccw ? Math.tan(sweep / 4) : -Math.tan(sweep / 4);
}
/** 圆弧采样点 */
export function sampleArcPoints(cx, cy, r, start, end, ccw, n = 32) {
  const pts = [];
  let sweep = ccw ? end - start : start - end;
  if (sweep <= 0) sweep += TAU;
  sweep = Math.min(Math.abs(sweep), TAU);
  for (let i = 0; i <= n; i++) {
    const a = ccw ? start + (sweep * i) / n : start - (sweep * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}
/** 椭圆采样点（世界坐标） */
export function sampleEllipsePoints(cx, cy, rx, ry, rot, start, end, n = 40) {
  const pts = [];
  const span = (end ?? TAU) - (start ?? 0);
  for (let i = 0; i <= n; i++) {
    const t = (start ?? 0) + (span * i) / n;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    pts.push({ x: cx + x * Math.cos(rot) - y * Math.sin(rot), y: cy + x * Math.sin(rot) + y * Math.cos(rot) });
  }
  return pts;
}

/* ---------------- 仿射矩阵 ---------------- */
// [x']   [a c e] [x]
// [y'] = [b d f] [y]
export function applyM(m, p) {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}
/** outer ∘ inner：先应用 inner 再应用 outer */
export function composeM(outer, inner) {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}
export const identityM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
export const translationM = (dx, dy) => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
export function rotationM(ang, cx = 0, cy = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const R = { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
  return composeM(translationM(cx, cy), composeM(R, translationM(-cx, -cy)));
}
export function scaleM(sx, sy = sx, cx = 0, cy = 0) {
  const S = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
  return composeM(translationM(cx, cy), composeM(S, translationM(-cx, -cy)));
}
/** 关于过 p1 方向角 a 的直线的镜像 */
export function mirrorM(p1, p2) {
  const a = angleOf(p1, p2);
  const c = Math.cos(2 * a), s = Math.sin(2 * a);
  const M = { a: c, b: s, c: s, d: -c, e: 0, f: 0 };
  return composeM(translationM(p1.x, p1.y), composeM(M, translationM(-p1.x, -p1.y)));
}
export function matrixScale(m) { return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); }
export function matrixRotation(m) { return Math.atan2(m.b, m.a); }
export function matrixMirrored(m) { return m.a * m.d - m.b * m.c < 0; }
export function matrixScaleXY(m) {
  return { sx: Math.hypot(m.a, m.b), sy: Math.hypot(m.c, m.d) };
}

/* ---------------- 包围盒 ---------------- */
export function bboxUnion(bb1, bb2) {
  if (!bb1) return bb2 ? [...bb2] : null;
  if (!bb2) return [...bb1];
  return [
    Math.min(bb1[0], bb2[0]), Math.min(bb1[1], bb2[1]),
    Math.max(bb1[2], bb2[2]), Math.max(bb1[3], bb2[3]),
  ];
}
export function bboxOfPoints(pts) {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1, y1];
}
export function bboxExpand(bb, d) {
  if (!bb) return null;
  return [bb[0] - d, bb[1] - d, bb[2] + d, bb[3] + d];
}
export function bboxContains(bb, p) {
  return bb && p.x >= bb[0] && p.x <= bb[2] && p.y >= bb[1] && p.y <= bb[3];
}
export function bboxIntersects(b1, b2) {
  if (!b1 || !b2) return false;
  return !(b1[2] < b2[0] || b1[0] > b2[2] || b1[3] < b2[1] || b1[1] > b2[3]);
}
/** 点是否在多边形内（射线法） */
export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (((a.y > p.y) !== (b.y > p.y)) &&
      (p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)) inside = !inside;
  }
  return inside;
}
/** 三点圆（外接圆），返回 {cx,cy,r} 或 null */
export function circleThrough3(p1, p2, p3, tol = 1e-9) {
  const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
  if (Math.abs(d) < tol) return null;
  const p1s = p1.x * p1.x + p1.y * p1.y, p2s = p2.x * p2.x + p2.y * p2.y, p3s = p3.x * p3.x + p3.y * p3.y;
  const cx = (p1s * (p2.y - p3.y) + p2s * (p3.y - p1.y) + p3s * (p1.y - p2.y)) / d;
  const cy = (p1s * (p3.x - p2.x) + p2s * (p1.x - p3.x) + p3s * (p2.x - p1.x)) / d;
  return { cx, cy, r: Math.hypot(p1.x - cx, p1.y - cy) };
}
/** 两无限直线交点 */
export function lineLineIntersection(p1, p2, p3, p4, tol = 1e-9) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < tol) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}
export function projectOnLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  return { x: a.x + t * dx, y: a.y + t * dy, t };
}
/** 多段线凸度段扁平化（采样为折线点列） */
export function flattenPolyline(points, bulges) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    out.push(p1);
    const b = (bulges && bulges[i]) || 0;
    if (Math.abs(b) > 1e-6 && i + 1 < points.length) {
      const arc = arcFromBulge(p1, points[i + 1], b);
      if (arc) {
        const pts = sampleArcPoints(arc.cx, arc.cy, arc.r, arc.startAngle, arc.endAngle, arc.ccw, 24);
        out.push(...pts.slice(1, -1));
      }
    }
  }
  return out;
}
export function polylineLength(points, bulges) {
  const pts = flattenPolyline(points, bulges);
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}
