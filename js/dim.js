/* ============================================================
 * 小宝CAD 尺寸标注 —— 线性/对齐/半径/直径/角度标注与标注样式
 * ============================================================ */
import { CANCELLED, ENDED } from './commands.js';
import { newEntity } from './entities.js';
import { DrawContext } from './viewport.js';
import { D2R, dist, angleOf, arcSweep, normAngle, fmt } from './util.js';

const P = (x, y) => ({ x, y });

export function registerDimTools(app) {
  const c = app.commander;
  const scene = app.scene;

  c.register('DIMLINEAR', async () => {
    const p1 = await c.awaitPoint({ prompt: '第一条尺寸界线原点:' });
    if (p1 === CANCELLED || p1 === ENDED || !p1) return;
    const p2 = await c.awaitPoint({ prompt: '第二条尺寸界线原点:', base: p1 });
    if (p2 === CANCELLED || p2 === ENDED || !p2) return;
    const p3 = await c.awaitPoint({
      prompt: '尺寸线位置:',
      preview: (ctx, q) => {
        const dc = new DrawContext(app.viewport, ctx);
        const t = newEntity('dimension', { subtype: 'linear', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: q.x, y3: q.y, angle: 0 });
        dc.drawEntity(t, { color: '#9aa0ac', dashed: true });
      },
    });
    if (p3 === CANCELLED || p3 === ENDED || !p3) return;
    scene.singleOp('线性标注', () => scene.addEntity(newEntity('dimension', {
      subtype: 'linear', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: p3.x, y3: p3.y, angle: 0,
    })));
  }, ['DLI', 'DIMLIN']);

  c.register('DIMALIGNED', async () => {
    const p1 = await c.awaitPoint({ prompt: '第一条尺寸界线原点:' });
    if (p1 === CANCELLED || p1 === ENDED || !p1) return;
    const p2 = await c.awaitPoint({ prompt: '第二条尺寸界线原点:', base: p1 });
    if (p2 === CANCELLED || p2 === ENDED || !p2) return;
    const ang = angleOf(p1, p2);
    const p3 = await c.awaitPoint({
      prompt: '尺寸线位置:', base: p2,
      preview: (ctx, q) => {
        const dc = new DrawContext(app.viewport, ctx);
        const t = newEntity('dimension', { subtype: 'linear', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: q.x, y3: q.y, angle: ang });
        dc.drawEntity(t, { color: '#9aa0ac', dashed: true });
      },
    });
    if (p3 === CANCELLED || p3 === ENDED || !p3) return;
    scene.singleOp('对齐标注', () => scene.addEntity(newEntity('dimension', {
      subtype: 'linear', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: p3.x, y3: p3.y, angle: ang,
    })));
  }, ['DAL', 'DIMALI']);

  async function pickCircleArc(subtype) {
    while (true) {
      const p = await c.awaitPoint({ prompt: '选择圆弧或圆:' });
      if (p === CANCELLED || p === ENDED) return null;
      const ent = app.viewport.hitTest(app.viewport.worldToScreen(p), 10);
      if (ent && (ent.type === 'circle' || ent.type === 'arc')) return { ent, at: p };
      app.notify('请选择圆弧或圆', 'error');
    }
  }
  c.register('DIMRADIUS', async () => {
    const pk = await pickCircleArc();
    if (!pk) return;
    const e = pk.ent;
    const c0 = P(e.cx, e.cy);
    const a = Math.atan2(pk.at.y - c0.y, pk.at.x - c0.x);
    const pt = P(c0.x + e.r * Math.cos(a), c0.y + e.r * Math.sin(a));
    const tp = await c.awaitPoint({
      prompt: '文字位置:', base: c0,
      preview: (ctx, q) => {
        const dc = new DrawContext(app.viewport, ctx);
        const t = newEntity('dimension', { subtype: 'radial', cx: c0.x, cy: c0.y, px: pt.x, py: pt.y, tx: q.x, ty: q.y });
        dc.drawEntity(t, { color: '#9aa0ac', dashed: true });
      },
    });
    if (tp === CANCELLED || tp === ENDED || !tp) return;
    scene.singleOp('半径标注', () => scene.addEntity(newEntity('dimension', {
      subtype: 'radial', cx: c0.x, cy: c0.y, px: pt.x, py: pt.y, tx: tp.x, ty: tp.y,
    })));
  }, ['DRA', 'DIMRAD']);

  c.register('DIMDIAMETER', async () => {
    const pk = await pickCircleArc();
    if (!pk) return;
    const e = pk.ent;
    const c0 = P(e.cx, e.cy);
    const a = Math.atan2(pk.at.y - c0.y, pk.at.x - c0.x);
    const pt = P(c0.x + e.r * Math.cos(a), c0.y + e.r * Math.sin(a));
    const tp = await c.awaitPoint({
      prompt: '文字位置:', base: c0,
      preview: (ctx, q) => {
        const dc = new DrawContext(app.viewport, ctx);
        const t = newEntity('dimension', { subtype: 'diametric', cx: c0.x, cy: c0.y, px: pt.x, py: pt.y, tx: q.x, ty: q.y });
        dc.drawEntity(t, { color: '#9aa0ac', dashed: true });
      },
    });
    if (tp === CANCELLED || tp === ENDED || !tp) return;
    scene.singleOp('直径标注', () => scene.addEntity(newEntity('dimension', {
      subtype: 'diametric', cx: c0.x, cy: c0.y, px: pt.x, py: pt.y, tx: tp.x, ty: tp.y,
    })));
  }, ['DDI', 'DIMDIA']);

  c.register('DIMANGULAR', async () => {
    // 优先：点选两条直线 → 自动求交点
    let l1 = null, l2 = null;
    const p1 = await c.awaitPoint({ prompt: '选择第一条直线或角度顶点:' });
    if (p1 === CANCELLED || p1 === ENDED || !p1) return;
    const e1 = app.viewport.hitTest(app.viewport.worldToScreen(p1), 10);
    if (e1?.type === 'line') l1 = e1;
    let p2;
    if (l1) {
      p2 = await c.awaitPoint({ prompt: '选择第二条直线:', base: p1 });
      if (p2 === CANCELLED || p2 === ENDED || !p2) return;
      const e2 = app.viewport.hitTest(app.viewport.worldToScreen(p2), 10);
      if (e2?.type === 'line') l2 = e2;
    }
    let cx, cy, a1x, a1y, a2x, a2y;
    if (l1 && l2) {
      // 两直线交点
      const { lineLineIntersection } = await import('./util.js');
      const I = lineLineIntersection(P(l1.x1, l1.y1), P(l1.x2, l1.y2), P(l2.x1, l2.y1), P(l2.x2, l2.y2));
      if (!I) { app.notify('两直线平行，无法标注角度', 'error'); return; }
      cx = I.x; cy = I.y;
      const d1 = P(p1.x - I.x, p1.y - I.y), d2 = P(p2.x - I.x, p2.y - I.y);
      const l1d = Math.hypot(d1.x, d1.y) || 1, l2d = Math.hypot(d2.x, d2.y) || 1;
      a1x = I.x + (d1.x / l1d) * 40; a1y = I.y + (d1.y / l1d) * 40;
      a2x = I.x + (d2.x / l2d) * 40; a2y = I.y + (d2.y / l2d) * 40;
    } else {
      cx = p1.x; cy = p1.y;
      const pa = await c.awaitPoint({ prompt: '角度第一条边端点:', base: p1 });
      if (pa === CANCELLED || pa === ENDED || !pa) return;
      const pb = await c.awaitPoint({ prompt: '角度第二条边端点:', base: p1 });
      if (pb === CANCELLED || pb === ENDED || !pb) return;
      a1x = pa.x; a1y = pa.y; a2x = pb.x; a2y = pb.y;
    }
    const arcPt = await c.awaitPoint({
      prompt: '标注弧线位置:', base: P(cx, cy),
      preview: (ctx, q) => {
        const dc = new DrawContext(app.viewport, ctx);
        const r = dist(P(cx, cy), q);
        const t = newEntity('dimension', { subtype: 'angular', cx, cy, a1x, a1y, a2x, a2y, r, tx: q.x, ty: q.y });
        dc.drawEntity(t, { color: '#9aa0ac', dashed: true });
      },
    });
    if (arcPt === CANCELLED || arcPt === ENDED || !arcPt) return;
    const r = dist(P(cx, cy), arcPt);
    scene.singleOp('角度标注', () => scene.addEntity(newEntity('dimension', {
      subtype: 'angular', cx, cy, a1x, a1y, a2x, a2y, r, tx: arcPt.x, ty: arcPt.y,
    })));
  }, ['DAN', 'DIMANG']);

  c.register('DIMSTYLE', async () => {
    const th = await c.awaitNumber({ prompt: `标注文字高度 <${scene.dimstyle.textHeight}>:`, enterValue: scene.dimstyle.textHeight });
    if (th === CANCELLED) return;
    if (th !== ENDED) scene.dimstyle.textHeight = Math.abs(th);
    const as = await c.awaitNumber({ prompt: `箭头大小 <${scene.dimstyle.arrowSize}>:`, enterValue: scene.dimstyle.arrowSize });
    if (as === CANCELLED) return;
    if (as !== ENDED) scene.dimstyle.arrowSize = Math.abs(as);
    const prec = await c.awaitNumber({ prompt: `小数位数 <${scene.dimstyle.precision}>:`, enterValue: scene.dimstyle.precision });
    if (prec === CANCELLED) return;
    if (prec !== ENDED) scene.dimstyle.precision = clampInt(prec, 0, 6);
    app.notify(`标注样式已更新（字高 ${scene.dimstyle.textHeight}）`);
    app.viewport.requestRender();
  }, ['DDIM', 'DIMST']);
  const clampInt = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
}
