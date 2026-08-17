/* ============================================================
 * 小宝CAD 绘图与修改工具 —— 所有绘图/编辑命令
 * ============================================================ */
import { CANCELLED, ENDED } from './commands.js';
import {
  HANDLERS, make, newEntity, entityCurves, entityIntersections, piecePieceIntersections,
  pieceEndpoints, pieceAngleRange, angleOnPiece, entityDistance, transformEntity,
} from './entities.js';
import { DrawContext } from './viewport.js';
import {
  D2R, R2D, TAU, dist, angleOf, polar, normAngle, arcSweep, clamp, fmt, deepClone,
  segSegIntersection, lineLineIntersection, lineCircleIntersections, circleCircleIntersections,
  projectOnLine, nearestOnSeg, distPointSeg, distPointArc, angleInRange, pointInPolygon,
  translationM, rotationM, scaleM, mirrorM, composeM, matrixScale, applyM, bboxOfPoints,
  flattenPolyline, sampleArcPoints, uid, EPS, bulgeFromArc,
} from './util.js';

const P = (x, y) => ({ x, y });
const samePoint = (a, b) => dist(a, b) < 1e-9;

/* ================= 通用辅助 ================= */
async function selOrPrompt(app, c, prompt = '选择对象:') {
  const scene = app.scene;
  if (scene.selection.size) return [...scene.selection];
  return pickMultiple(app, c, prompt);
}
async function pickMultiple(app, c, prompt) {
  const scene = app.scene;
  const ids = new Set();
  let step = '';
  while (true) {
    const p = await c.awaitPoint({ prompt: `${prompt}${step}` });
    if (p === CANCELLED) return null;
    if (p === ENDED) break;
    const ent = app.viewport.hitTest(app.viewport.worldToScreen(p), 10);
    if (ent) {
      ids.has(ent.id) ? ids.delete(ent.id) : ids.add(ent.id);
      scene.select([...ids], 'set');
      step = `（已选 ${ids.size}，回车结束）`;
    } else {
      const p2 = await c.awaitPoint({
        prompt: '指定对角点(窗选):', base: p,
        preview: (ctx, q) => drawWindow(ctx, app, p, q),
      });
      if (p2 === CANCELLED) return null;
      if (p2 === ENDED || !p2) break;
      const bb = [Math.min(p.x, p2.x), Math.min(p.y, p2.y), Math.max(p.x, p2.x), Math.max(p.y, p2.y)];
      const crossing = p2.x < p.x;
      for (const e of scene.all()) {
        const l = scene.layer(e.layer);
        if (!l?.on || l?.locked) continue;
        const eb = HANDLERS[e.type]?.bbox?.(e, scene);
        if (!eb) continue;
        const inside = eb[0] >= bb[0] && eb[1] >= bb[1] && eb[2] <= bb[2] && eb[3] <= bb[3];
        const overlap = !(eb[2] < bb[0] || eb[0] > bb[2] || eb[3] < bb[1] || eb[1] > bb[3]);
        if (crossing ? overlap : inside) ids.add(e.id);
      }
      scene.select([...ids], 'set');
      step = `（已选 ${ids.size}，回车结束）`;
    }
  }
  return [...ids];
}
function drawWindow(ctx, app, p1, p2) {
  const vp = app.viewport;
  const crossing = p2.x < p1.x;
  ctx.save();
  ctx.fillStyle = crossing ? 'rgba(126,224,138,.12)' : 'rgba(93,179,255,.12)';
  ctx.strokeStyle = crossing ? '#7ee08a' : '#5db3ff';
  ctx.lineWidth = 1.2 / vp.scale;
  ctx.setLineDash([6 / vp.scale, 4 / vp.scale]);
  ctx.beginPath();
  ctx.rect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
function ghostPreview(app, ids, buildMatrix) {
  return (ctx, cur) => {
    const vp = app.viewport;
    const m = buildMatrix(cur);
    if (!m) return;
    const dc = new DrawContext(vp, ctx);
    for (const id of ids) {
      const e = app.scene.get(id);
      if (!e) continue;
      const t = transformEntity(e, m);
      if (t.__explode) continue;
      dc.drawEntity(t, { color: '#9aa0ac', dashed: true });
    }
  };
}
async function pickEntity(app, c, prompt, filterTypes = null) {
  while (true) {
    const p = await c.awaitPoint({ prompt });
    if (p === CANCELLED || p === ENDED) return null;
    const ent = app.viewport.hitTest(app.viewport.worldToScreen(p), 10);
    if (ent && (!filterTypes || filterTypes.includes(ent.type))) return { ent, at: p };
    if (ent) app.notify(`请选择 ${filterTypes?.join('/')} 对象`, 'error');
  }
}

/* ================= 曲线片段工具（修剪/延伸/圆角/倒角） ================= */
function pieceParam(pc, p) {
  if (pc.kind === 'line') return nearestOnSeg(p, P(pc.x1, pc.y1), P(pc.x2, pc.y2)).t;
  if (pc.kind === 'circle' || pc.kind === 'arc') {
    let a = normAngle(Math.atan2(p.y - pc.cy, p.x - pc.cx));
    const r = pieceAngleRange(pc);
    if (r) { while (a < r[0] - 1e-9) a += TAU; }
    return a;
  }
  if (pc.kind === 'poly') {
    let best = Infinity, bt = 0;
    for (let i = 0; i < pc.points.length - 1; i++) {
      const d = distPointSeg(p, pc.points[i], pc.points[i + 1]);
      if (d < best) {
        best = d;
        const t = nearestOnSeg(p, pc.points[i], pc.points[i + 1]).t;
        bt = (i + t) / (pc.points.length - 1);
      }
    }
    return bt;
  }
  return null;
}
function pieceDistance(pc, p) {
  if (pc.kind === 'line') return distPointSeg(p, P(pc.x1, pc.y1), P(pc.x2, pc.y2));
  if (pc.kind === 'circle') return Math.abs(dist(p, P(pc.cx, pc.cy)) - pc.r);
  if (pc.kind === 'arc') return distPointArc(p, pc.cx, pc.cy, pc.r, pc.startAngle, pc.endAngle);
  if (pc.kind === 'poly') {
    let d = Infinity;
    for (let i = 0; i < pc.points.length - 1; i++) d = Math.min(d, distPointSeg(p, pc.points[i], pc.points[i + 1]));
    return d;
  }
  return Infinity;
}
function linePiece(p1, p2) { return { kind: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }; }
function arcPiece(cx, cy, r, startAngle, endAngle, ccw = true) { return { kind: 'arc', cx, cy, r, startAngle, endAngle, ccw }; }
function makeArcFromRange(pc, a0, a1) {
  // 由 CCW 区间 [a0,a1] 构造与原 piece 同向的弧
  return pc.ccw ? arcPiece(pc.cx, pc.cy, pc.r, a0, a1, true) : arcPiece(pc.cx, pc.cy, pc.r, a1, a0, false);
}
function piecesToPolyline(pieces, closed) {
  const pts = pieces.map((pc) => {
    const s = pieceEndpoints(pc)[0];
    return { x: s.x, y: s.y, bulge: pc.kind === 'arc' ? bulgeFromArc(pc) : 0 };
  });
  if (!closed && pieces.length) {
    const last = pieceEndpoints(pieces[pieces.length - 1])[1];
    pts.push({ x: last.x, y: last.y, bulge: 0 });
  }
  return pts;
}
/** 按切点参数把 piece 切成两段，返回保留"远离切点"的那段（用于圆角） */
function keepFarPart(pc, tParam) {
  const parts = splitPieceAt(pc, tParam);
  if (!parts || parts.length < 2) return pc;
  const mid1 = partMid(parts[0]), mid2 = partMid(parts[1]);
  const tp = paramPoint(pc, tParam);
  return dist(mid1, tp) >= dist(mid2, tp) ? parts[0] : parts[1];
}
function splitPieceAt(pc, t) {
  if (pc.kind === 'line') {
    const a = P(pc.x1, pc.y1), b = P(pc.x2, pc.y2);
    const m = P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    if (t <= 1e-6 || t >= 1 - 1e-6) return [pc];
    return [linePiece(a, m), linePiece(m, b)];
  }
  if (pc.kind === 'arc') {
    const r = pieceAngleRange(pc);
    const a = normAngle(t);
    let at = a;
    if (r) { while (at < r[0] - 1e-9) at += TAU; }
    if (at <= r[0] + 1e-6 || at >= r[1] - 1e-6) return [pc];
    return [makeArcFromRange(pc, r[0], at), makeArcFromRange(pc, at, r[1])];
  }
  return [pc];
}
function paramPoint(pc, t) {
  if (pc.kind === 'line') return P(pc.x1 + (pc.x2 - pc.x1) * t, pc.y1 + (pc.y2 - pc.y1) * t);
  if (pc.kind === 'arc' || pc.kind === 'circle') return P(pc.cx + pc.r * Math.cos(t), pc.cy + pc.r * Math.sin(t));
  return P(0, 0);
}
function partMid(pc) {
  const [a, b] = pieceEndpoints(pc);
  if (pc.kind === 'line') return P((a.x + b.x) / 2, (a.y + b.y) / 2);
  if (pc.kind === 'arc') {
    const r = pieceAngleRange(pc);
    const mid = (r[0] + r[1]) / 2;
    return P(pc.cx + pc.r * Math.cos(mid), pc.cy + pc.r * Math.sin(mid));
  }
  return a;
}
/** 把实体在点击处按剪切边修剪，返回替换后的实体数组（会删除原实体） */
function trimEntityAt(app, e, cutters, clickP) {
  const scene = app.scene;
  const pieces = entityCurves(e, scene);
  if (!pieces.length) return [];
  let ci = -1, best = Infinity;
  pieces.forEach((pc, i) => {
    const d = pieceDistance(pc, clickP);
    if (d < best) { best = d; ci = i; }
  });
  if (best > 8 / app.viewport.scale) return [];
  const pc = pieces[ci];
  const cutPts = [];
  for (const ce of cutters) {
    if (ce.id === e.id) continue;
    cutPts.push(...entityIntersections(e, ce, scene));
  }
  const tc = pieceParam(pc, clickP);
  if (tc === null) return [];
  const params = [];
  for (const p of cutPts) {
    const t = pieceParam(pc, p);
    if (t !== null) params.push(t);
  }
  let newPieces = [];
  if (pc.kind === 'line') {
    const ts = [0, ...params.filter((t) => t > 1e-6 && t < 1 - 1e-6).sort((a, b) => a - b), 1];
    let k = 0;
    for (let i = 0; i < ts.length - 1; i++) {
      if (tc >= ts[i] - 1e-6 && tc <= ts[i + 1] + 1e-6) { k = i; break; }
    }
    const a = P(pc.x1, pc.y1), b = P(pc.x2, pc.y2);
    const at = (t) => P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    newPieces = [];
    if (k > 0) newPieces.push(linePiece(at(ts[0]), at(ts[k])));
    if (k < ts.length - 2) newPieces.push(linePiece(at(ts[k + 1]), at(ts[ts.length - 1])));
  } else if (pc.kind === 'circle' || pc.kind === 'arc') {
    const range = pieceAngleRange(pc);
    const angs = [range[0], ...params.filter((a) => a > range[0] + 1e-9 && a < range[1] - 1e-9).sort((a, b) => a - b), range[1]];
    let k = 0;
    for (let i = 0; i < angs.length - 1; i++) {
      if (tc >= angs[i] - 1e-9 && tc <= angs[i + 1] + 1e-9) { k = i; break; }
    }
    if (pc.kind === 'circle') {
      if (angs.length >= 3) {
        newPieces = [arcPiece(pc.cx, pc.cy, pc.r, angs[k + 1], angs[k] + TAU, true)];
      } else {
        newPieces = [pc]; // 未切开，保持圆
      }
    } else {
      newPieces = [];
      if (k > 0) newPieces.push(makeArcFromRange(pc, range[0], angs[k]));
      if (k < angs.length - 2) newPieces.push(makeArcFromRange(pc, angs[k + 1], range[1]));
    }
  } else {
    return []; // 椭圆等采样折线不支持修剪
  }
  const final = [...pieces.slice(0, ci), ...newPieces, ...pieces.slice(ci + 1)];
  return rebuildFromPieces(app, e, final);
}
/** 由片段重建实体（line/circle/arc/polyline），返回新实体数组 */
function rebuildFromPieces(app, e, pieces) {
  const scene = app.scene;
  const out = [];
  const base = { id: e.id, layer: e.layer, color: e.color, ltype: e.ltype, lw: e.lw };
  if (e.type === 'line') {
    for (const pc of pieces) {
      if (pc.kind !== 'line') continue;
      out.push({ ...base, type: 'line', x1: pc.x1, y1: pc.y1, x2: pc.x2, y2: pc.y2 });
    }
  } else if (e.type === 'circle') {
    for (const pc of pieces) {
      if (pc.kind === 'circle') { out.push({ ...base, type: 'circle', cx: pc.cx, cy: pc.cy, r: pc.r }); break; }
      if (pc.kind === 'arc') out.push({ ...base, type: 'arc', cx: pc.cx, cy: pc.cy, r: pc.r, startAngle: pc.startAngle, endAngle: pc.endAngle, ccw: pc.ccw });
    }
  } else if (e.type === 'arc') {
    for (const pc of pieces) {
      if (pc.kind === 'arc') out.push({ ...base, type: 'arc', cx: pc.cx, cy: pc.cy, r: pc.r, startAngle: pc.startAngle, endAngle: pc.endAngle, ccw: pc.ccw });
    }
  } else if (e.type === 'polyline') {
    const pts = piecesToPolyline(pieces, e.closed);
    if (pts.length >= 2 || (e.closed && pts.length >= 3)) {
      out.push({ ...base, type: 'polyline', points: pts, closed: e.closed });
    }
  }
  return out;
}
/** 延伸片段靠近的端点至边界 */
function extendPiece(pc, boundaries, nearEnd) {
  if (pc.kind === 'line') {
    const A = P(pc.x1, pc.y1), B = P(pc.x2, pc.y2);
    const from = nearEnd === 0 ? A : B;
    const to = nearEnd === 0 ? B : A;
    const dir = P((to.x - from.x) / (dist(to, from) || 1), (to.y - from.y) / (dist(to, from) || 1));
    let best = null, bestD = Infinity;
    for (const bp of boundaries) {
      for (const pt of linePieceIntersections(A, B, bp)) {
        const d = (pt.x - from.x) * dir.x + (pt.y - from.y) * dir.y;
        if (d > 1e-6 && d < bestD) { bestD = d; best = pt; }
      }
    }
    if (best) return nearEnd === 0 ? linePiece(best, B) : linePiece(A, best);
    return pc;
  }
  if (pc.kind === 'arc') {
    const inter = [];
    for (const bp of boundaries) inter.push(...circlePieceIntersections(pc.cx, pc.cy, pc.r, bp));
    const angs = inter.map((p) => normAngle(Math.atan2(p.y - pc.cy, p.x - pc.cx)));
    const start = normAngle(pc.startAngle), end = normAngle(pc.endAngle);
    if (nearEnd === 1) {
      let bestA = null, bestD = Infinity;
      for (const a of angs) {
        const d = arcSweep(end, a) || TAU;
        if (d < bestD) { bestD = d; bestA = a; }
      }
      if (bestA !== null) return arcPiece(pc.cx, pc.cy, pc.r, pc.startAngle, pc.ccw ? start + (bestA >= start ? bestA - start : bestA + TAU - start) : start, pc.ccw);
    } else {
      let bestA = null, bestD = Infinity;
      for (const a of angs) {
        const d = arcSweep(a, start) || TAU;
        if (d < bestD) { bestD = d; bestA = a; }
      }
      if (bestA !== null) return arcPiece(pc.cx, pc.cy, pc.r, bestA, pc.endAngle, pc.ccw);
    }
    return pc;
  }
  return pc;
}
function linePieceIntersections(a, b, bp) {
  const out = [];
  if (bp.kind === 'line') {
    const r = lineLineIntersection(a, b, P(bp.x1, bp.y1), P(bp.x2, bp.y2));
    if (r) out.push(r);
  } else if (bp.kind === 'circle' || bp.kind === 'arc') {
    for (const r of lineCircleIntersections(a, b, bp.cx, bp.cy, bp.r)) {
      if (bp.kind === 'circle' || angleOnPiece(bp, Math.atan2(r.y - bp.cy, r.x - bp.cx))) out.push(r);
    }
  } else if (bp.kind === 'poly') {
    for (let i = 0; i < bp.points.length - 1; i++) {
      const r = lineLineIntersection(a, b, bp.points[i], bp.points[i + 1]);
      if (r) out.push(r);
    }
  }
  return out;
}
function circlePieceIntersections(cx, cy, r, bp) {
  const out = [];
  if (bp.kind === 'line') {
    for (const p of lineCircleIntersections(P(bp.x1, bp.y1), P(bp.x2, bp.y2), cx, cy, r)) out.push(p);
  } else if (bp.kind === 'circle' || bp.kind === 'arc') {
    for (const p of circleCircleIntersections(P(cx, cy), r, P(bp.cx, bp.cy), bp.r)) {
      if (bp.kind === 'circle' || angleOnPiece(bp, Math.atan2(p.y - bp.cy, p.x - bp.cx))) out.push(p);
    }
  } else if (bp.kind === 'poly') {
    for (let i = 0; i < bp.points.length - 1; i++) {
      out.push(...lineCircleIntersections(bp.points[i], bp.points[i + 1], cx, cy, r));
    }
  }
  return out;
}
/** 偏移单个曲线片段 */
function offsetPiece(pc, d) {
  if (pc.kind === 'line') {
    const a = P(pc.x1, pc.y1), b = P(pc.x2, pc.y2);
    const ang = angleOf(a, b);
    const n = P(-Math.sin(ang), Math.cos(ang));
    return linePiece(P(a.x + n.x * d, a.y + n.y * d), P(b.x + n.x * d, b.y + n.y * d));
  }
  if (pc.kind === 'arc' || pc.kind === 'circle') {
    const r2 = Math.max(Math.abs(pc.r + d), 0.01);
    return pc.kind === 'circle'
      ? { kind: 'circle', cx: pc.cx, cy: pc.cy, r: r2 }
      : arcPiece(pc.cx, pc.cy, r2, pc.startAngle, pc.endAngle, pc.ccw);
  }
  return pc;
}

/* ================= 绘图命令 ================= */
function regDraw(app, c) {
  const scene = app.scene;

  c.register('LINE', async () => {
    const pts = [];
    let first = await c.awaitPoint({ prompt: '直线起点:' });
    if (first === CANCELLED || first === ENDED || !first) return;
    pts.push(first);
    let prev = first;
    scene.beginUndoGroup('直线');
    while (true) {
      const p = await c.awaitPoint({
        prompt: '下一点:', base: prev,
        preview: (ctx, q) => {
          const dc = new DrawContext(app.viewport, ctx);
          const t = make.line(prev, q, { color: '#9aa0ac' });
          dc.drawEntity(t, { dashed: true });
        },
      });
      if (p === CANCELLED) { scene.endUndoGroup(); if (scene.count() === 0) { /* 空组 */ } return; }
      if (p === ENDED || p === null) break;
      scene.addEntity(make.line(prev, p));
      pts.push(p);
      prev = p;
    }
    scene.endUndoGroup();
  }, ['L']);

  c.register('PLINE', async () => {
    const pts = [];
    let first = await c.awaitPoint({ prompt: '多段线起点:' });
    if (first === CANCELLED || first === ENDED || !first) return;
    pts.push(first);
    let prev = first;
    let closed = false;
    scene.beginUndoGroup('多段线');
    while (true) {
      const p = await c.awaitPoint({
        prompt: '下一点或 [闭合(C)]:',
        base: prev,
        onText: (s) => /^c$/i.test(s),
        preview: (ctx, q) => {
          const dc = new DrawContext(app.viewport, ctx);
          const t = make.polyline([...pts, q], { color: '#9aa0ac' });
          dc.drawEntity(t, { dashed: true });
        },
      });
      if (p === CANCELLED) { scene.endUndoGroup(); return; }
      if (p === ENDED || p === null) break;
      if (typeof p === 'string' && /^c$/i.test(p)) { closed = true; break; }
      pts.push(p);
      prev = p;
    }
    if (pts.length >= 2) {
      scene.addEntity(make.polyline(pts, { closed }));
    }
    scene.endUndoGroup();
  }, ['PL', 'POLYLINE']);

  c.register('RECTANGLE', async () => {
    const c1 = await c.awaitPoint({ prompt: '矩形第一角点:' });
    if (c1 === CANCELLED || c1 === ENDED || !c1) return;
    const c2 = await c.awaitPoint({
      prompt: '矩形对角点:', base: c1,
      preview: (ctx, q) => {
        const dc = new DrawContext(app.viewport, ctx);
        dc.drawEntity(make.rectangle(c1, q, { color: '#9aa0ac' }), { dashed: true });
      },
    });
    if (c2 === CANCELLED || c2 === ENDED || !c2) return;
    scene.singleOp('矩形', () => scene.addEntity(make.rectangle(c1, c2)));
  }, ['REC', 'RECTANG']);

  c.register('POLYGON', async () => {
    let sides = 6;
    const args = c.queue;
    if (args.length && /^\d+$/.test(args[0])) { sides = parseInt(args.shift(), 10); }
    const center = await c.awaitPoint({ prompt: '多边形中心:' });
    if (center === CANCELLED || center === ENDED || !center) return;
    const r = await c.awaitDistance(center, { prompt: '外接圆半径:' });
    if (r === CANCELLED || r === ENDED || !r) return;
    const n = clamp(Math.round(sides), 3, 64);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU - Math.PI / 2;
      pts.push(polar(center, a, r));
    }
    scene.singleOp('多边形', () => scene.addEntity(make.polyline(pts, { closed: true })));
  }, ['POL']);

  c.register('CIRCLE', async (app2, args) => {
    const center = await c.awaitPoint({
      prompt: '圆心或 [两点(2P)/三点(3P)]:',
      onText: (s) => /^2p$/i.test(s) || /^3p$/i.test(s),
    });
    if (center === CANCELLED || center === ENDED || !center) return;
    if (typeof center === 'string') {
      if (/^2p$/i.test(center)) {
        const p1 = await c.awaitPoint({ prompt: '直径第一点:' });
        if (p1 === CANCELLED || p1 === ENDED || !p1) return;
        const p2 = await c.awaitPoint({ prompt: '直径第二点:', base: p1, preview: (ctx, q) => {
          const dc = new DrawContext(app.viewport, ctx);
          dc.drawEntity(make.circle(P((p1.x + q.x) / 2, (p1.y + q.y) / 2), dist(p1, q) / 2, { color: '#9aa0ac' }), { dashed: true });
        } });
        if (p2 === CANCELLED || p2 === ENDED || !p2) return;
        scene.singleOp('圆', () => scene.addEntity(make.circle(P((p1.x + p2.x) / 2, (p1.y + p2.y) / 2), dist(p1, p2) / 2)));
      } else {
        const p1 = await c.awaitPoint({ prompt: '圆上第一点:' });
        if (p1 === CANCELLED || p1 === ENDED || !p1) return;
        const p2 = await c.awaitPoint({ prompt: '圆上第二点:', base: p1 });
        if (p2 === CANCELLED || p2 === ENDED || !p2) return;
        const p3 = await c.awaitPoint({ prompt: '圆上第三点:', base: p2, preview: (ctx, q) => {
          const cc = circleThrough3Local(p1, p2, q);
          if (cc) { const dc = new DrawContext(app.viewport, ctx); dc.drawEntity(make.circle(P(cc.cx, cc.cy), cc.r, { color: '#9aa0ac' }), { dashed: true }); }
        } });
        if (p3 === CANCELLED || p3 === ENDED || !p3) return;
        const cc = circleThrough3Local(p1, p2, p3);
        if (!cc) { app.notify('三点共线，无法构造圆', 'error'); return; }
        scene.singleOp('圆', () => scene.addEntity(make.circle(P(cc.cx, cc.cy), cc.r)));
      }
      return;
    }
    const r = await c.awaitDistance(center, {
      prompt: '半径:',
      preview: (ctx, q) => {
        const dc = new DrawContext(app.viewport, ctx);
        dc.drawEntity(make.circle(center, q, { color: '#9aa0ac' }), { dashed: true });
      },
    });
    if (r === CANCELLED || r === ENDED || !r) return;
    scene.singleOp('圆', () => scene.addEntity(make.circle(center, Math.abs(r))));
  }, ['C']);

  c.register('ARC', async () => {
    const p1 = await c.awaitPoint({ prompt: '圆弧起点或 [起点圆心端点(SCE)/起点圆心角度(SCA)]:', onText: (s) => /^sce$/i.test(s) || /^sca$/i.test(s) });
    if (p1 === CANCELLED || p1 === ENDED || !p1) return;
    if (typeof p1 === 'string') {
      const mode = p1.toLowerCase();
      const s = await c.awaitPoint({ prompt: '起点:' });
      if (s === CANCELLED || s === ENDED || !s) return;
      const ce = await c.awaitPoint({ prompt: '圆心:', base: s });
      if (ce === CANCELLED || ce === ENDED || !ce) return;
      const rr = dist(s, ce);
      const startA = angleOf(ce, s);
      let endA;
      if (mode === 'sce') {
        const e2 = await c.awaitPoint({ prompt: '端点(决定角度):', base: ce, preview: (ctx, q) => {
          const dc = new DrawContext(app.viewport, ctx);
          dc.drawEntity(make.arc(ce, rr, startA, angleOf(ce, q), { color: '#9aa0ac' }), { dashed: true });
        } });
        if (e2 === CANCELLED || e2 === ENDED || !e2) return;
        endA = angleOf(ce, e2);
      } else {
        const ang = await c.awaitAngle(ce, { prompt: '包含角(度, 逆时针为正):' });
        if (ang === CANCELLED || ang === ENDED || ang === null) return;
        endA = startA + ang * D2R;
      }
      scene.singleOp('圆弧', () => scene.addEntity(make.arc(ce, rr, startA, endA)));
      return;
    }
    const p2 = await c.awaitPoint({ prompt: '圆弧第二点:', base: p1 });
    if (p2 === CANCELLED || p2 === ENDED || !p2) return;
    const p3 = await c.awaitPoint({
      prompt: '圆弧终点:', base: p2,
      preview: (ctx, q) => {
        const cc = circleThrough3Local(p1, p2, q);
        if (cc) {
          const dc = new DrawContext(app.viewport, ctx);
          dc.drawEntity(make.arc(P(cc.cx, cc.cy), cc.r, Math.atan2(p1.y - cc.cy, p1.x - cc.cx), Math.atan2(q.y - cc.cy, q.x - cc.cx), { color: '#9aa0ac' }), { dashed: true });
        }
      },
    });
    if (p3 === CANCELLED || p3 === ENDED || !p3) return;
    const cc = circleThrough3Local(p1, p2, p3);
    if (!cc) { app.notify('三点共线，无法构造圆弧', 'error'); return; }
    const a1 = Math.atan2(p1.y - cc.cy, p1.x - cc.cx);
    const a3 = Math.atan2(p3.y - cc.cy, p3.x - cc.cx);
    // 保证第二点在弧上
    const a2 = Math.atan2(p2.y - cc.cy, p2.x - cc.cx);
    const onCCW = angleInRange(a2, a1, a3);
    const startAngle = onCCW ? a1 : a3;
    const endAngle = onCCW ? a3 : a1;
    const ccw = !onCCW;
    scene.singleOp('圆弧', () => scene.addEntity(make.arc(P(cc.cx, cc.cy), cc.r, startAngle, endAngle, { ccw })));
  }, ['A']);
  const circleThrough3Local = (p1, p2, p3) => {
    const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
    if (Math.abs(d) < 1e-9) return null;
    const p1s = p1.x * p1.x + p1.y * p1.y, p2s = p2.x * p2.x + p2.y * p2.y, p3s = p3.x * p3.x + p3.y * p3.y;
    const cx = (p1s * (p2.y - p3.y) + p2s * (p3.y - p1.y) + p3s * (p1.y - p2.y)) / d;
    const cy = (p1s * (p3.x - p2.x) + p2s * (p1.x - p3.x) + p3s * (p2.x - p1.x)) / d;
    return { cx, cy, r: Math.hypot(p1.x - cx, p1.y - cy) };
  };

  c.register('ELLIPSE', async () => {
    const center = await c.awaitPoint({ prompt: '椭圆中心:' });
    if (center === CANCELLED || center === ENDED || !center) return;
    const axis = await c.awaitPoint({
      prompt: '长轴端点:', base: center,
      preview: (ctx, q) => {
        const dc = new DrawContext(app.viewport, ctx);
        dc.drawEntity(make.line(center, q, { color: '#9aa0ac' }), { dashed: true });
      },
    });
    if (axis === CANCELLED || axis === ENDED || !axis) return;
    const rx = dist(center, axis);
    const rot = angleOf(center, axis);
    const ry = await c.awaitDistance(center, {
      prompt: '另一轴半长:',
      preview: (ctx, q) => {
        const dc = new DrawContext(app.viewport, ctx);
        dc.drawEntity(make.ellipse(center, rx, q, rot, { color: '#9aa0ac' }), { dashed: true });
      },
    });
    if (ry === CANCELLED || ry === ENDED || !ry) return;
    scene.singleOp('椭圆', () => scene.addEntity(make.ellipse(center, rx, Math.abs(ry), rot)));
  }, ['EL']);

  c.register('POINT', async () => {
    const p = await c.awaitPoint({ prompt: '点位置:' });
    if (p === CANCELLED || p === ENDED || !p) return;
    scene.singleOp('点', () => scene.addEntity(make.point(p)));
  }, ['PO']);

  let lastText = '';
  c.register('TEXT', async () => {
    const p = await c.awaitPoint({ prompt: '文字插入点:' });
    if (p === CANCELLED || p === ENDED || !p) return;
    const h = await c.awaitNumber({ prompt: `文字高度 <${scene.dimstyle.textHeight}>:`, enterValue: scene.dimstyle.textHeight });
    if (h === CANCELLED) return;
    const rot = await c.awaitAngle(p, { prompt: '旋转角度 <0>:', enterValue: 0 });
    if (rot === CANCELLED) return;
    const txt = await c.awaitText({ prompt: '文字内容:', initial: lastText });
    if (txt === CANCELLED) return;
    if (!txt) return;
    lastText = txt;
    scene.singleOp('文字', () => scene.addEntity(make.text(p, txt, h === ENDED ? scene.dimstyle.textHeight : h, (rot === ENDED ? 0 : rot) * D2R)));
  }, ['DT', 'T']);

  c.register('EDITTEXT', async () => {
    const pick = await pickEntity(app, c, '选择要编辑的文字:', ['text']);
    if (!pick) return;
    const txt = await c.awaitText({ prompt: '新内容:', initial: pick.ent.text });
    if (txt === CANCELLED || txt === ENDED || !txt) return;
    scene.singleOp('编辑文字', () => { pick.ent.text = txt; scene._changed(); });
  }, ['ED', 'DDEDIT']);

  c.register('HATCH', async () => {
    const pick = await pickEntity(app, c, '选择封闭边界(圆/椭圆/闭合多段线):', ['circle', 'ellipse', 'polyline']);
    if (!pick) return;
    const e = pick.ent;
    if (e.type === 'polyline' && !e.closed) { app.notify('多段线未闭合', 'error'); return; }
    let boundary;
    if (e.type === 'circle') boundary = { kind: 'circle', cx: e.cx, cy: e.cy, r: e.r };
    else if (e.type === 'ellipse') boundary = { kind: 'ellipse', cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, rot: e.rot };
    else boundary = { kind: 'polyline', points: flattenPolyline(e.points.map((q) => P(q.x, q.y)), e.points.map((q) => q.bulge)) };
    const style = await c.awaitText({ prompt: '填充样式 [实心(S)/斜线(H)] <S>:', enterValue: 'S' });
    if (style === CANCELLED) return;
    let hatch = { type: 'hatch', boundary, solid: true, angle: 45, spacing: 5, layer: e.layer };
    if (/^h$/i.test(style || '')) {
      hatch.solid = false;
      const ang = await c.awaitAngle(P(0, 0), { prompt: '斜线角度 <45>:', enterValue: 45 });
      if (ang === CANCELLED) return;
      const sp = await c.awaitNumber({ prompt: '斜线间距 <5>:', enterValue: 5 });
      if (sp === CANCELLED) return;
      hatch.angle = ang === ENDED ? 45 : ang;
      hatch.spacing = sp === ENDED ? 5 : sp;
    }
    scene.singleOp('填充', () => scene.addEntity(newEntity('hatch', hatch)));
  }, ['H', 'BH']);

  c.register('BLOCK', async () => {
    const name = await c.awaitText({ prompt: '块名称:' });
    if (name === CANCELLED || !name) return;
    if (scene.blocks.has(name)) { app.notify(`块「${name}」已存在`, 'error'); return; }
    const ids = await selOrPrompt(app, c, '选择组成块的对象:');
    if (!ids || !ids.length) return;
    const base = await c.awaitPoint({ prompt: '块基点:' });
    if (base === CANCELLED || base === ENDED || !base) return;
    const ents = ids.map((id) => scene.get(id)).filter(Boolean);
    scene.singleOp('定义块', () => {
      scene.addBlock(name, base, ents);
      scene.removeEntities(ids);
    });
    app.notify(`已定义块「${name}」`);
  }, ['B']);

  c.register('INSERT', async () => {
    if (!scene.blocks.size) { app.notify('暂无块定义，请先用 B 命令', 'error'); return; }
    const name = await app.chooseBlock();
    if (!name) return;
    const p = await c.awaitPoint({ prompt: '插入点:' });
    if (p === CANCELLED || p === ENDED || !p) return;
    const sx = await c.awaitNumber({ prompt: 'X 比例 <1>:', enterValue: 1 });
    if (sx === CANCELLED) return;
    const sy = await c.awaitNumber({ prompt: `Y 比例 <${sx === ENDED ? 1 : sx}>:`, enterValue: sx === ENDED ? 1 : sx });
    if (sy === CANCELLED) return;
    const rot = await c.awaitAngle(p, { prompt: '旋转角度 <0>:', enterValue: 0 });
    if (rot === CANCELLED) return;
    const e = make.insert(name, p, {
      scaleX: sx === ENDED ? 1 : sx,
      scaleY: sy === ENDED ? (sx === ENDED ? 1 : sx) : sy,
      rotation: (rot === ENDED ? 0 : rot) * D2R,
    });
    scene.singleOp('插入块', () => scene.addEntity(e));
  }, ['I', 'DDINSERT']);
}

/* ================= 修改命令 ================= */
function regModify(app, c) {
  const scene = app.scene;

  c.register('MOVE', async () => {
    const ids = await selOrPrompt(app, c);
    if (!ids || !ids.length) return;
    const base = await c.awaitPoint({ prompt: '基点:' });
    if (base === CANCELLED || base === ENDED || !base) return;
    const dest = await c.awaitPoint({
      prompt: '目标点:', base,
      preview: ghostPreview(app, ids, (q) => translationM(q.x - base.x, q.y - base.y)),
    });
    if (dest === CANCELLED || dest === ENDED || !dest) return;
    scene.singleOp('移动', () => scene.transformEntities(translationM(dest.x - base.x, dest.y - base.y), ids));
  }, ['M']);

  c.register('COPY', async () => {
    const ids = await selOrPrompt(app, c);
    if (!ids || !ids.length) return;
    const base = await c.awaitPoint({ prompt: '基点:' });
    if (base === CANCELLED || base === ENDED || !base) return;
    scene.beginUndoGroup('复制');
    let count = 0;
    while (true) {
      const dest = await c.awaitPoint({
        prompt: '目标点(回车结束):', base,
        preview: ghostPreview(app, ids, (q) => translationM(q.x - base.x, q.y - base.y)),
      });
      if (dest === CANCELLED) { scene.endUndoGroup(); return; }
      if (dest === ENDED || dest === null) break;
      const newIds = scene.transformEntities(translationM(dest.x - base.x, dest.y - base.y), ids, { copy: true });
      count += newIds.length;
      scene.select(newIds, 'set');
    }
    scene.endUndoGroup();
    app.notify(`已复制 ${count} 个对象`);
  }, ['CO', 'CP']);

  c.register('ROTATE', async () => {
    const ids = await selOrPrompt(app, c);
    if (!ids || !ids.length) return;
    const base = await c.awaitPoint({ prompt: '旋转基点:' });
    if (base === CANCELLED || base === ENDED || !base) return;
    const ang = await c.awaitAngle(base, {
      prompt: '旋转角度(度):',
      preview: ghostPreview(app, ids, (q) => rotationM(angleOf(base, q), base.x, base.y)),
    });
    if (ang === CANCELLED || ang === ENDED || ang === null) return;
    scene.singleOp('旋转', () => scene.transformEntities(rotationM(ang * D2R, base.x, base.y), ids));
  }, ['RO']);

  c.register('SCALE', async () => {
    const ids = await selOrPrompt(app, c);
    if (!ids || !ids.length) return;
    const base = await c.awaitPoint({ prompt: '缩放基点:' });
    if (base === CANCELLED || base === ENDED || !base) return;
    let factor = await c.awaitNumber({ prompt: '比例因子或 [参照(R)]:', onText: (s) => /^r$/i.test(s) });
    if (factor === CANCELLED) return;
    if (typeof factor === 'string' && /^r$/i.test(factor)) {
      const p1 = await c.awaitPoint({ prompt: '参照长度第一点:' });
      if (p1 === CANCELLED || p1 === ENDED || !p1) return;
      const p2 = await c.awaitPoint({ prompt: '参照长度第二点:', base: p1 });
      if (p2 === CANCELLED || p2 === ENDED || !p2) return;
      const refLen = dist(p1, p2);
      const p3 = await c.awaitPoint({ prompt: '新长度点:', base, preview: ghostPreview(app, ids, (q) => scaleM(dist(base, q) / (refLen || 1), dist(base, q) / (refLen || 1), base.x, base.y)) });
      if (p3 === CANCELLED || p3 === ENDED || !p3) return;
      factor = dist(base, p3) / (refLen || 1);
    }
    if (factor === ENDED || factor === null || typeof factor !== 'number' || Math.abs(factor) < 1e-9) return;
    scene.singleOp('缩放', () => scene.transformEntities(scaleM(factor, factor, base.x, base.y), ids));
  }, ['SC']);

  c.register('MIRROR', async () => {
    const ids = await selOrPrompt(app, c);
    if (!ids || !ids.length) return;
    const p1 = await c.awaitPoint({ prompt: '镜像轴第一点:' });
    if (p1 === CANCELLED || p1 === ENDED || !p1) return;
    const p2 = await c.awaitPoint({
      prompt: '镜像轴第二点:', base: p1,
      preview: ghostPreview(app, ids, (q) => mirrorM(p1, q)),
    });
    if (p2 === CANCELLED || p2 === ENDED || !p2) return;
    const del = await c.awaitText({ prompt: '删除源对象? [是(Y)/否(N)] <N>:', enterValue: 'N' });
    if (del === CANCELLED) return;
    const remove = /^y$/i.test(del || '');
    const m = mirrorM(p1, p2);
    scene.singleOp('镜像', () => {
      if (remove) scene.transformEntities(m, ids);
      else scene.transformEntities(m, ids, { copy: true });
    });
  }, ['MI']);

  c.register('OFFSET', async () => {
    const pick = await pickEntity(app, c, '选择要偏移的对象(线/圆/弧/多段线):', ['line', 'circle', 'arc', 'polyline', 'ellipse']);
    if (!pick) return;
    const d = await c.awaitNumber({ prompt: '偏移距离:' });
    if (d === CANCELLED || d === ENDED || !d) return;
    const side = await c.awaitPoint({
      prompt: '指定偏移方向(点取一侧):',
      preview: (ctx, q) => {
        const sign = offsetSign(pick.ent, pick.at, q);
        if (sign !== 0) {
          const t = offsetEntity(pick.ent, Math.abs(d) * sign);
          if (t) { const dc = new DrawContext(app.viewport, ctx); dc.drawEntity(t, { color: '#9aa0ac', dashed: true }); }
        }
      },
    });
    if (side === CANCELLED || side === ENDED || !side) return;
    const sign = offsetSign(pick.ent, pick.at, side);
    if (sign === 0) { app.notify('无法判断偏移方向', 'error'); return; }
    const t = offsetEntity(pick.ent, Math.abs(d) * sign);
    if (!t) { app.notify('偏移失败（距离过大？）', 'error'); return; }
    scene.singleOp('偏移', () => scene.addEntity(t));
  }, ['O']);
  const offsetSign = (e, pickP, sideP) => {
    if (e.type === 'line') {
      const d1 = dist(pickP, P(e.x1, e.y1)), d2 = dist(pickP, P(e.x2, e.y2));
      const baseP = d1 < d2 ? P(e.x1, e.y1) : P(e.x2, e.y2);
      const other = d1 < d2 ? P(e.x2, e.y2) : P(e.x1, e.y1);
      const ang = angleOf(baseP, other);
      const n = P(-Math.sin(ang), Math.cos(ang));
      const s = (sideP.x - baseP.x) * n.x + (sideP.y - baseP.y) * n.y;
      return s > 0 ? 1 : -1;
    }
    if (e.type === 'circle' || e.type === 'arc') {
      const dP = dist(pickP, P(e.cx, e.cy));
      const dS = dist(sideP, P(e.cx, e.cy));
      return dS > dP ? 1 : -1;
    }
    if (e.type === 'ellipse') {
      const dP = dist(pickP, P(e.cx, e.cy));
      const dS = dist(sideP, P(e.cx, e.cy));
      return dS > dP ? 1 : -1;
    }
    if (e.type === 'polyline') {
      // 用边界内外判断：点在内部→内偏移
      const inside = pointInPolygon(sideP, flattenPolyline(e.points.map((q) => P(q.x, q.y)), e.points.map((q) => q.bulge)));
      return e.closed && inside ? -1 : 1;
    }
    return 0;
  };
  const offsetEntity = (e, d) => {
    if (e.type === 'line') {
      const ang = angleOf(P(e.x1, e.y1), P(e.x2, e.y2));
      const n = P(-Math.sin(ang), Math.cos(ang));
      return make.line(P(e.x1 + n.x * d, e.y1 + n.y * d), P(e.x2 + n.x * d, e.y2 + n.y * d), { layer: e.layer, color: e.color, ltype: e.ltype, lw: e.lw });
    }
    if (e.type === 'circle') {
      const r2 = Math.abs(e.r + d);
      if (r2 < 0.01) return null;
      return make.circle(P(e.cx, e.cy), r2, { layer: e.layer, color: e.color, ltype: e.ltype, lw: e.lw });
    }
    if (e.type === 'arc') {
      const r2 = Math.abs(e.r + d);
      if (r2 < 0.01) return null;
      return make.arc(P(e.cx, e.cy), r2, e.startAngle, e.endAngle, { layer: e.layer, color: e.color, ltype: e.ltype, lw: e.lw, ccw: e.ccw });
    }
    if (e.type === 'ellipse') {
      return make.ellipse(P(e.cx, e.cy), e.rx + d, e.ry + d, e.rot, { layer: e.layer, color: e.color, ltype: e.ltype, lw: e.lw });
    }
    if (e.type === 'polyline') {
      const flat = flattenPolyline(e.points.map((q) => P(q.x, q.y)), e.points.map((q) => q.bulge));
      if (flat.length < 3) return null;
      const n = flat.length;
      const offsetPts = [];
      for (let i = 0; i < n; i++) {
        const prev = flat[(i - 1 + n) % n], cur = flat[i], next = flat[(i + 1) % n];
        const in1 = angleOf(prev, cur), in2 = angleOf(cur, next);
        const n1 = P(-Math.sin(in1), Math.cos(in1));
        const n2 = P(-Math.sin(in2), Math.cos(in2));
        let nn = P(n1.x + n2.x, n1.y + n2.y);
        const ln = Math.hypot(nn.x, nn.y);
        if (ln < 1e-9) nn = n1;
        else nn = P(nn.x / ln, nn.y / ln);
        const cosHalf = Math.max(Math.abs((n1.x * nn.x + n1.y * nn.y)), 0.05);
        const f = 1 / cosHalf;
        offsetPts.push(P(cur.x + nn.x * d * f, cur.y + nn.y * d * f));
      }
      // 去掉自交（近似保留）
      if (offsetPts.length >= 3) return make.polyline(offsetPts, { closed: e.closed, layer: e.layer, color: e.color, ltype: e.ltype, lw: e.lw });
      return null;
    }
    return null;
  };

  c.register('TRIM', async () => {
    let cutters = scene.selection.size ? scene.selected().map((e) => e.id) : null;
    if (!cutters || !cutters.length) {
      cutters = await pickMultiple(app, c, '选择剪切边:');
    }
    if (!cutters || !cutters.length) return;
    const cutterEnts = cutters.map((id) => scene.get(id)).filter(Boolean);
    scene.beginUndoGroup('修剪');
    let trimmed = 0;
    while (true) {
      const p = await c.awaitPoint({ prompt: '选择要修剪的对象(回车结束):' });
      if (p === CANCELLED) { scene.endUndoGroup(); return; }
      if (p === ENDED || p === null) break;
      const ent = app.viewport.hitTest(app.viewport.worldToScreen(p), 8);
      if (!ent || ['line', 'circle', 'arc', 'polyline'].indexOf(ent.type) < 0) continue;
      const repl = trimEntityAt(app, ent, cutterEnts, p);
      if (!repl.length) continue;
      scene.removeEntity(ent.id);
      for (const r of repl) { delete r.id; scene.addEntity(r); }
      trimmed++;
    }
    scene.endUndoGroup();
    app.notify(`修剪完成`);
  }, ['TR']);

  c.register('EXTEND', async () => {
    let bounds = scene.selection.size ? scene.selected().map((e) => e.id) : null;
    if (!bounds || !bounds.length) {
      bounds = await pickMultiple(app, c, '选择边界对象:');
    }
    if (!bounds || !bounds.length) return;
    const boundaryEnts = bounds.map((id) => scene.get(id)).filter(Boolean);
    const curves = [];
    for (const b of boundaryEnts) curves.push(...entityCurves(b, scene));
    scene.beginUndoGroup('延伸');
    let extended = 0;
    while (true) {
      const p = await c.awaitPoint({ prompt: '选择要延伸的对象(回车结束):' });
      if (p === CANCELLED) { scene.endUndoGroup(); return; }
      if (p === ENDED || p === null) break;
      const ent = app.viewport.hitTest(app.viewport.worldToScreen(p), 8);
      if (!ent || ['line', 'arc', 'polyline'].indexOf(ent.type) < 0) continue;
      const pieces = entityCurves(ent, scene);
      let ci = -1, best = Infinity;
      pieces.forEach((pc, i) => {
        const d = pieceDistance(pc, p);
        if (d < best) { best = d; ci = i; }
      });
      if (ci < 0 || best > 8 / app.viewport.scale) continue;
      const pc = pieces[ci];
      const t = pieceParam(pc, p);
      if (t === null) continue;
      const nearEnd = pc.kind === 'line' ? (t < 0.5 ? 0 : 1) : (() => {
        const [a, b] = pieceEndpoints(pc);
        return dist(p, a) < dist(p, b) ? 0 : 1;
      })();
      const newPc = extendPiece(pc, curves, nearEnd);
      if (newPc === pc) continue;
      const final = [...pieces.slice(0, ci), newPc, ...pieces.slice(ci + 1)];
      const repl = rebuildFromPieces(app, ent, final);
      if (!repl.length) continue;
      scene.removeEntity(ent.id);
      for (const r of repl) { delete r.id; scene.addEntity(r); }
      extended++;
    }
    scene.endUndoGroup();
    app.notify('延伸完成');
  }, ['EX']);

  c.register('FILLET', async () => {
    const pk1 = await pickEntity(app, c, '选择第一个对象(线/圆/弧/多段线):', ['line', 'circle', 'arc', 'polyline']);
    if (!pk1) return;
    const pk2 = await pickEntity(app, c, '选择第二个对象:', ['line', 'circle', 'arc', 'polyline']);
    if (!pk2) return;
    const r = await c.awaitNumber({ prompt: '圆角半径 <0>:', enterValue: 0 });
    if (r === CANCELLED) return;
    const radius = r === ENDED ? 0 : Math.abs(r);
    if (radius < 1e-9) {
      // 半径 0 → 直接延伸两对象到交点
      scene.singleOp('圆角', () => {
        for (const [ent, at] of [[pk1.ent, pk1.at], [pk2.ent, pk2.at]]) {
          const pieces = entityCurves(ent, scene);
          let ci = -1, best = Infinity;
          pieces.forEach((pc, i) => {
            const d = pieceDistance(pc, at);
            if (d < best) { best = d; ci = i; }
          });
          if (ci < 0) continue;
          const t = pieceParam(pieces[ci], at);
          if (t === null) continue;
          const nearEnd = pieces[ci].kind === 'line' ? (t < 0.5 ? 0 : 1) : 0;
          const newPc = extendPiece(pieces[ci], entityCurves(pk1.ent === ent ? pk2.ent : pk1.ent, scene), nearEnd);
          if (newPc === pieces[ci]) continue;
          const final = [...pieces.slice(0, ci), newPc, ...pieces.slice(ci + 1)];
          const repl = rebuildFromPieces(app, ent, final);
          if (repl.length) {
            scene.removeEntity(ent.id);
            for (const rr of repl) { delete rr.id; scene.addEntity(rr); }
          }
        }
      });
      return;
    }
    // 找点击的片段
    const pcs1 = entityCurves(pk1.ent, scene), pcs2 = entityCurves(pk2.ent, scene);
    const near = (pcs, at) => {
      let ci = -1, best = Infinity;
      pcs.forEach((pc, i) => {
        const d = pieceDistance(pc, at);
        if (d < best) { best = d; ci = i; }
      });
      return pcs[ci];
    };
    const pc1 = near(pcs1, pk1.at), pc2 = near(pcs2, pk2.at);
    if (!pc1 || !pc2) return;
    const loci1 = pieceLoci(pc1, radius), loci2 = pieceLoci(pc2, radius);
    const cands = [];
    for (const L1 of loci1) for (const L2 of loci2) cands.push(...piecePieceIntersections(L1, L2));
    let bestC = null, bestD = Infinity;
    for (const cc of cands) {
      const t1 = tangentOn(pc1, cc), t2 = tangentOn(pc2, cc);
      if (!t1 || !t2) continue;
      if (Math.abs(dist(t1, cc) - radius) > 1e-4 || Math.abs(dist(t2, cc) - radius) > 1e-4) continue;
      const dd = dist(cc, pk1.at) + dist(cc, pk2.at);
      if (dd < bestD) { bestD = dd; bestC = { cc, t1, t2 }; }
    }
    if (!bestC) { app.notify('无法构造圆角（对象过短或不相交）', 'error'); return; }
    const { cc, t1, t2 } = bestC;
    scene.beginUndoGroup('圆角');
    // 修剪两个对象
    for (const [ent, pc, tp] of [[pk1.ent, pc1, t1], [pk2.ent, pc2, t2]]) {
      if (pc.kind === 'circle') continue;
      const pieces = entityCurves(ent, scene);
      let ci = -1;
      pieces.forEach((p2, i) => { if (p2 === pc) ci = i; });
      if (ci < 0) continue;
      const t = pieceParam(pc, tp);
      if (t === null) continue;
      const kept = keepFarPart(pc, t);
      const final = [...pieces.slice(0, ci), kept, ...pieces.slice(ci + 1)];
      const repl = rebuildFromPieces(app, ent, final);
      if (repl.length) {
        scene.removeEntity(ent.id);
        for (const rr of repl) { delete rr.id; scene.addEntity(rr); }
      }
    }
    // 添加圆角弧
    const a1 = Math.atan2(t1.y - cc.y, t1.x - cc.x);
    const a2 = Math.atan2(t2.y - cc.y, t2.x - cc.x);
    let ccw = true;
    if (normAngle(a2 - a1) > Math.PI) ccw = false;
    scene.addEntity(make.arc(cc, radius, a1, a2, { layer: pk1.ent.layer, ccw }));
    scene.endUndoGroup();
  }, ['F']);
  const pieceLoci = (pc, r) => {
    if (pc.kind === 'line') {
      const a = P(pc.x1, pc.y1), b = P(pc.x2, pc.y2);
      const ang = angleOf(a, b);
      const n = P(-Math.sin(ang), Math.cos(ang));
      return [
        linePiece(P(a.x + n.x * r, a.y + n.y * r), P(b.x + n.x * r, b.y + n.y * r)),
        linePiece(P(a.x - n.x * r, a.y - n.y * r), P(b.x - n.x * r, b.y - n.y * r)),
      ];
    }
    if (pc.kind === 'circle' || pc.kind === 'arc') {
      return [
        { kind: 'circle', cx: pc.cx, cy: pc.cy, r: Math.abs(pc.r + r) },
        { kind: 'circle', cx: pc.cx, cy: pc.cy, r: Math.abs(pc.r - r) },
      ];
    }
    return [];
  };
  const tangentOn = (pc, center) => {
    if (pc.kind === 'line') {
      const t = projectOnLine(center, P(pc.x1, pc.y1), P(pc.x2, pc.y2));
      if (t.t < -1e-6 || t.t > 1 + 1e-6) return null;
      return P(t.x, t.y);
    }
    if (pc.kind === 'circle' || pc.kind === 'arc') {
      const a = Math.atan2(center.y - pc.cy, center.x - pc.cx);
      const tp = P(pc.cx + pc.r * Math.cos(a), pc.cy + pc.r * Math.sin(a));
      if (pc.kind === 'circle') return tp;
      return angleOnPiece(pc, a) ? tp : null;
    }
    return null;
  };

  c.register('CHAMFER', async () => {
    const pk1 = await pickEntity(app, c, '选择第一条直线:', ['line']);
    if (!pk1) return;
    const pk2 = await pickEntity(app, c, '选择第二条直线:', ['line']);
    if (!pk2) return;
    const d1 = await c.awaitNumber({ prompt: '第一个倒角距离 <0>:', enterValue: 0 });
    if (d1 === CANCELLED) return;
    const d2 = await c.awaitNumber({ prompt: `第二个倒角距离 <${d1 === ENDED ? 0 : d1}>:`, enterValue: d1 === ENDED ? 0 : d1 });
    if (d2 === CANCELLED) return;
    const v1 = d1 === ENDED ? 0 : d1, v2 = d2 === ENDED ? (d1 === ENDED ? 0 : d1) : d2;
    const l1 = pk1.ent, l2 = pk2.ent;
    const corner = lineLineIntersection(P(l1.x1, l1.y1), P(l1.x2, l1.y2), P(l2.x1, l2.y1), P(l2.x2, l2.y2));
    if (!corner) { app.notify('两直线平行，无法倒角', 'error'); return; }
    scene.beginUndoGroup('倒角');
    const chamferLine = (ent, d) => {
      const a = P(ent.x1, ent.y1), b = P(ent.x2, ent.y2);
      const near = dist(corner, a) < dist(corner, b) ? a : b;
      const far = near === a ? b : a;
      const u = P((far.x - near.x) / (dist(far, near) || 1), (far.y - near.y) / (dist(far, near) || 1));
      const np = P(corner.x + u.x * d, corner.y + u.y * d);
      // 用新点替换近端点
      if (near === a) { ent.x1 = np.x; ent.y1 = np.y; } else { ent.x2 = np.x; ent.y2 = np.y; }
      scene._changed();
      return np;
    };
    const c1 = chamferLine(l1, v1);
    const c2 = chamferLine(l2, v2);
    scene.addEntity(make.line(c1, c2, { layer: l1.layer }));
    scene.endUndoGroup();
  }, ['CHA']);

  c.register('ARRAYRECT', async () => {
    const ids = await selOrPrompt(app, c);
    if (!ids || !ids.length) return;
    const rows = await c.awaitNumber({ prompt: '行数:' });
    if (rows === CANCELLED || rows === ENDED || !rows) return;
    const cols = await c.awaitNumber({ prompt: '列数:' });
    if (cols === CANCELLED || cols === ENDED || !cols) return;
    const rd = await c.awaitNumber({ prompt: '行间距:' });
    if (rd === CANCELLED || rd === ENDED) return;
    const cd = await c.awaitNumber({ prompt: '列间距:' });
    if (cd === CANCELLED || cd === ENDED) return;
    const nR = clamp(Math.round(rows), 1, 100), nC = clamp(Math.round(cols), 1, 100);
    scene.beginUndoGroup('矩形阵列');
    let count = 0;
    for (let i = 0; i < nR; i++) {
      for (let j = 0; j < nC; j++) {
        if (i === 0 && j === 0) continue;
        const newIds = scene.transformEntities(translationM(j * cd, i * rd), ids, { copy: true });
        count += newIds.length;
      }
    }
    scene.endUndoGroup();
    app.notify(`矩形阵列完成（${nR}×${nC}）`);
  }, ['AR', 'ARRAY']);

  c.register('ARRAYPOLAR', async () => {
    const ids = await selOrPrompt(app, c);
    if (!ids || !ids.length) return;
    const center = await c.awaitPoint({ prompt: '阵列中心:' });
    if (center === CANCELLED || center === ENDED || !center) return;
    const count = await c.awaitNumber({ prompt: '项目数:' });
    if (count === CANCELLED || count === ENDED || !count) return;
    const fill = await c.awaitAngle(center, { prompt: '填充角度 <360>:', enterValue: 360 });
    if (fill === CANCELLED) return;
    const n = clamp(Math.round(count), 2, 360);
    const fillA = (fill === ENDED ? 360 : fill) * D2R;
    const step = fillA / n;
    scene.beginUndoGroup('环形阵列');
    let total = 0;
    for (let k = 1; k < n; k++) {
      const newIds = scene.transformEntities(rotationM(step * k, center.x, center.y), ids, { copy: true });
      total += newIds.length;
    }
    scene.endUndoGroup();
    app.notify(`环形阵列完成（${n} 个）`);
  }, ['ARP', 'ARRAYP']);

  c.register('STRETCH', async () => {
    const p1 = await c.awaitPoint({ prompt: '交叉窗口第一角:' });
    if (p1 === CANCELLED || p1 === ENDED || !p1) return;
    const p2 = await c.awaitPoint({ prompt: '交叉窗口对角:', base: p1, preview: (ctx, q) => drawWindow(ctx, app, p1, q) });
    if (p2 === CANCELLED || p2 === ENDED || !p2) return;
    const bb = [Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.max(p1.x, p2.x), Math.max(p1.y, p2.y)];
    const inside = (p) => p.x >= bb[0] && p.x <= bb[2] && p.y >= bb[1] && p.y <= bb[3];
    const base = await c.awaitPoint({ prompt: '基点:' });
    if (base === CANCELLED || base === ENDED || !base) return;
    const dest = await c.awaitPoint({ prompt: '目标点:', base });
    if (dest === CANCELLED || dest === ENDED || !dest) return;
    const dx = dest.x - base.x, dy = dest.y - base.y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
    scene.singleOp('拉伸', () => {
      for (const e of [...scene.all()]) {
        const l = scene.layer(e.layer);
        if (!l?.on || l?.locked) continue;
        if (e.type === 'line') {
          let m = false;
          if (inside(P(e.x1, e.y1))) { e.x1 += dx; e.y1 += dy; m = true; }
          if (inside(P(e.x2, e.y2))) { e.x2 += dx; e.y2 += dy; m = true; }
          if (m) scene._changed();
        } else if (e.type === 'polyline') {
          let m = false;
          for (const p of e.points) {
            if (inside(P(p.x, p.y))) { p.x += dx; p.y += dy; m = true; }
          }
          if (m) scene._changed();
        } else if (e.type === 'circle') {
          if (inside(P(e.cx, e.cy))) { e.cx += dx; e.cy += dy; scene._changed(); }
        } else if (e.type === 'arc') {
          if (inside(P(e.cx, e.cy))) { e.cx += dx; e.cy += dy; scene._changed(); }
        } else if (e.type === 'ellipse') {
          if (inside(P(e.cx, e.cy))) { e.cx += dx; e.cy += dy; scene._changed(); }
        } else if (e.type === 'point') {
          if (inside(P(e.x, e.y))) { e.x += dx; e.y += dy; scene._changed(); }
        } else if (e.type === 'text') {
          if (inside(P(e.x, e.y))) { e.x += dx; e.y += dy; scene._changed(); }
        } else if (e.type === 'insert') {
          if (inside(P(e.x, e.y))) { e.x += dx; e.y += dy; scene._changed(); }
        }
      }
    });
  }, ['S']);

  c.register('ERASE', async () => {
    let ids = scene.selection.size ? [...scene.selection] : null;
    if (!ids || !ids.length) {
      ids = await pickMultiple(app, c, '选择要删除的对象:');
    }
    if (!ids || !ids.length) return;
    const n = ids.length;
    scene.singleOp('删除', () => scene.removeEntities(ids));
    app.notify(`已删除 ${n} 个对象`);
  }, ['E', 'DEL']);

  c.register('EXPLODE', async () => {
    const pick = await pickEntity(app, c, '选择要分解的块引用:', ['insert']);
    if (!pick) return;
    const n = scene.explodeInsert(pick.ent.id);
    app.notify(`已分解块「${pick.ent.block}」（${n} 个图元）`);
  }, ['X']);
}

export function registerTools(app) {
  const c = app.commander;
  regDraw(app, c);
  regModify(app, c);
}
