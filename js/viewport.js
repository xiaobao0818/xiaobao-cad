/* ============================================================
 * 小宝CAD 视口 —— Canvas 渲染 / 缩放平移 / 栅格 / 对象捕捉 / 拾取 / 标注绘制
 * ============================================================ */
import {
  Emitter, clamp, TAU, D2R, colorToCSS, dashPattern, dist, fmt, fmtCoord, normAngle,
  bboxOfPoints, arcSweep,
} from './util.js';
import { HANDLERS, entityDistance, entityIntersections, dimMeasure, dimText } from './entities.js';

export class DrawContext {
  constructor(vp, ctx) {
    this.vp = vp;
    this.ctx = ctx;
    this.scene = vp.scene;
  }
  pt(p) { return this.vp.worldToScreen(p); }
  len(w) { return w * this.vp.scale; }
  styleFor(e, opts = {}) {
    const layer = this.scene.layers.get(e.layer) || { color: '#ffffff', ltype: 'CONTINUOUS' };
    let color = colorToCSS(e.color, layer.color);
    let ltype = e.ltype || layer.ltype || 'CONTINUOUS';
    let lw = e.lw && e.lw > 0 ? e.lw : 1;
    if (opts.selected) { color = opts.color || '#ff8c42'; lw = Math.max(lw + 1.5, 3); }
    if (opts.color) color = opts.color;
    if (opts.dashed) ltype = 'DASHED';
    return { color, ltype, lw, layer };
  }
  stroke(e, opts, pathFn) {
    const s = this.styleFor(e, opts);
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    pathFn(ctx);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.lw / this.vp.scale;
    ctx.setLineDash(dashPattern(s.ltype).map((d) => d / this.vp.scale));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }
  fill(e, opts, pathFn) {
    const s = this.styleFor(e, opts);
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    pathFn(ctx);
    ctx.fillStyle = colorToCSS(e.color, s.layer.color, 0.3);
    ctx.fill();
    ctx.restore();
  }
  fillHatch(e, opts, pathFn) {
    const s = this.styleFor(e, opts);
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    pathFn(ctx);
    if (e.solid !== false) {
      ctx.fillStyle = colorToCSS(e.color, s.layer.color, 0.28);
      ctx.fill();
    } else {
      ctx.clip();
      const bb = HANDLERS.hatch.bbox(e);
      if (bb) {
        const a = ((e.angle ?? 45) * D2R);
        const d = { x: Math.cos(a), y: Math.sin(a) }, n = { x: -Math.sin(a), y: Math.cos(a) };
        const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
        const R = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) / 2 + 4;
        const spacing = Math.max(e.spacing ?? 5, 0.5);
        const count = Math.ceil(R / spacing) + 1;
        ctx.strokeStyle = colorToCSS(e.color, s.layer.color, 0.5);
        ctx.lineWidth = 1 / this.vp.scale;
        ctx.beginPath();
        for (let k = -count; k <= count; k++) {
          const o = k * spacing;
          ctx.moveTo(cx + n.x * o - d.x * R, cy + n.y * o - d.y * R);
          ctx.lineTo(cx + n.x * o + d.x * R, cy + n.y * o + d.y * R);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  /** 屏幕空间文字绘制（世界坐标输入） */
  text(e, opts, str, x, y, height, rotation, halign = 'left', valign = 'baseline') {
    const s = this.styleFor(e, opts);
    const ctx = this.ctx;
    const sp = this.vp.worldToScreen({ x, y });
    const h = height * this.vp.scale;
    ctx.save();
    ctx.translate(sp.x, sp.y);
    ctx.rotate(-rotation);
    ctx.font = `${Math.max(h, 1)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = s.color;
    ctx.textAlign = halign === 'center' ? 'center' : halign === 'right' ? 'right' : 'left';
    ctx.textBaseline = valign === 'middle' ? 'middle' : valign === 'top' ? 'top' : valign === 'bottom' ? 'bottom' : 'alphabetic';
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }
  marker(e, opts, x, y, kind = 'point') {
    const s = this.styleFor(e, opts);
    const ctx = this.ctx;
    const sp = this.vp.worldToScreen({ x, y });
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 1;
    if (kind === 'point') {
      const r = 1.6;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, TAU);
      ctx.fill();
      const g = r + 2.5;
      ctx.beginPath();
      ctx.moveTo(sp.x - g, sp.y); ctx.lineTo(sp.x + g, sp.y);
      ctx.moveTo(sp.x, sp.y - g); ctx.lineTo(sp.x, sp.y + g);
      ctx.stroke();
    } else {
      const g = 2.5;
      ctx.beginPath();
      ctx.moveTo(sp.x - g, sp.y - g); ctx.lineTo(sp.x + g, sp.y + g);
      ctx.moveTo(sp.x - g, sp.y + g); ctx.lineTo(sp.x + g, sp.y - g);
      ctx.stroke();
    }
    ctx.restore();
  }
  drawEntity(e, opts = {}) {
    const h = HANDLERS[e.type];
    if (h?.draw) h.draw(this, e, opts);
  }
  /* ---------- 尺寸标注 ---------- */
  drawDimension(e, opts) {
    const ctx = this.ctx;
    const ds = this.scene.dimstyle || {};
    const arrow = ds.arrowSize ?? 2.5;
    const extOff = ds.extOffset ?? 0.6;
    const extBeyond = ds.extBeyond ?? 1.2;
    const textOff = ds.textOffset ?? 0.6;
    const s = this.styleFor(e, opts);
    const col = s.color;
    const arrowFn = (x, y, ang) => {
      ctx.beginPath();
      const L = arrow;
      ctx.moveTo(x + Math.cos(ang) * L, y + Math.sin(ang) * L);
      ctx.lineTo(x + Math.cos(ang + 2.5) * L * 0.38, y + Math.sin(ang + 2.5) * L * 0.38);
      ctx.lineTo(x + Math.cos(ang - 2.5) * L * 0.38, y + Math.sin(ang - 2.5) * L * 0.38);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
    };
    const line = (x1, y1, x2, y2, w) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = col;
      ctx.lineWidth = w / this.vp.scale;
      ctx.stroke();
    };

    if (e.subtype === 'linear') {
      const ang = e.angle || 0;
      const d = { x: Math.cos(ang), y: Math.sin(ang) };
      const p1 = { x: e.x1, y: e.y1 }, p2 = { x: e.x2, y: e.y2 }, p3 = { x: e.x3, y: e.y3 };
      const dot = (p) => (p.x - p3.x) * d.x + (p.y - p3.y) * d.y;
      const q1 = { x: p3.x + d.x * dot(p1), y: p3.y + d.y * dot(p1) };
      const q2 = { x: p3.x + d.x * dot(p2), y: p3.y + d.y * dot(p2) };
      const m = dimMeasure(e, ds);
      const text = m.deg ? `${fmt(m.value)}°` : fmt(m.value, ds.precision ?? 2);
      const n1 = { x: p1.x - q1.x, y: p1.y - q1.y };
      const l1 = Math.hypot(n1.x, n1.y) || 1;
      const u1 = { x: n1.x / l1, y: n1.y / l1 };
      const n2 = { x: p2.x - q2.x, y: p2.y - q2.y };
      const l2 = Math.hypot(n2.x, n2.y) || 1;
      const u2 = { x: n2.x / l2, y: n2.y / l2 };
      // 尺寸界线
      line(p1.x + u1.x * extOff, p1.y + u1.y * extOff, q1.x + u1.x * extBeyond, q1.y + u1.y * extBeyond, 1);
      line(p2.x + u2.x * extOff, p2.y + u2.y * extOff, q2.x + u2.x * extBeyond, q2.y + u2.y * extBeyond, 1);
      // 尺寸线
      const mid = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 };
      const tw = text.length * (ds.textHeight ?? 2.5) * 0.62;
      const gap = tw / 2 + arrow * 1.4;
      const len2 = dist(q1, q2);
      let a1 = q1, a2 = q2, flip = false;
      let t1 = q1, t2 = q2;
      if (len2 > gap * 2 + arrow) {
        t1 = { x: mid.x - d.x * gap, y: mid.y - d.y * gap };
        t2 = { x: mid.x + d.x * gap, y: mid.y + d.y * gap };
      } else {
        flip = true;
        const gap2 = gap + arrow * 1.6;
        a1 = { x: mid.x - d.x * gap2, y: mid.y - d.y * gap2 };
        a2 = { x: mid.x + d.x * gap2, y: mid.y + d.y * gap2 };
        t1 = a1; t2 = a2;
      }
      line(a1.x, a1.y, t1.x, t1.y, 1.2);
      line(t2.x, t2.y, a2.x, a2.y, 1.2);
      if (!flip) {
        arrowFn(a1.x, a1.y, ang + Math.PI);
        arrowFn(a2.x, a2.y, ang);
      } else {
        arrowFn(a1.x, a1.y, ang);
        arrowFn(a2.x, a2.y, ang + Math.PI);
      }
      this.text(e, opts, text, mid.x, mid.y, ds.textHeight ?? 2.5, ang, 'center', 'middle');
      return;
    }
    if (e.subtype === 'radial' || e.subtype === 'diametric') {
      const C = { x: e.cx, y: e.cy };
      const P = { x: e.px, y: e.py };
      const P2 = { x: 2 * C.x - P.x, y: 2 * C.y - P.y };
      const r = dist(C, P);
      const text = e.subtype === 'radial' ? `R${fmt(r, ds.precision ?? 2)}` : `Ø${fmt(2 * r, ds.precision ?? 2)}`;
      const tp = { x: e.tx ?? C.x + r, y: e.ty ?? C.y + r };
      if (e.subtype === 'radial') {
        const ang = Math.atan2(P.y - C.y, P.x - C.x);
        arrowFn(P.x, P.y, ang + Math.PI);
        line(P.x, P.y, C.x, C.y, 1);
        line(C.x, C.y, tp.x, tp.y, 1);
      } else {
        const ang1 = Math.atan2(P.y - C.y, P.x - C.x);
        arrowFn(P.x, P.y, ang1 + Math.PI);
        arrowFn(P2.x, P2.y, ang1);
        line(P.x, P.y, P2.x, P2.y, 1);
      }
      this.text(e, opts, text, tp.x, tp.y, ds.textHeight ?? 2.5, 0, 'left', 'middle');
      return;
    }
    if (e.subtype === 'angular') {
      const C = { x: e.cx, y: e.cy };
      const a1 = Math.atan2(e.a1y - C.y, e.a1x - C.x);
      const a2 = Math.atan2(e.a2y - C.y, e.a2x - C.x);
      const r = e.r || Math.min(dist(C, { x: e.a1x, y: e.a1y }), dist(C, { x: e.a2x, y: e.a2y }));
      const m = dimMeasure(e, ds);
      const text = `${fmt(m.value, ds.precision ?? 1)}°`;
      const tp = { x: e.tx ?? C.x, y: e.ty ?? C.y };
      const end1 = { x: C.x + r * Math.cos(a1), y: C.y + r * Math.sin(a1) };
      const end2 = { x: C.x + r * Math.cos(a2), y: C.y + r * Math.sin(a2) };
      // 延伸线
      const ext = r * 0.45;
      line(C.x + Math.cos(a1) * (r - ext), C.y + Math.sin(a1) * (r - ext), end1.x, end1.y, 1);
      line(C.x + Math.cos(a2) * (r - ext), C.y + Math.sin(a2) * (r - ext), end2.x, end2.y, 1);
      ctx.beginPath();
      const sweep = arcSweep(a1, a2);
      ctx.arc(C.x, C.y, r, a1, a1 + sweep);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2 / this.vp.scale;
      ctx.stroke();
      arrowFn(end1.x, end1.y, a1 + Math.PI / 2);
      arrowFn(end2.x, end2.y, a2 - Math.PI / 2);
      const midA = a1 + sweep / 2;
      this.text(e, opts, text, tp.x, tp.y, ds.textHeight ?? 2.5, 0, 'center', 'middle');
      return;
    }
  }
}

/* ---------------- 视口 ---------------- */
export class Viewport extends Emitter {
  constructor(canvas, scene) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = scene;
    this.dpr = window.devicePixelRatio || 1;
    this.scale = 2; // px / 世界单位
    this.center = { x: 0, y: 0 };
    this.bgColor = '#14151a';
    this.minorGridColor = '#1c1d24';
    this.majorGridColor = '#23252e';
    this.axisColor = '#434757';
    this.gridOn = true;
    this.snapGridOn = false;
    this.ortho = false;
    this.osnap = {
      enabled: true, endpoint: true, midpoint: true, center: true, quadrant: false,
      intersection: true, nearest: false, node: true,
    };
    this.osnapTol = 10;
    this.cursor = { x: -100, y: -100, world: { x: 0, y: 0 }, snap: null, visible: false };
    this.previewFn = null;
    this.tempMarkers = [];
    this.basePoint = null;
    this._raf = null;
    this.resize();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.w = r.width;
    this.h = r.height;
    this.requestRender();
  }
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }

  /* ---------- 坐标变换 ---------- */
  worldToScreen(p) {
    return {
      x: (p.x - this.center.x) * this.scale + this.w / 2,
      y: this.h / 2 - (p.y - this.center.y) * this.scale,
    };
  }
  screenToWorld(s) {
    return {
      x: (s.x - this.w / 2) / this.scale + this.center.x,
      y: (this.h / 2 - s.y) / this.scale + this.center.y,
    };
  }
  applyWorldTransform(ctx) {
    ctx.scale(this.scale, -this.scale);
    ctx.translate(this.w / 2 / this.scale - this.center.x, -this.h / 2 / this.scale - this.center.y);
  }
  visibleWorldRect() {
    const c1 = this.screenToWorld({ x: 0, y: 0 });
    const c2 = this.screenToWorld({ x: this.w, y: this.h });
    return [Math.min(c1.x, c2.x), Math.min(c1.y, c2.y), Math.max(c1.x, c2.x), Math.max(c1.y, c2.y)];
  }

  /* ---------- 视图操作 ---------- */
  zoomAt(sx, sy, factor) {
    const w = this.screenToWorld({ x: sx, y: sy });
    const s = clamp(this.scale * factor, 1e-4, 1e7);
    this.scale = s;
    this.center = {
      x: w.x - (sx - this.w / 2) / s,
      y: w.y + (sy - this.h / 2) / s,
    };
    this.requestRender();
    this.emit('view');
  }
  zoomBy(factor) { this.zoomAt(this.w / 2, this.h / 2, factor); }
  panByScreen(dx, dy) {
    this.center.x -= dx / this.scale;
    this.center.y += dy / this.scale;
    this.requestRender();
    this.emit('view');
  }
  panByWorld(dx, dy) { this.center.x += dx; this.center.y += dy; this.requestRender(); this.emit('view'); }
  centerOn(x, y) { this.center = { x, y }; this.requestRender(); this.emit('view'); }
  zoomExtents(margin = 1.12) {
    const bb = this.scene.extents();
    if (!bb) { this.scale = 2; this.center = { x: 0, y: 0 }; this.requestRender(); this.emit('view'); return; }
    const w = bb[2] - bb[0] || 1, h = bb[3] - bb[1] || 1;
    const s = Math.min(this.w / (w * margin), this.h / (h * margin));
    this.scale = clamp(s, 1e-4, 1e7);
    this.center = { x: (bb[0] + bb[2]) / 2, y: (bb[1] + bb[3]) / 2 };
    this.requestRender();
    this.emit('view');
  }
  zoomWindow(s1, s2) {
    const w1 = this.screenToWorld(s1), w2 = this.screenToWorld(s2);
    const bb = bboxOfPoints([w1, w2]);
    if (!bb) return;
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    if (w < 1e-9 || h < 1e-9) return;
    this.scale = clamp(Math.min(this.w / w, this.h / h), 1e-4, 1e7);
    this.center = { x: (bb[0] + bb[2]) / 2, y: (bb[1] + bb[3]) / 2 };
    this.requestRender();
    this.emit('view');
  }

  /* ---------- 栅格 ---------- */
  gridSpacing() {
    const target = 45 / this.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    for (const m of [1, 2, 5, 10]) {
      if (pow * m >= target) return pow * m;
    }
    return pow * 10;
  }

  /* ---------- 拾取 / 捕捉 ---------- */
  hitTest(screenP, tolPx = 8) {
    const w = this.screenToWorld(screenP);
    const tol = tolPx / this.scale;
    let best = null, bestD = Infinity;
    const list = this.scene.all();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      const l = this.scene.layer(e.layer);
      if (!l?.on || l?.locked) continue;
      const d = entityDistance(e, w, this.scene);
      if (d != null && d <= tol && d < bestD) { bestD = d; best = e; }
    }
    return best;
  }
  snapCandidates(worldP, tolWorld) {
    const out = [];
    const os = this.osnap;
    const ok = (t) => {
      if (t === 'nearest') return os.nearest;
      if (t === 'intersection') return os.intersection;
      return os[t];
    };
    for (const e of this.scene.all()) {
      const l = this.scene.layer(e.layer);
      if (!l?.on || l?.locked) continue;
      const h = HANDLERS[e.type];
      if (!h?.snap) continue;
      const cands = h.snap(e, worldP, tolWorld);
      for (const c of cands) {
        if (c.type === 'node' ? os.node : ok(c.type)) out.push({ ...c, entity: e });
      }
    }
    // 交点捕捉
    if (os.intersection && this.scene.count() <= 400) {
      const near = this.scene.all().filter((e) => {
        const l = this.scene.layer(e.layer);
        return l?.on && !l?.locked && ['line', 'circle', 'arc', 'polyline', 'ellipse'].includes(e.type);
      });
      for (let i = 0; i < near.length && out.length < 40; i++) {
        for (let j = i + 1; j < near.length; j++) {
          if (out.length >= 40) break;
          for (const p of entityIntersections(near[i], near[j], this.scene)) {
            if (dist(p, worldP) <= tolWorld) out.push({ x: p.x, y: p.y, type: 'intersection', entity: near[i] });
          }
        }
      }
    }
    out.sort((a, b) => dist(a, worldP) - dist(b, worldP));
    return out;
  }
  getEffectivePoint(screenP, opts = {}) {
    const world = this.screenToWorld(screenP);
    const tolWorld = (opts.tolPx ?? this.osnapTol) / this.scale;
    let p = world;
    let snap = null;
    if (this.osnap.enabled && opts.snap !== false) {
      const cands = this.snapCandidates(world, tolWorld);
      if (cands.length) {
        snap = cands[0];
        p = { x: snap.x, y: snap.y };
      }
    }
    if (!snap && this.snapGridOn && opts.snapGrid !== false) {
      const g = this.gridSpacing();
      p = { x: Math.round(world.x / g) * g, y: Math.round(world.y / g) * g };
      snap = { ...p, type: 'grid' };
    }
    const base = opts.base || this.basePoint;
    if ((opts.ortho ?? this.ortho) && base) {
      const dx = p.x - base.x, dy = p.y - base.y;
      if (Math.abs(dx) > Math.abs(dy)) p = { x: p.x, y: base.y };
      else p = { x: base.x, y: p.y };
      snap = null;
    }
    this.cursor.snap = snap;
    return p;
  }

  /* ---------- 渲染 ---------- */
  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.save();
    this.applyWorldTransform(ctx);
    this._drawGrid(ctx);
    this._drawEntities(ctx);
    if (this.previewFn) {
      try { this.previewFn(ctx); } catch (err) { console.error('[preview]', err); }
    }
    this._drawTempMarkers(ctx);
    ctx.restore();
    this._drawCursor(ctx);
  }
  _drawGrid(ctx) {
    const s = this.gridSpacing();
    const vr = this.visibleWorldRect();
    if (!this.gridOn || s * this.scale < 6) return;
    const x0 = Math.floor(vr[0] / s) * s, x1 = vr[2];
    const y0 = Math.floor(vr[1] / s) * s, y1 = vr[3];
    // 细栅格
    ctx.strokeStyle = this.minorGridColor;
    ctx.lineWidth = 1 / this.scale;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += s) { ctx.moveTo(x, vr[1]); ctx.lineTo(x, vr[3]); }
    for (let y = y0; y <= y1; y += s) { ctx.moveTo(vr[0], y); ctx.lineTo(vr[2], y); }
    ctx.stroke();
    // 主栅格
    const sm = s * 5;
    ctx.strokeStyle = this.majorGridColor;
    ctx.beginPath();
    for (let x = Math.floor(vr[0] / sm) * sm; x <= x1; x += sm) { ctx.moveTo(x, vr[1]); ctx.lineTo(x, vr[3]); }
    for (let y = Math.floor(vr[1] / sm) * sm; y <= y1; y += sm) { ctx.moveTo(vr[0], y); ctx.lineTo(vr[2], y); }
    ctx.stroke();
    // 坐标轴
    ctx.strokeStyle = this.axisColor;
    ctx.lineWidth = 1.2 / this.scale;
    ctx.beginPath();
    ctx.moveTo(vr[0], 0); ctx.lineTo(vr[2], 0);
    ctx.moveTo(0, vr[1]); ctx.lineTo(0, vr[3]);
    ctx.stroke();
  }
  _drawEntities(ctx) {
    const dc = new DrawContext(this, ctx);
    // 先画填充
    for (const e of this.scene.entities.values()) {
      const l = this.scene.layer(e.layer);
      if (!l?.on || e.type !== 'hatch') continue;
      dc.drawEntity(e, { selected: this.scene.selection.has(e.id) });
    }
    for (const e of this.scene.entities.values()) {
      const l = this.scene.layer(e.layer);
      if (!l?.on || e.type === 'hatch') continue;
      dc.drawEntity(e, { selected: this.scene.selection.has(e.id) });
    }
    this._drawGrips(dc);
  }
  _drawGrips(dc) {
    const ctx = dc.ctx;
    for (const id of this.scene.selection) {
      const e = this.scene.get(id);
      if (!e) continue;
      const pts = [];
      if (e.type === 'line') pts.push({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 });
      else if (e.type === 'circle') { const c = { x: e.cx, y: e.cy }; pts.push(c, { x: e.cx + e.r, y: e.cy }, { x: e.cx, y: e.cy + e.r }, { x: e.cx - e.r, y: e.cy }, { x: e.cx, y: e.cy - e.r }); }
      else if (e.type === 'arc') { const c = { x: e.cx, y: e.cy }; pts.push(c, { x: e.cx + e.r * Math.cos(e.startAngle), y: e.cy + e.r * Math.sin(e.startAngle) }, { x: e.cx + e.r * Math.cos(e.endAngle), y: e.cy + e.r * Math.sin(e.endAngle) }); }
      else if (e.type === 'polyline') pts.push(...e.points.map((p) => ({ x: p.x, y: p.y })));
      else if (e.type === 'text') pts.push({ x: e.x, y: e.y });
      else if (e.type === 'ellipse') pts.push({ x: e.cx, y: e.cy });
      else if (e.type === 'insert') pts.push({ x: e.x, y: e.y });
      else continue;
      ctx.save();
      const g = 4 / this.scale;
      ctx.fillStyle = '#ff8c42';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1 / this.scale;
      for (const p of pts) {
        ctx.beginPath();
        ctx.rect(p.x - g / 2, p.y - g / 2, g, g);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  _drawTempMarkers(ctx) {
    for (const mk of this.tempMarkers) {
      const sp = this.worldToScreen(mk);
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 1.5;
      const g = 4;
      ctx.beginPath();
      ctx.moveTo(sp.x - g, sp.y - g); ctx.lineTo(sp.x + g, sp.y + g);
      ctx.moveTo(sp.x - g, sp.y + g); ctx.lineTo(sp.x + g, sp.y - g);
      ctx.stroke();
      ctx.restore();
    }
  }
  _drawCursor(ctx) {
    if (!this.cursor.visible) return;
    const { x, y } = this.cursor;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, this.h);
    ctx.moveTo(0, y); ctx.lineTo(this.w, y);
    ctx.stroke();
    ctx.restore();
    // 捕捉标记
    if (this.cursor.snap) {
      const sp = this.worldToScreen(this.cursor.snap);
      this._drawSnapGlyph(ctx, sp, this.cursor.snap.type);
    }
    // 坐标提示
    const wx = this.cursor.world.x, wy = this.cursor.world.y;
    const label = `${fmt(wx, 3)}, ${fmt(wy, 3)}`;
    ctx.save();
    ctx.font = '11px "SF Mono", Menlo, monospace';
    const tw = ctx.measureText(label).width;
    const bx = Math.min(x + 14, this.w - tw - 8), by = Math.min(y + 16, this.h - 18);
    ctx.fillStyle = 'rgba(20,21,26,.85)';
    ctx.fillRect(bx - 3, by - 11, tw + 8, 15);
    ctx.fillStyle = '#d8dae0';
    ctx.fillText(label, bx, by);
    ctx.restore();
  }
  _drawSnapGlyph(ctx, sp, type) {
    const g = 6;
    ctx.save();
    ctx.lineWidth = 1.6;
    if (type === 'endpoint') { ctx.strokeStyle = '#7ee08a'; ctx.strokeRect(sp.x - g / 2, sp.y - g / 2, g, g); }
    else if (type === 'midpoint') {
      ctx.strokeStyle = '#7ee08a';
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y - g / 2); ctx.lineTo(sp.x + g / 2, sp.y + g / 2); ctx.lineTo(sp.x - g / 2, sp.y + g / 2);
      ctx.closePath(); ctx.stroke();
    }
    else if (type === 'center') {
      ctx.strokeStyle = '#ffd166';
      ctx.beginPath(); ctx.arc(sp.x, sp.y, g / 2, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sp.x - g / 2, sp.y); ctx.lineTo(sp.x + g / 2, sp.y); ctx.moveTo(sp.x, sp.y - g / 2); ctx.lineTo(sp.x, sp.y + g / 2); ctx.stroke();
    }
    else if (type === 'quadrant') {
      ctx.strokeStyle = '#ffd166';
      ctx.beginPath(); ctx.moveTo(sp.x, sp.y - g / 2); ctx.lineTo(sp.x + g / 2, sp.y); ctx.lineTo(sp.x, sp.y + g / 2); ctx.lineTo(sp.x - g / 2, sp.y); ctx.closePath(); ctx.stroke();
    }
    else if (type === 'intersection') {
      ctx.strokeStyle = '#ff8c42';
      ctx.beginPath(); ctx.moveTo(sp.x - g / 2, sp.y - g / 2); ctx.lineTo(sp.x + g / 2, sp.y + g / 2); ctx.moveTo(sp.x - g / 2, sp.y + g / 2); ctx.lineTo(sp.x + g / 2, sp.y - g / 2); ctx.stroke();
    }
    else if (type === 'nearest') {
      ctx.strokeStyle = '#5db3ff';
      ctx.beginPath(); ctx.moveTo(sp.x - g / 2, sp.y - g / 2); ctx.lineTo(sp.x + g / 2, sp.y - g / 2); ctx.lineTo(sp.x, sp.y + g / 2); ctx.closePath(); ctx.stroke();
    }
    else if (type === 'node') {
      ctx.strokeStyle = '#5db3ff';
      ctx.beginPath(); ctx.arc(sp.x, sp.y, g / 2, 0, TAU); ctx.stroke();
    }
    else if (type === 'grid') {
      ctx.strokeStyle = '#9aa0ac';
      ctx.strokeRect(sp.x - g / 2, sp.y - g / 2, g, g);
    }
    ctx.restore();
  }

  /* ---------- 导出 ---------- */
  toPNG(white = false) {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const ctx = c.getContext('2d');
    if (white) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(this.canvas, 0, 0);
    return c;
  }
}
