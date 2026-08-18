/* ============================================================
 * 小宝CAD 图纸场景 —— 图层 / 实体集合 / 选择集 / 撤销重做 / 块 / 序列化
 * ============================================================ */
import { Emitter, deepClone, uid, bboxUnion } from './util.js';
import { HANDLERS, transformEntity, entityBBox } from './entities.js';

export const DEFAULT_DIMSTYLE = {
  textHeight: 2.5, arrowSize: 2.5, extOffset: 0.6, extBeyond: 1.2, textOffset: 0.6,
  precision: 2, units: 'mm',
};

export class Scene extends Emitter {
  constructor() {
    super();
    this.units = 'mm';
    this.dimstyle = { ...DEFAULT_DIMSTYLE };
    this.layers = new Map();
    this.entities = new Map();
    this.blocks = new Map();
    this.selection = new Set();
    this.currentLayer = '0';
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this._undoGroup = null;
    this._changeCount = 0;
    this.ensureLayer('0', { color: '#ffffff' });
  }

  /* ---------- 图层 ---------- */
  ensureLayer(name, opts = {}) {
    if (!name) name = '0';
    if (!this.layers.has(name)) {
      this.layers.set(name, {
        name,
        color: opts.color || '#ffffff',
        on: opts.on !== false,
        locked: !!opts.locked,
        ltype: opts.ltype || 'CONTINUOUS',
      });
      this._changed(); // 新建图层进历史（可撤销）
      this.emit('layers');
    }
    return this.layers.get(name);
  }
  layer(name) { return this.layers.get(name) || null; }
  setCurrentLayer(name) { this.ensureLayer(name); this.currentLayer = name; this._changed(); this.emit('layers'); }
  addLayer(name, opts = {}) { this.ensureLayer(name, opts); this.setCurrentLayer(name); return this.layer(name); }
  removeLayer(name) {
    if (name === '0') throw new Error('不能删除 0 图层');
    const l = this.layers.get(name);
    if (!l) return;
    if (l.locked) throw new Error(`图层「${name}」被锁定，无法删除`);
    for (const e of this.entities.values()) if (e.layer === name) e.layer = '0';
    for (const b of this.blocks.values()) for (const e of b.entities.values()) if (e.layer === name) e.layer = '0';
    this.layers.delete(name);
    if (this.currentLayer === name) this.currentLayer = '0';
    this._changed();
    this.emit('layers');
  }

  /* ---------- 实体 ---------- */
  addEntity(e) {
    if (!e.id) e.id = uid();
    if (e.layer == null) e.layer = this.currentLayer;
    this.ensureLayer(e.layer);
    this.entities.set(e.id, e);
    this._changed();
    return e;
  }
  addEntities(list) { for (const e of list) this.addEntity(e); return list; }
  removeEntity(idOrE) {
    const id = typeof idOrE === 'string' ? idOrE : idOrE?.id;
    const e = this.entities.get(id);
    if (!e) return null;
    this.entities.delete(id);
    this.selection.delete(id);
    this._changed();
    this.emit('selection');
    return e;
  }
  removeEntities(ids) {
    const out = [];
    for (const id of [...ids]) { const e = this.removeEntity(id); if (e) out.push(e); }
    return out;
  }
  get(id) { return this.entities.get(id); }
  all() { return [...this.entities.values()]; }
  byType(t) { return this.all().filter((e) => e.type === t); }
  count() { return this.entities.size; }

  /* ---------- 选择 ---------- */
  select(ids, mode = 'set') {
    if (mode === 'set') {
      this.selection.clear();
      for (const id of ids) this.selection.add(id);
    } else if (mode === 'add') {
      for (const id of ids) this.selection.add(id);
    } else if (mode === 'toggle') {
      for (const id of ids) this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id);
    }
    this.emit('selection');
  }
  clearSelection() { if (this.selection.size) { this.selection.clear(); this.emit('selection'); } }
  selected() { return [...this.selection].map((id) => this.entities.get(id)).filter(Boolean); }
  selectAll() {
    const ids = [];
    for (const e of this.entities.values()) {
      const l = this.layer(e.layer);
      if (l?.on && !l?.locked) ids.push(e.id);
    }
    this.select(ids, 'set');
  }

  /* ---------- 撤销 / 重做 ---------- */
  _changed() { this._changeCount++; this.dirty = true; this.emit('change'); }
  _snapshot() {
    return {
      entities: deepClone([...this.entities.values()]),
      blocks: deepClone([...this.blocks.values()].map((b) => ({ name: b.name, baseX: b.baseX, baseY: b.baseY, entities: [...b.entities.values()] }))),
      layers: deepClone([...this.layers.values()]),
      currentLayer: this.currentLayer,
      selection: [...this.selection],
    };
  }
  _restore(snap) {
    this.entities = new Map(snap.entities.map((e) => [e.id, e]));
    this.blocks = new Map(snap.blocks.map((b) => [b.name, { name: b.name, baseX: b.baseX, baseY: b.baseY, entities: new Map(b.entities.map((e) => [e.id, e])) }]));
    if (snap.layers) this.layers = new Map(snap.layers.map((l) => [l.name, l]));
    if (snap.currentLayer != null) this.currentLayer = snap.currentLayer;
    this.selection = new Set(snap.selection || []);
    this._changed();
    this.emit('selection');
    this.emit('layers');
  }
  _pushHistory(label, before) {
    this.undoStack.push({ label, before, after: this._snapshot() });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit('history');
  }
  singleOp(label, fn) {
    if (this._undoGroup) { fn(); return; }
    const before = this._snapshot();
    const c0 = this._changeCount;
    fn();
    if (this._changeCount !== c0) this._pushHistory(label, before);
  }
  beginUndoGroup(label) {
    if (this._undoGroup) { this._undoGroup.depth++; return; }
    this._undoGroup = { label, before: this._snapshot(), c0: this._changeCount, depth: 1 };
  }
  endUndoGroup() {
    const g = this._undoGroup;
    if (!g) return;
    if (--g.depth > 0) return; // 内层 end 不关闭外层
    this._undoGroup = null;
    if (this._changeCount !== g.c0) this._pushHistory(g.label, g.before);
  }
  undo() {
    const it = this.undoStack.pop();
    if (!it) return false;
    this.redoStack.push({ label: it.label, before: it.after, after: it.before });
    this._restore(it.before);
    this.emit('history');
    return true;
  }
  redo() {
    const it = this.redoStack.pop();
    if (!it) return false;
    this.undoStack.push({ label: it.label, before: it.after, after: it.before });
    this._restore(it.before);
    this.emit('history');
    return true;
  }
  clearUndo() { this.undoStack.length = 0; this.redoStack.length = 0; this.emit('history'); }

  /* ---------- 变换 / 批量编辑 ---------- */
  /**
   * 对一组实体应用矩阵。copy=true 时复制（保留原实体）。
   * insert 在非相似变换下自动分解（__explode）。
   */
  transformEntities(matrix, ids, { copy = false, group = null } = {}) {
    const run = () => {
      const newIds = [];
      for (const id of [...ids]) {
        const e = this.entities.get(id);
        if (!e) continue;
        const t = transformEntity(e, matrix, this);
        if (t.__explode) {
          const blk = this.blocks.get(e.block);
          if (blk) {
            for (const be of blk.entities.values()) {
              const te = transformEntity(be, t.__explode, this);
              if (te.__explode) continue;
              if (te.layer === '0' || te.layer == null) te.layer = e.layer;
              delete te.id; // 块内实体 id 与场景 id 空间不同，必须去掉避免碰撞
              if (copy) { this.addEntity(te); newIds.push(te.id); }
              else this.addEntity(te);
            }
          }
          if (!copy) this.removeEntity(id);
          else newIds.push(id);
        } else if (copy) {
          const c = deepClone(t);
          delete c.id;
          this.addEntity(c);
          newIds.push(c.id);
        } else {
          this.entities.set(id, t);
          this._changed();
          newIds.push(id);
        }
      }
      return newIds;
    };
    if (group) { this.singleOp(group, run); return []; }
    return run();
  }
  moveEntities(ids, dx, dy, opts = {}) {
    return this.transformEntities({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy }, ids, opts);
  }

  /* ---------- 块 ---------- */
  addBlock(name, base, entities) {
    if (!name || this.blocks.has(name)) throw new Error(`块「${name}」已存在`);
    this.blocks.set(name, {
      name, baseX: base.x, baseY: base.y,
      entities: new Map(entities.map((e) => { const c = deepClone(e); delete c.id; c.id = uid(); return [c.id, c]; })),
    });
    this._changed();
    this.emit('blocks');
    return name;
  }
  removeBlock(name) {
    const blk = this.blocks.get(name);
    if (!blk) return;
    for (const e of [...this.entities.values()]) if (e.type === 'insert' && e.block === name) this.removeEntity(e.id);
    this.blocks.delete(name);
    this._changed();
    this.emit('blocks');
  }
  explodeInsert(id) {
    const e = this.entities.get(id);
    if (!e || e.type !== 'insert') return 0;
    const blk = this.blocks.get(e.block);
    const run = () => {
      if (!blk) return;
      // 构造插入矩阵
      let M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      const c = Math.cos(e.rotation || 0), s = Math.sin(e.rotation || 0);
      const sx = e.scaleX ?? 1, sy = e.scaleY ?? 1;
      M = {
        a: c * sx, b: s * sx,
        c: -s * sy, d: c * sy,
        e: e.x - (c * sx) * blk.baseX - (-s * sy) * blk.baseY,
        f: e.y - (s * sx) * blk.baseX - (c * sy) * blk.baseY,
      };
      for (const be of blk.entities.values()) {
        const t = transformEntity(be, M, this);
        if (t.__explode) continue;
        if (t.layer === '0' || t.layer == null) t.layer = e.layer;
        delete t.id;
        this.addEntity(t);
      }
      this.removeEntity(id);
    };
    this.singleOp('分解块', run);
    return blk ? blk.entities.size : 0;
  }

  /* ---------- 范围 / 查询 ---------- */
  extents(ids = null) {
    let bb = null;
    const list = ids ? [...ids].map((id) => this.entities.get(id)).filter(Boolean) : this.all();
    for (const e of list) {
      const l = this.layer(e.layer);
      if (!l?.on) continue;
      bb = bboxUnion(bb, entityBBox(e, this));
    }
    return bb;
  }

  /* ---------- 序列化（小宝CAD 原生格式） ---------- */
  serialize() {
    return {
      app: 'xbcad', version: 1, units: this.units,
      dimstyle: { ...this.dimstyle },
      currentLayer: this.currentLayer,
      layers: [...this.layers.values()],
      blocks: [...this.blocks.values()].map((b) => ({ name: b.name, baseX: b.baseX, baseY: b.baseY, entities: [...b.entities.values()] })),
      entities: [...this.entities.values()],
      bodies3d: this._bodies3d || null,
    };
  }
  static load(json) {
    const s = new Scene();
    if (!json || typeof json !== 'object') return s;
    if (json.units) s.units = json.units;
    s._bodies3d = json.bodies3d || null;
    if (json.dimstyle) s.dimstyle = { ...DEFAULT_DIMSTYLE, ...json.dimstyle };
    s.layers.clear();
    const defLayer = { name: '0', color: '#ffffff', on: true, locked: false, ltype: 'CONTINUOUS' };
    for (const l of json.layers || [defLayer]) {
      s.layers.set(l.name, { name: l.name, color: l.color || '#ffffff', on: l.on !== false, locked: !!l.locked, ltype: l.ltype || 'CONTINUOUS' });
    }
    if (!s.layers.has('0')) s.layers.set('0', { ...defLayer });
    s.currentLayer = json.currentLayer && s.layers.has(json.currentLayer) ? json.currentLayer : '0';
    for (const b of json.blocks || []) {
      s.blocks.set(b.name, { name: b.name, baseX: b.baseX || 0, baseY: b.baseY || 0, entities: new Map((b.entities || []).map((e) => [e.id, e])) });
    }
    s._changeCount = 0;
    for (const e of json.entities || []) {
      if (!HANDLERS[e.type]) continue;
      s.entities.set(e.id || uid(), e);
      if (e.layer == null) e.layer = '0';
      s.ensureLayer(e.layer);
    }
    s.emit('layers');
    return s;
  }
}
