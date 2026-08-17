/* ============================================================
 * 小宝CAD 实体系统 —— 所有图元类型、绘制/捕捉/变换/求交
 * 实体均为纯数据对象：{ id, type, layer, color, ltype, lw, ...几何 }
 * ============================================================ */
import {
  uid, TAU, EPS, deepClone, dist, angleOf, applyM, composeM, translationM, rotationM,
  scaleM, matrixScale, matrixRotation, matrixMirrored, matrixScaleXY, segSegIntersection,
  lineCircleIntersections, circleCircleIntersections, angleInRange, arcSweep, normAngle,
  distPointSeg, distPointArc, nearestOnSeg, arcFromBulge, bboxOfPoints, bboxUnion,
  bboxContains, pointInPolygon, sampleArcPoints, sampleEllipsePoints, flattenPolyline, fmt,
} from './util.js';

/* ---------------- 创建 ---------------- */
export function newEntity(type, fields = {}) {
  return { id: uid(), type, layer: null, color: null, ltype: null, lw: null, ...fields };
}
export const make = {
  line: (p1, p2, o = {}) => newEntity('line', { ...o, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }),
  circle: (c, r, o = {}) => newEntity('circle', { ...o, cx: c.x, cy: c.y, r }),
  arc: (c, r, startAngle, endAngle, o = {}) => newEntity('arc', { ...o, cx: c.x, cy: c.y, r, startAngle, endAngle, ccw: o.ccw !== false }),
  ellipse: (c, rx, ry, rot = 0, o = {}) => newEntity('ellipse', { ...o, cx: c.x, cy: c.y, rx, ry, rot }),
  point: (p, o = {}) => newEntity('point', { ...o, x: p.x, y: p.y }),
  polyline: (points, o = {}) => newEntity('polyline', { ...o, points: points.map((p) => ({ x: p.x, y: p.y, bulge: p.bulge || 0 })), closed: !!o.closed }),
  rectangle: (c1, c2, o = {}) => make.polyline([
    { x: c1.x, y: c1.y }, { x: c2.x, y: c1.y }, { x: c2.x, y: c2.y }, { x: c1.x, y: c2.y },
  ], { ...o, closed: true }),
  text: (p, str, height, rotation = 0, o = {}) => newEntity('text', { ...o, x: p.x, y: p.y, text: str, height, rotation, halign: o.halign || 'left', valign: o.valign || 'baseline' }),
  insert: (block, p, o = {}) => newEntity('insert', { ...o, block, x: p.x, y: p.y, scaleX: o.scaleX ?? 1, scaleY: o.scaleY ?? 1, rotation: o.rotation || 0 }),
};
export const entityCopy = (e) => deepClone(e);

/* ---------------- 图元处理器注册表 ---------------- */
export const HANDLERS = {};

function linePoints(e) { return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }]; }

/* ---------- point ---------- */
HANDLERS.point = {
  bbox: (e) => [e.x, e.y, e.x, e.y],
  distance: (e, p) => dist(p, { x: e.x, y: e.y }),
  contains: () => false,
  snap: (e, p, tol) => (dist(p, { x: e.x, y: e.y }) <= tol ? [{ x: e.x, y: e.y, type: 'node' }] : []),
  draw(dc, e, opts) {
    dc.marker(e, opts, e.x, e.y, 'point');
  },
  transform: (e, m) => {
    const p = applyM(m, { x: e.x, y: e.y });
    return { ...e, x: p.x, y: p.y };
  },
  props: () => [],
};

/* ---------- line ---------- */
HANDLERS.line = {
  bbox: (e) => bboxOfPoints(linePoints(e)),
  distance: (e, p) => distPointSeg(p, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }),
  contains: () => false,
  snap(e, p, tol) {
    const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
    const out = [];
    if (dist(p, a) <= tol) out.push({ x: a.x, y: a.y, type: 'endpoint' });
    if (dist(p, b) <= tol) out.push({ x: b.x, y: b.y, type: 'endpoint' });
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (dist(p, mid) <= tol) out.push({ x: mid.x, y: mid.y, type: 'midpoint' });
    const n = nearestOnSeg(p, a, b);
    if (dist(p, n) <= tol) out.push({ x: n.x, y: n.y, type: 'nearest' });
    return out;
  },
  draw(dc, e, opts) {
    dc.stroke(e, opts, (ctx) => {
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
    });
  },
  transform: (e, m) => {
    const p1 = applyM(m, { x: e.x1, y: e.y1 }), p2 = applyM(m, { x: e.x2, y: e.y2 });
    return { ...e, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  },
  props: () => [],
};

/* ---------- circle ---------- */
HANDLERS.circle = {
  bbox: (e) => [e.cx - e.r, e.cy - e.r, e.cx + e.r, e.cy + e.r],
  distance: (e, p) => Math.abs(dist(p, { x: e.cx, y: e.cy }) - e.r),
  contains: (e, p) => dist(p, { x: e.cx, y: e.cy }) <= e.r + EPS,
  snap(e, p, tol) {
    const out = [];
    const c = { x: e.cx, y: e.cy };
    if (dist(p, c) <= tol) out.push({ x: c.x, y: c.y, type: 'center' });
    for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const q = { x: c.x + e.r * Math.cos(a), y: c.y + e.r * Math.sin(a) };
      if (dist(p, q) <= tol) out.push({ x: q.x, y: q.y, type: 'quadrant' });
    }
    const a = Math.atan2(p.y - c.y, p.x - c.x);
    const q = { x: c.x + e.r * Math.cos(a), y: c.y + e.r * Math.sin(a) };
    if (dist(p, q) <= tol) out.push({ x: q.x, y: q.y, type: 'nearest' });
    return out;
  },
  draw(dc, e, opts) {
    dc.stroke(e, opts, (ctx) => {
      ctx.moveTo(e.cx + e.r, e.cy);
      ctx.arc(e.cx, e.cy, e.r, 0, TAU);
    });
  },
  transform(e, m) {
    const p = applyM(m, { x: e.cx, y: e.cy });
    const { sx, sy } = matrixScaleXY(m);
    const mirrored = matrixMirrored(m);
    if (Math.abs(sx - sy) < 1e-9) {
      return { ...e, cx: p.x, cy: p.y, r: e.r * sx };
    }
    // 非等比缩放 → 椭圆
    const rot = Math.atan2(m.b, m.a);
    return { ...e, type: 'ellipse', cx: p.x, cy: p.y, rx: e.r * sx, ry: e.r * sy, rot: mirrored ? -rot : rot };
  },
  props: (e) => [{ key: 'r', label: '半径', type: 'number', get: () => e.r, set: (v) => { e.r = v; } }],
};

/* ---------- arc ---------- */
function arcEnds(e) {
  return [
    { x: e.cx + e.r * Math.cos(e.startAngle), y: e.cy + e.r * Math.sin(e.startAngle) },
    { x: e.cx + e.r * Math.cos(e.endAngle), y: e.cy + e.r * Math.sin(e.endAngle) },
  ];
}
function arcMid(e) {
  const a = e.ccw ? e.startAngle + arcSweep(e.startAngle, e.endAngle) / 2 : e.startAngle - arcSweep(e.endAngle, e.startAngle) / 2;
  return { x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) };
}
HANDLERS.arc = {
  bbox(e) {
    const pts = [arcEnds(e)[0], arcEnds(e)[1]];
    if (e.ccw ? angleInRange(0, e.startAngle, e.endAngle) : angleInRange(0, e.endAngle, e.startAngle)) pts.push({ x: e.cx + e.r, y: e.cy });
    if (e.ccw ? angleInRange(Math.PI / 2, e.startAngle, e.endAngle) : angleInRange(Math.PI / 2, e.endAngle, e.startAngle)) pts.push({ x: e.cx, y: e.cy + e.r });
    if (e.ccw ? angleInRange(Math.PI, e.startAngle, e.endAngle) : angleInRange(Math.PI, e.endAngle, e.startAngle)) pts.push({ x: e.cx - e.r, y: e.cy });
    if (e.ccw ? angleInRange((3 * Math.PI) / 2, e.startAngle, e.endAngle) : angleInRange((3 * Math.PI) / 2, e.endAngle, e.startAngle)) pts.push({ x: e.cx, y: e.cy - e.r });
    return bboxOfPoints(pts);
  },
  distance: (e, p) => distPointArc(p, e.cx, e.cy, e.r, e.startAngle, e.endAngle),
  contains: () => false,
  snap(e, p, tol) {
    const out = [];
    const c = { x: e.cx, y: e.cy };
    if (dist(p, c) <= tol) out.push({ x: c.x, y: c.y, type: 'center' });
    for (const q of arcEnds(e)) if (dist(p, q) <= tol) out.push({ x: q.x, y: q.y, type: 'endpoint' });
    const mid = arcMid(e);
    if (dist(p, mid) <= tol) out.push({ x: mid.x, y: mid.y, type: 'midpoint' });
    const a = Math.atan2(p.y - c.y, p.x - c.x);
    if ((e.ccw ? angleInRange(a, e.startAngle, e.endAngle) : angleInRange(a, e.endAngle, e.startAngle))) {
      const q = { x: c.x + e.r * Math.cos(a), y: c.y + e.r * Math.sin(a) };
      if (dist(p, q) <= tol) out.push({ x: q.x, y: q.y, type: 'nearest' });
    }
    return out;
  },
  draw(dc, e, opts) {
    dc.stroke(e, opts, (ctx) => {
      ctx.arc(e.cx, e.cy, e.r, e.startAngle, e.endAngle, !e.ccw);
    });
  },
  transform(e, m) {
    const p = applyM(m, { x: e.cx, y: e.cy });
    const { sx, sy } = matrixScaleXY(m);
    if (Math.abs(sx - sy) < 1e-9) {
      const [s0, s1] = arcEnds(e), mid = arcMid(e);
      const t0 = applyM(m, s0), t1 = applyM(m, s1), tm = applyM(m, mid);
      const start = Math.atan2(t0.y - p.y, t0.x - p.x);
      const end = Math.atan2(t1.y - p.y, t1.x - p.x);
      const ccw = angleInRange(Math.atan2(tm.y - p.y, tm.x - p.x), start, end);
      return { ...e, cx: p.x, cy: p.y, r: e.r * sx, startAngle: start, endAngle: end, ccw };
    }
    // 非等比 → 采样为多段线
    const pts = sampleArcPoints(e.cx, e.cy, e.r, e.startAngle, e.endAngle, e.ccw, 48).map((q) => applyM(m, q));
    return { ...e, type: 'polyline', points: pts.map((q) => ({ x: q.x, y: q.y, bulge: 0 })), closed: false };
  },
  props: (e) => [{ key: 'r', label: '半径', type: 'number', get: () => e.r, set: (v) => { e.r = v; } }],
};

/* ---------- ellipse ---------- */
HANDLERS.ellipse = {
  bbox(e) {
    const pts = sampleEllipsePoints(e.cx, e.cy, e.rx, e.ry, e.rot, e.startAngle, e.endAngle, 48);
    return bboxOfPoints(pts);
  },
  distance(e, p) {
    let d = Infinity;
    const pts = sampleEllipsePoints(e.cx, e.cy, e.rx, e.ry, e.rot, e.startAngle, e.endAngle, 48);
    for (const q of pts) d = Math.min(d, dist(p, q));
    return d;
  },
  contains(e, p) {
    const dx = p.x - e.cx, dy = p.y - e.cy, c = Math.cos(e.rot), s = Math.sin(e.rot);
    const u = (dx * c + dy * s) / e.rx, v = (-dx * s + dy * c) / e.ry;
    return u * u + v * v <= 1 + EPS;
  },
  snap(e, p, tol) {
    const out = [];
    const c = { x: e.cx, y: e.cy };
    if (dist(p, c) <= tol) out.push({ x: c.x, y: c.y, type: 'center' });
    for (const q of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const t = e.rot + q;
      const pt = { x: e.cx + e.rx * Math.cos(t) * Math.cos(e.rot) - e.ry * Math.sin(t) * Math.sin(e.rot), y: e.cy + e.rx * Math.cos(t) * Math.sin(e.rot) + e.ry * Math.sin(t) * Math.cos(e.rot) };
      if (dist(p, pt) <= tol) out.push({ x: pt.x, y: pt.y, type: 'quadrant' });
    }
    return out;
  },
  draw(dc, e, opts) {
    dc.stroke(e, opts, (ctx) => {
      const s = e.startAngle ?? 0, en = e.endAngle ?? TAU;
      ctx.ellipse(e.cx, e.cy, e.rx, e.ry, e.rot, s, en);
    });
  },
  transform(e, m) {
    const p = applyM(m, { x: e.cx, y: e.cy });
    const rot = Math.atan2(m.b * Math.cos(e.rot) + m.d * Math.sin(e.rot), m.a * Math.cos(e.rot) + m.c * Math.sin(e.rot));
    const rx = e.rx * Math.hypot(m.a * Math.cos(e.rot) + m.c * Math.sin(e.rot), m.b * Math.cos(e.rot) + m.d * Math.sin(e.rot));
    const ry = e.ry * Math.hypot(m.a * -Math.sin(e.rot) + m.c * Math.cos(e.rot), m.b * -Math.sin(e.rot) + m.d * Math.cos(e.rot));
    if (e.startAngle !== undefined || e.endAngle !== undefined) {
      const pts = sampleEllipsePoints(e.cx, e.cy, e.rx, e.ry, e.rot, e.startAngle, e.endAngle, 48).map((q) => applyM(m, q));
      return { ...e, type: 'polyline', points: pts.map((q) => ({ x: q.x, y: q.y, bulge: 0 })), closed: false };
    }
    return { ...e, cx: p.x, cy: p.y, rx, ry, rot };
  },
  props: (e) => [
    { key: 'rx', label: '长半径', type: 'number', get: () => e.rx, set: (v) => { e.rx = v; } },
    { key: 'ry', label: '短半径', type: 'number', get: () => e.ry, set: (v) => { e.ry = v; } },
  ],
};

/* ---------- polyline ---------- */
function plineSegs(e) {
  const segs = [];
  const n = e.points.length;
  if (n < 2) return segs;
  const count = e.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p1 = e.points[i], p2 = e.points[(i + 1) % n];
    segs.push({ p1, p2, bulge: p1.bulge || 0 });
  }
  return segs;
}
HANDLERS.polyline = {
  bbox(e) {
    const pts = e.points.map((p) => ({ x: p.x, y: p.y }));
    for (const s of plineSegs(e)) {
      if (Math.abs(s.bulge) > 1e-6) {
        const arc = arcFromBulge(s.p1, s.p2, s.bulge);
        if (arc) pts.push(...sampleArcPoints(arc.cx, arc.cy, arc.r, arc.startAngle, arc.endAngle, arc.ccw, 16));
      }
    }
    return bboxOfPoints(pts);
  },
  distance(e, p) {
    let d = Infinity;
    for (const s of plineSegs(e)) {
      if (Math.abs(s.bulge) > 1e-6) {
        const arc = arcFromBulge(s.p1, s.p2, s.bulge);
        if (arc) d = Math.min(d, distPointArc(p, arc.cx, arc.cy, arc.r, arc.startAngle, arc.endAngle));
      } else d = Math.min(d, distPointSeg(p, s.p1, s.p2));
    }
    return d;
  },
  contains(e, p) {
    if (!e.closed || e.points.length < 3) return false;
    return pointInPolygon(p, flattenPolyline(e.points.map((q) => ({ x: q.x, y: q.y })), e.points.map((q) => q.bulge)));
  },
  snap(e, p, tol) {
    const out = [];
    for (const s of plineSegs(e)) {
      if (dist(p, s.p1) <= tol) out.push({ x: s.p1.x, y: s.p1.y, type: 'endpoint' });
      if (Math.abs(s.bulge) > 1e-6) {
        const arc = arcFromBulge(s.p1, s.p2, s.bulge);
        if (arc) {
          const mid = arcMid({ cx: arc.cx, cy: arc.cy, r: arc.r, startAngle: arc.startAngle, endAngle: arc.endAngle, ccw: arc.ccw });
          if (dist(p, mid) <= tol) out.push({ x: mid.x, y: mid.y, type: 'midpoint' });
          if (dist(p, { x: arc.cx, y: arc.cy }) <= tol) out.push({ x: arc.cx, y: arc.cy, type: 'center' });
        }
      } else {
        const mid = { x: (s.p1.x + s.p2.x) / 2, y: (s.p1.y + s.p2.y) / 2 };
        if (dist(p, mid) <= tol) out.push({ x: mid.x, y: mid.y, type: 'midpoint' });
      }
      const n = nearestOnSeg(p, s.p1, s.p2);
      if (dist(p, n) <= tol) out.push({ x: n.x, y: n.y, type: 'nearest' });
    }
    return out;
  },
  draw(dc, e, opts) {
    dc.stroke(e, opts, (ctx) => {
      const pts = e.points;
      ctx.moveTo(pts[0].x, pts[0].y);
      const n = e.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
        const b = p1.bulge || 0;
        if (Math.abs(b) > 1e-6) {
          const arc = arcFromBulge(p1, p2, b);
          if (arc) ctx.arc(arc.cx, arc.cy, arc.r, arc.startAngle, arc.endAngle, !arc.ccw);
          else ctx.lineTo(p2.x, p2.y);
        } else ctx.lineTo(p2.x, p2.y);
      }
      if (e.closed) ctx.closePath();
    });
  },
  transform(e, m) {
    const { sx, sy } = matrixScaleXY(m);
    const uniform = Math.abs(sx - sy) < 1e-9;
    const mirrored = matrixMirrored(m);
    const points = e.points.map((p) => {
      const q = applyM(m, { x: p.x, y: p.y });
      let bulge = p.bulge || 0;
      if (uniform && mirrored) bulge = -bulge;
      if (!uniform && Math.abs(bulge) > 1e-6) {
        // 非等比：弧段采样为直线
        const arc = arcFromBulge({ x: p.x, y: p.y }, { x: e.points[e.points.indexOf(p) + 1]?.x, y: e.points[e.points.indexOf(p) + 1]?.y }, bulge);
        if (arc) bulge = 0;
      }
      return { x: q.x, y: q.y, bulge };
    });
    if (!uniform && e.points.some((p) => Math.abs(p.bulge || 0) > 1e-6)) {
      // 全部弧段采样扁平化
      const flat = [];
      for (let i = 0; i < e.points.length; i++) {
        const p1 = e.points[i], p2 = e.points[(i + 1) % e.points.length];
        flat.push(applyM(m, { x: p1.x, y: p1.y }));
        const b = p1.bulge || 0;
        if (Math.abs(b) > 1e-6 && (i + 1 < e.points.length || e.closed)) {
          const arc = arcFromBulge(p1, p2, b);
          if (arc) {
            const pts = sampleArcPoints(arc.cx, arc.cy, arc.r, arc.startAngle, arc.endAngle, arc.ccw, 24).map((q) => applyM(m, q));
            flat.push(...pts.slice(1, -1));
          }
        }
      }
      return { ...e, points: flat.map((q) => ({ x: q.x, y: q.y, bulge: 0 })) };
    }
    return { ...e, points };
  },
  props: (e) => [{ key: 'closed', label: '闭合', type: 'bool', get: () => !!e.closed, set: (v) => { e.closed = v; } }],
};

/* ---------- text ---------- */
function textBox(e) {
  const w = e.height * 0.6 * String(e.text || '').length;
  const h = e.height;
  let x0 = e.x, y0 = e.y;
  if (e.halign === 'center') x0 -= w / 2;
  else if (e.halign === 'right') x0 -= w;
  if (e.valign === 'middle') y0 -= h / 2;
  else if (e.valign === 'top') y0 -= h;
  else if (e.valign === 'bottom') { /* 基线下方 */ }
  return [x0, y0, x0 + w, y0 + h];
}
HANDLERS.text = {
  bbox: (e) => textBox(e),
  distance(e, p) {
    const bb = textBox(e);
    if (bboxContains(bb, p)) return 0;
    const cx = clampToBox(p.x, bb[0], bb[2]), cy = clampToBox(p.y, bb[1], bb[3]);
    return dist(p, { x: cx, y: cy });
  },
  contains: () => false,
  snap: (e, p, tol) => (dist(p, { x: e.x, y: e.y }) <= tol ? [{ x: e.x, y: e.y, type: 'node' }] : []),
  draw(dc, e, opts) {
    dc.text(e, opts, String(e.text ?? ''), e.x, e.y, e.height, e.rotation || 0, e.halign || 'left', e.valign || 'baseline');
  },
  transform(e, m) {
    const p = applyM(m, { x: e.x, y: e.y });
    const mirrored = matrixMirrored(m);
    let halign = e.halign;
    if (mirrored && (halign === 'left' || halign === 'right')) halign = halign === 'left' ? 'right' : 'left';
    return { ...e, x: p.x, y: p.y, height: e.height * matrixScale(m), rotation: (e.rotation || 0) + matrixRotation(m), halign };
  },
  props: (e) => [
    { key: 'text', label: '内容', type: 'text', get: () => e.text, set: (v) => { e.text = v; } },
    { key: 'height', label: '字高', type: 'number', get: () => e.height, set: (v) => { e.height = v; } },
    { key: 'rotation', label: '旋转°', type: 'number', get: () => ((e.rotation || 0) * 180) / Math.PI, set: (v) => { e.rotation = (v * Math.PI) / 180; } },
  ],
};
function clampToBox(v, a, b) { return v < a ? a : v > b ? b : v; }

/* ---------- insert (块引用) ---------- */
function insertMatrix(e) {
  const b = { baseX: 0, baseY: 0 };
  return composeM(rotationM(e.rotation || 0, e.x, e.y), composeM(scaleM(e.scaleX ?? 1, e.scaleY ?? 1, e.x, e.y), translationM(e.x - b.baseX, e.y - b.baseY)));
}
HANDLERS.insert = {
  bbox(e, scene) {
    const blk = scene?.blocks?.get(e.block);
    if (!blk) return [e.x, e.y, e.x, e.y];
    let bb = null;
    for (const be of blk.entities.values()) {
      const t = transformEntity(be, insertMatrix(e));
      if (t.__explode) continue;
      bb = bboxUnion(bb, HANDLERS[t.type]?.bbox?.(t));
    }
    return bb;
  },
  distance(e, p, scene) {
    const blk = scene?.blocks?.get(e.block);
    if (!blk) return dist(p, { x: e.x, y: e.y });
    let d = Infinity;
    for (const be of blk.entities.values()) {
      const t = transformEntity(be, insertMatrix(e));
      if (t.__explode) continue;
      const dd = HANDLERS[t.type]?.distance?.(t, p);
      if (dd != null) d = Math.min(d, dd);
    }
    return d;
  },
  contains: () => false,
  snap: (e, p, tol) => (dist(p, { x: e.x, y: e.y }) <= tol ? [{ x: e.x, y: e.y, type: 'node' }] : []),
  draw(dc, e, opts) {
    const blk = dc.scene?.blocks?.get(e.block);
    if (!blk) return;
    const m = insertMatrix(e);
    for (const be of blk.entities.values()) {
      const t = transformEntity(be, m);
      if (t.__explode) continue;
      if (t.layer === '0' || t.layer == null) t.layer = e.layer;
      if (t.color == null) t.color = e.color;
      dc.drawEntity(t, { ...opts, nested: true });
    }
  },
  transform(e, m) {
    const p = applyM(m, { x: e.x, y: e.y });
    const { sx, sy } = matrixScaleXY(m);
    const rot = matrixRotation(m);
    const mirrored = matrixMirrored(m);
    if (Math.abs(sx - sy) < 1e-9 && !mirrored) {
      return { ...e, x: p.x, y: p.y, rotation: (e.rotation || 0) + rot, scaleX: (e.scaleX ?? 1) * sx, scaleY: (e.scaleY ?? 1) * sy };
    }
    return { __explode: composeM(m, insertMatrix(e)) };
  },
  props: (e, scene) => {
    const names = [...(scene?.blocks?.keys?.() || [])];
    return [
      { key: 'block', label: '块名', type: 'select', options: names, get: () => e.block, set: (v) => { e.block = v; } },
      { key: 'scaleX', label: 'X比例', type: 'number', get: () => e.scaleX ?? 1, set: (v) => { e.scaleX = v; } },
      { key: 'scaleY', label: 'Y比例', type: 'number', get: () => e.scaleY ?? 1, set: (v) => { e.scaleY = v; } },
      { key: 'rotation', label: '旋转°', type: 'number', get: () => ((e.rotation || 0) * 180) / Math.PI, set: (v) => { e.rotation = (v * Math.PI) / 180; } },
    ];
  },
};

/* ---------- dimension ---------- */
HANDLERS.dimension = {
  bbox(e) {
    const pts = [];
    if (e.subtype === 'linear') pts.push({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: e.x3, y: e.y3 });
    else if (e.subtype === 'radial' || e.subtype === 'diametric') pts.push({ x: e.cx, y: e.cy }, { x: e.px, y: e.py }, { x: e.tx, y: e.ty });
    else if (e.subtype === 'angular') pts.push({ x: e.cx, y: e.cy }, { x: e.a1x, y: e.a1y }, { x: e.a2x, y: e.a2y }, { x: e.tx, y: e.ty });
    return bboxOfPoints(pts);
  },
  distance(e, p) {
    const bb = HANDLERS.dimension.bbox(e);
    if (!bb) return Infinity;
    if (bboxContains(bb, p)) return 0;
    const cx = clampToBox(p.x, bb[0], bb[2]), cy = clampToBox(p.y, bb[1], bb[3]);
    return dist(p, { x: cx, y: cy });
  },
  contains: () => false,
  snap(e, p, tol) {
    const out = [];
    const pts = [];
    if (e.subtype === 'linear') pts.push({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: e.x3, y: e.y3 });
    else if (e.subtype === 'radial' || e.subtype === 'diametric') pts.push({ x: e.cx, y: e.cy }, { x: e.px, y: e.py });
    else if (e.subtype === 'angular') pts.push({ x: e.cx, y: e.cy }, { x: e.a1x, y: e.a1y }, { x: e.a2x, y: e.a2y });
    for (const q of pts) if (dist(p, q) <= tol) out.push({ x: q.x, y: q.y, type: 'node' });
    return out;
  },
  draw(dc, e, opts) { dc.drawDimension(e, opts); },
  transform(e, m) {
    const T = (p) => { const q = applyM(m, p); return q; };
    if (e.subtype === 'linear') {
      const p1 = T({ x: e.x1, y: e.y1 }), p2 = T({ x: e.x2, y: e.y2 }), p3 = T({ x: e.x3, y: e.y3 });
      return { ...e, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: p3.x, y3: p3.y, angle: (e.angle || 0) + matrixRotation(m) };
    }
    if (e.subtype === 'radial' || e.subtype === 'diametric') {
      const c = T({ x: e.cx, y: e.cy }), p = T({ x: e.px, y: e.py }), t = T({ x: e.tx, y: e.ty });
      return { ...e, cx: c.x, cy: c.y, px: p.x, py: p.y, tx: t.x, ty: t.y };
    }
    if (e.subtype === 'angular') {
      const c = T({ x: e.cx, y: e.cy }), a1 = T({ x: e.a1x, y: e.a1y }), a2 = T({ x: e.a2x, y: e.a2y }), t = T({ x: e.tx, y: e.ty });
      return { ...e, cx: c.x, cy: c.y, a1x: a1.x, a1y: a1.y, a2x: a2.x, a2y: a2.y, tx: t.x, ty: t.y };
    }
    return deepClone(e);
  },
  props: () => [],
};

/* ---------- hatch ---------- */
HANDLERS.hatch = {
  bbox(e) {
    const b = e.boundary;
    if (!b) return null;
    if (b.kind === 'circle') return [b.cx - b.r, b.cy - b.r, b.cx + b.r, b.cy + b.r];
    return bboxOfPoints(b.points);
  },
  distance(e, p) {
    if (HANDLERS.hatch.contains(e, p)) return 0;
    const b = e.boundary;
    if (!b) return Infinity;
    if (b.kind === 'circle') return Math.abs(dist(p, { x: b.cx, y: b.cy }) - b.r);
    if (b.points.length < 2) return Infinity;
    let d = Infinity;
    for (let i = 0; i < b.points.length; i++) {
      const a = b.points[i], c = b.points[(i + 1) % b.points.length];
      d = Math.min(d, distPointSeg(p, a, c));
    }
    return d;
  },
  contains(e, p) {
    const b = e.boundary;
    if (!b) return false;
    if (b.kind === 'circle') return dist(p, { x: b.cx, y: b.cy }) <= b.r + EPS;
    if (b.kind === 'ellipse') {
      const dx = p.x - b.cx, dy = p.y - b.cy, c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
      const u = (dx * c + dy * s) / b.rx, v = (-dx * s + dy * c) / b.ry;
      return u * u + v * v <= 1 + EPS;
    }
    return b.points.length >= 3 && pointInPolygon(p, b.points);
  },
  snap: () => [],
  draw(dc, e, opts) {
    const b = e.boundary;
    if (!b) return;
    dc.fillHatch(e, opts, (ctx) => {
      if (b.kind === 'circle') {
        ctx.moveTo(b.cx + b.r, b.cy);
        ctx.arc(b.cx, b.cy, b.r, 0, TAU);
      } else if (b.kind === 'ellipse') {
        ctx.ellipse(b.cx, b.cy, b.rx, b.ry, b.rot || 0, 0, TAU);
      } else {
        ctx.moveTo(b.points[0].x, b.points[0].y);
        for (let i = 1; i < b.points.length; i++) ctx.lineTo(b.points[i].x, b.points[i].y);
        ctx.closePath();
      }
    });
  },
  transform(e, m) {
    const b = deepClone(e.boundary);
    if (!b) return e;
    if (b.kind === 'circle') {
      const c = applyM(m, { x: b.cx, y: b.cy });
      const s = matrixScale(m);
      return { ...e, boundary: { kind: 'circle', cx: c.x, cy: c.y, r: b.r * s } };
    }
    if (b.points) {
      b.points = b.points.map((p) => applyM(m, p));
    }
    return { ...e, boundary: b };
  },
  props: (e) => [
    { key: 'solid', label: '实心', type: 'bool', get: () => !!e.solid, set: (v) => { e.solid = v; } },
    { key: 'spacing', label: '间距', type: 'number', get: () => e.spacing ?? 5, set: (v) => { e.spacing = v; } },
    { key: 'angle', label: '角度°', type: 'number', get: () => e.angle ?? 45, set: (v) => { e.angle = v; } },
  ],
};

export const ENTITY_TYPES = Object.keys(HANDLERS);

/* ---------------- 变换 ---------------- */
export function transformEntity(e, m) {
  const h = HANDLERS[e.type];
  if (!h || !h.transform) return deepClone(e);
  return h.transform(e, m);
}
export function entityBBox(e, scene) {
  const h = HANDLERS[e.type];
  return h?.bbox ? h.bbox(e, scene) : null;
}
export function entityDistance(e, p, scene) {
  const h = HANDLERS[e.type];
  return h?.distance ? h.distance(e, p, scene) : Infinity;
}
export function entityContains(e, p) {
  const h = HANDLERS[e.type];
  return h?.contains ? h.contains(e, p) : false;
}

/* ---------------- 曲线片段（用于求交/修剪/延伸） ---------------- */
// piece: {kind:'line'|'arc'|'circle'|'poly', ...}
export function entityCurves(e, scene) {
  const h = HANDLERS[e.type];
  if (!h) return [];
  if (e.type === 'line') return [{ kind: 'line', x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }];
  if (e.type === 'circle') return [{ kind: 'circle', cx: e.cx, cy: e.cy, r: e.r }];
  if (e.type === 'arc') return [{ kind: 'arc', cx: e.cx, cy: e.cy, r: e.r, startAngle: e.startAngle, endAngle: e.endAngle, ccw: e.ccw !== false }];
  if (e.type === 'polyline') {
    const out = [];
    const n = e.closed ? e.points.length : e.points.length - 1;
    for (let i = 0; i < n; i++) {
      const p1 = e.points[i], p2 = e.points[(i + 1) % e.points.length];
      const b = p1.bulge || 0;
      if (Math.abs(b) > 1e-6) {
        const arc = arcFromBulge(p1, p2, b);
        if (arc) out.push({ kind: 'arc', cx: arc.cx, cy: arc.cy, r: arc.r, startAngle: arc.startAngle, endAngle: arc.endAngle, ccw: arc.ccw });
        else out.push({ kind: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
      } else out.push({ kind: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    }
    return out;
  }
  if (e.type === 'ellipse') {
    const pts = sampleEllipsePoints(e.cx, e.cy, e.rx, e.ry, e.rot, e.startAngle, e.endAngle, 36);
    return [{ kind: 'poly', points: pts, closed: e.startAngle === undefined && e.endAngle === undefined }];
  }
  if (e.type === 'insert') {
    const blk = scene?.blocks?.get(e.block);
    if (!blk) return [];
    const m = insertMatrix(e);
    const out = [];
    for (const be of blk.entities.values()) {
      const t = transformEntity(be, m);
      if (!t.__explode) out.push(...entityCurves(t, scene));
    }
    return out;
  }
  return [];
}

export function pieceEndpoints(pc) {
  if (pc.kind === 'line') return [{ x: pc.x1, y: pc.y1 }, { x: pc.x2, y: pc.y2 }];
  if (pc.kind === 'arc') return [
    { x: pc.cx + pc.r * Math.cos(pc.startAngle), y: pc.cy + pc.r * Math.sin(pc.startAngle) },
    { x: pc.cx + pc.r * Math.cos(pc.endAngle), y: pc.cy + pc.r * Math.sin(pc.endAngle) },
  ];
  if (pc.kind === 'poly') return pc.points;
  return [];
}
/** 弧段扫过的角度区间（规范为 CCW [a0,a1]，跨度 ≤ 2π） */
export function pieceAngleRange(pc) {
  if (pc.kind === 'circle') return [0, TAU];
  if (pc.kind === 'arc') {
    if (pc.ccw) {
      const s = normAngle(pc.startAngle), e = normAngle(pc.endAngle);
      const span = arcSweep(pc.startAngle, pc.endAngle) || TAU;
      return [s, s + span];
    }
    const s = normAngle(pc.endAngle), e = normAngle(pc.startAngle);
    const span = arcSweep(pc.endAngle, pc.startAngle) || TAU;
    return [s, s + span];
  }
  return null;
}
export function angleOnPiece(pc, a) {
  const r = pieceAngleRange(pc);
  if (!r) return false;
  const x = normAngle(a);
  return x >= r[0] - 1e-9 && x <= r[1] + 1e-9;
}

export function piecePieceIntersections(a, b) {
  const out = [];
  const push = (p) => {
    if (p && out.every((q) => dist(q, p) > 1e-7)) out.push(p);
  };
  const LA = a.kind === 'line', LB = b.kind === 'line';
  const CA = a.kind === 'circle', CB = b.kind === 'circle';
  if (LA && LB) {
    const r = segSegIntersection({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 });
    if (r) push(r);
  } else if (LA && (CA || b.kind === 'arc')) {
    for (const r of lineCircleIntersections({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, b.cx, b.cy, b.r)) {
      if (r.t >= -1e-9 && r.t <= 1 + 1e-9 && (CB || angleOnPiece(b, Math.atan2(r.y - b.cy, r.x - b.cx)))) push(r);
    }
  } else if (LB && (CA || a.kind === 'arc')) {
    for (const r of lineCircleIntersections({ x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }, a.cx, a.cy, a.r)) {
      if (r.t >= -1e-9 && r.t <= 1 + 1e-9 && (CA || angleOnPiece(a, Math.atan2(r.y - a.cy, r.x - a.cx)))) push(r);
    }
  } else if ((CA || a.kind === 'arc') && (CB || b.kind === 'arc')) {
    for (const r of circleCircleIntersections({ x: a.cx, y: a.cy }, a.r, { x: b.cx, y: b.cy }, b.r)) {
      const angA = Math.atan2(r.y - a.cy, r.x - a.cx), angB = Math.atan2(r.y - b.cy, r.x - b.cx);
      if ((CA || angleOnPiece(a, angA)) && (CB || angleOnPiece(b, angB))) push(r);
    }
  } else {
    // 涉及椭圆采样折线
    const segsOf = (pc) => {
      if (pc.kind === 'poly') {
        const segs = [];
        for (let i = 0; i < pc.points.length - 1; i++) segs.push([pc.points[i], pc.points[i + 1]]);
        return segs;
      }
      if (pc.kind === 'line') return [[{ x: pc.x1, y: pc.y1 }, { x: pc.x2, y: pc.y2 }]];
      if (pc.kind === 'circle') return sampleArcPoints(pc.cx, pc.cy, pc.r, 0, TAU, true, 36).slice(0, -1).map((p, i, arr) => [p, arr[(i + 1) % arr.length]]);
      if (pc.kind === 'arc') return sampleArcPoints(pc.cx, pc.cy, pc.r, pc.startAngle, pc.endAngle, pc.ccw, 36).slice(0, -1).map((p, i, arr) => [p, arr[(i + 1) % arr.length]]);
      return [];
    };
    for (const [p1, p2] of segsOf(a)) {
      for (const [p3, p4] of segsOf(b)) {
        const r = segSegIntersection(p1, p2, p3, p4);
        if (r) push(r);
      }
    }
  }
  return out;
}
/** 两个实体的全部交点 */
export function entityIntersections(e1, e2, scene) {
  const out = [];
  for (const a of entityCurves(e1, scene)) {
    for (const b of entityCurves(e2, scene)) {
      out.push(...piecePieceIntersections(a, b));
    }
  }
  return out;
}

/* ---------------- 尺寸标注几何计算 ---------------- */
export function dimMeasure(e, dimstyle) {
  const p = dimstyle?.precision ?? 2;
  if (e.subtype === 'linear') {
    const ang = e.angle || 0;
    const d = { x: Math.cos(ang), y: Math.sin(ang) };
    const p3 = { x: e.x3, y: e.y3 };
    const q1 = { x: p3.x + d.x * ((e.x1 - p3.x) * d.x + (e.y1 - p3.y) * d.y), y: p3.y + d.y * ((e.x1 - p3.x) * d.x + (e.y1 - p3.y) * d.y) };
    const q2 = { x: p3.x + d.x * ((e.x2 - p3.x) * d.x + (e.y2 - p3.y) * d.y), y: p3.y + d.y * ((e.x2 - p3.x) * d.x + (e.y2 - p3.y) * d.y) };
    return { value: Math.abs(dist(q1, q2)), q1, q2, dir: d };
  }
  if (e.subtype === 'radial') return { value: dist({ x: e.cx, y: e.cy }, { x: e.px, y: e.py }) };
  if (e.subtype === 'diametric') return { value: 2 * dist({ x: e.cx, y: e.cy }, { x: e.px, y: e.py }) };
  if (e.subtype === 'angular') {
    const a1 = angleOf({ x: e.cx, y: e.cy }, { x: e.a1x, y: e.a1y });
    const a2 = angleOf({ x: e.cx, y: e.cy }, { x: e.a2x, y: e.a2y });
    const deg = (arcSweep(a1, a2) * 180) / Math.PI;
    return { value: deg > 180 ? 360 - deg : deg, deg: true };
  }
  return { value: 0 };
}
export function dimText(e, dimstyle) {
  const m = dimMeasure(e, dimstyle);
  if (m.deg) return `${fmt(m.value, dimstyle?.precision ?? 1)}°`;
  return `${fmt(m.value, dimstyle?.precision ?? 2)}`;
}
