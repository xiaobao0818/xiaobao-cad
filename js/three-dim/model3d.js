/* ============================================================
 * 小宝CAD 3D 文档模型 —— 实体列表 / 撤销重做 / 内核求值 / 序列化
 * body: { id, label, kind: 'box'|'cylinder'|'sphere'|'cone'|'torus'|'boolean',
 *         params: {...} | {op, a, b[]}, color, visible }
 * ============================================================ */
import { Emitter, deepClone, uid } from '../util.js';

const PRIM_COLORS = ['#7fb2e8', '#8fd3a8', '#f2c76e', '#e88b8b', '#b9a3f0', '#7fd7d3', '#e0a6d3'];

export class Model3D extends Emitter {
  constructor() {
    super();
    this.bodies = [];
    this.selection = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.kernel = null;
    this._kernelIds = new Map(); // modelId → kernel bodyId
    this._booleanFailed = new Set(); // 求值失败的布尔实体（其输入保持可见）
    this._dirty = true;
    this._labelCounter = { box: 0, cylinder: 0, sphere: 0, cone: 0, torus: 0, boolean: 0, fillet: 0, chamfer: 0 };
  }
  setKernel(k) { this.kernel = k; this._dirty = true; }
  get kernelReady() { return !!this.kernel; }

  _nextLabel(kind) {
    const names = { box: '长方体', cylinder: '圆柱', sphere: '球', cone: '圆锥', torus: '圆环', boolean: '布尔', fillet: '圆角', chamfer: '倒角' };
    this._labelCounter[kind] = (this._labelCounter[kind] || 0) + 1;
    return `${names[kind] || kind}${this._labelCounter[kind]}`;
  }
  _changed() { this._changeCount = (this._changeCount || 0) + 1; this._dirty = true; this.emit('change'); }

  /* ---------- 快照 / 撤销 ---------- */
  _snapshot() {
    return deepClone({ bodies: this.bodies, labelCounter: this._labelCounter, selection: [...this.selection] });
  }
  _restore(s) {
    this.bodies = s.bodies;
    this._labelCounter = s.labelCounter;
    this.selection = new Set(s.selection || []);
    this._booleanFailed = new Set();
    // 撤销/重做后导入体的内核引用已失效，标记为需重新导入
    for (const b of this.bodies) if (b.kind === 'imported') b._kids = null;
    this._changed();
    this.emit('selection');
  }
  _push(label, before) {
    this.undoStack.push({ label, before, after: this._snapshot() });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit('history');
  }
  singleOp(label, fn) {
    const before = this._snapshot();
    fn();
    this._push(label, before);
    this._changed();
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

  /* ---------- 操作 ---------- */
  addPrimitive(kind, params, opts = {}) {
    const body = {
      id: uid(), label: this._nextLabel(kind), kind, params: { ...params },
      color: opts.color || PRIM_COLORS[this.bodies.length % PRIM_COLORS.length],
      visible: true,
    };
    this.singleOp(`创建${body.label}`, () => { this.bodies.push(body); this.select([body.id]); });
    return body;
  }
  boolean(op, aId, bIds, opts = {}) {
    const a = this.byId(aId);
    if (!a) throw new Error('第一个实体不存在');
    if (bIds.includes(aId)) throw new Error('布尔运算的输入实体不能相同');
    const bs = bIds.map((id) => this.byId(id)).filter(Boolean);
    if (!bs.length) throw new Error('第二个实体不存在');
    const names = { fuse: '并集', cut: '差集', common: '交集' };
    const body = {
      id: uid(), label: this._nextLabel('boolean'), kind: 'boolean',
      params: { op, a: aId, b: [...bIds] },
      color: opts.color || a.color, visible: true,
    };
    this.singleOp(`${names[op] || op}`, () => {
      // 特征树方式：输入实体保留（被消费，不渲染），结果实体新增
      this.bodies.push(body);
      this.select([body.id]);
    });
    return body;
  }
  /** 圆角/倒角特征：对源实体所有棱边做圆角(fillet)/倒角(chamfer)，源被消费 */
  filletChamfer(kind, aId, size) {
    const a = this.byId(aId);
    if (!a) throw new Error('目标实体不存在');
    if (!(size > 0)) throw new Error('圆角/倒角尺寸必须大于 0');
    const names = { fillet: '圆角', chamfer: '倒角' };
    const body = {
      id: uid(), label: this._nextLabel(kind), kind,
      params: { a: aId, r: size },
      color: a.color, visible: true,
    };
    this.singleOp(`${names[kind] || kind}`, () => {
      this.bodies.push(body);
      this.select([body.id]);
    });
    return body;
  }
  /** 被布尔运算消费的实体集合（求值失败的布尔不消费其输入） */
  consumedSet() {
    const consumed = new Set();
    for (const b of this.bodies) {
      if ((b.kind === 'boolean' || b.kind === 'fillet' || b.kind === 'chamfer') && !this._booleanFailed.has(b.id)) {
        consumed.add(b.params.a);
        for (const id of b.params.b || []) consumed.add(id);
      }
    }
    return consumed;
  }
  /** 依赖某实体的布尔结果（删除时级联） */
  _dependents(id, acc = new Set()) {
    for (const b of this.bodies) {
      if ((b.kind === 'boolean' || b.kind === 'fillet' || b.kind === 'chamfer') && (b.params.a === id || (b.params.b || []).includes(id))) {
        if (!acc.has(b.id)) {
          acc.add(b.id);
          this._dependents(b.id, acc);
        }
      }
    }
    return acc;
  }
  /** 可见（未被消费、且求值未失败）实体数 */
  visibleCount() {
    const consumed = this.consumedSet();
    return this.bodies.filter((b) => !consumed.has(b.id) && !((b.kind === 'boolean' || b.kind === 'fillet' || b.kind === 'chamfer') && this._booleanFailed.has(b.id))).length;
  }
  transformBody(id, t) {
    const b = this.byId(id);
    if (!b) throw new Error('实体不存在');
    this.singleOp('变换', () => {
      b.transform = b.transform || {};
      if (t.scale != null && t.scale !== 1) b.transform.scale = (b.transform.scale || 1) * t.scale;
      for (const k of ['dx', 'dy', 'dz', 'rx', 'ry', 'rz']) {
        if (t[k]) b.transform[k] = (b.transform[k] || 0) + t[k];
      }
    });
  }
  setColor(id, color) {
    const b = this.byId(id);
    if (!b) return;
    this.singleOp('改颜色', () => { b.color = color; });
  }
  setParam(id, key, value) {
    const b = this.byId(id);
    if (!b || b.kind === 'boolean') return;
    this.singleOp('改参数', () => { b.params[key] = value; });
  }
  /** 失败回滚用：删除实体但不产生历史（避免 undo 复活失败节点） */
  purgeBody(id) {
    const toRemove = new Set([id, ...this._dependents(id)]);
    this.bodies = this.bodies.filter((x) => !toRemove.has(x.id));
    for (const rid of toRemove) this.selection.delete(rid);
    for (const rid of toRemove) {
      if (this._kernelIds.has(rid)) {
        try { for (const k of [].concat(this._kernelIds.get(rid))) this.kernel?.deleteBody(k); } catch (e) { /* 忽略 */ }
        this._kernelIds.delete(rid);
      }
    }
    this._booleanFailed.delete(id);
    // 清洗历史：去掉快照中的被清实体，丢弃变化为空的历史条目
    const strip = (snap) => { snap.bodies = snap.bodies.filter((b) => !toRemove.has(b.id)); return snap; };
    const eq = (a, b) => a.bodies.length === b.bodies.length && a.bodies.every((x, i) => x.id === b.bodies[i].id);
    this.undoStack = this.undoStack
      .map((e) => { strip(e.after); strip(e.before); return e; })
      .filter((e) => !eq(e.before, e.after));
    this._changed();
    this.emit('selection');
  }
  removeBody(id) {
    const b = this.byId(id);
    if (!b) return;
    this.singleOp('删除实体', () => {
      const toRemove = new Set([id, ...this._dependents(id)]);
      this.bodies = this.bodies.filter((x) => !toRemove.has(x.id));
      for (const rid of toRemove) this.selection.delete(rid);
    });
  }
  removeSelection() {
    const ids = [...this.selection];
    if (!ids.length) return 0;
    this.singleOp('删除实体', () => {
      const toRemove = new Set(ids);
      for (const id of ids) for (const d of this._dependents(id)) toRemove.add(d);
      this.bodies = this.bodies.filter((x) => !toRemove.has(x.id));
      for (const rid of toRemove) this.selection.delete(rid);
    });
    return ids.length;
  }
  select(ids, mode = 'set') {
    if (mode === 'set') this.selection = new Set(ids);
    else if (mode === 'add') ids.forEach((id) => this.selection.add(id));
    else if (mode === 'toggle') ids.forEach((id) => (this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id)));
    this.emit('selection');
  }
  byId(id) { return this.bodies.find((b) => b.id === id) || null; }
  count() { return this.bodies.length; }
  clear() {
    this.singleOp('清空', () => { this.bodies = []; this.selection.clear(); });
  }

  /* ---------- 求值：模型 → 内核 ---------- */
  /** 重建内核实体并生成网格；返回 [{modelId, positions, indices, color}] */
  evaluate() {
    if (!this.kernel) return [];
    // 1) 处理导入体：保留其内核实体（跨求值复用），失效则重新导入
    for (const b of this.bodies) {
      if (b.kind !== 'imported') continue;
      if (!b._kids || !b._kids.length) {
        // 重新导入前先释放旧内核实体（undo/redo 强制重导时否则泄漏 WASM 堆）
        const old = this._kernelIds.get(b.id);
        if (old) {
          try { for (const k of [].concat(old)) this.kernel.deleteBody(k); } catch (e) { /* 忽略 */ }
          this._kernelIds.delete(b.id);
        }
        try {
          b._kids = this.kernel.importSTEP(b._bytes);
          this._kernelIds.set(b.id, b._kids);
        } catch (e) {
          console.warn('[3d] STEP 重新导入失败', e);
        }
      }
      this._kernelIds.set(b.id, b._kids);
    }
    // 2) 删除所有非导入体的旧内核实体
    for (const [mid, kid] of [...this._kernelIds]) {
      const b = this.byId(mid);
      if (b && b.kind === 'imported') continue;
      for (const k of [].concat(kid)) {
        try { this.kernel.deleteBody(k); } catch (e) { /* 忽略 */ }
      }
      this._kernelIds.delete(mid);
    }
    // 3) 第一遍：按顺序求值（创建内核实体、执行布尔、记录成败）
    for (const b of this.bodies) {
      try {
        if (b.kind === 'boolean') {
          const aKid = this._kernelIds.get(b.params.a);
          const bKids = b.params.b.map((id) => this._kernelIds.get(id)).filter((x) => x != null);
          if (aKid == null || !bKids.length) { this._booleanFailed.add(b.id); continue; }
          const aList = [].concat(aKid);
          const tools = [...aList.slice(1), ...bKids.flat()];
          const kid = this.kernel.boolean(b.params.op, aList[0], tools);
          if (b.transform) this.kernel.transform(kid, b.transform);
          // 空结果立即验证：网格化失败或为空 → 视为布尔失败
          try {
            const m = this.kernel.mesh(kid, { linearDeflection: 0.4, angularDeflection: 0.4 });
            if (!m.indices.length) throw new Error('布尔结果为空（实体可能不相交）');
            this._kernelIds.set(b.id, kid);
            this._booleanFailed.delete(b.id);
          } catch (err) {
            try { this.kernel.deleteBody(kid); } catch (e2) { /* 忽略 */ }
            throw err;
          }
        } else if (b.kind === 'imported') {
          // 已注册（第一步处理），无需操作
        } else if (b.kind === 'fillet' || b.kind === 'chamfer') {
          const aKid = this._kernelIds.get(b.params.a);
          if (aKid == null) { this._booleanFailed.add(b.id); continue; }
          const aList = [].concat(aKid);
          const kid = this.kernel[b.kind](aList[0], b.params.r);
          if (b.transform) this.kernel.transform(kid, b.transform);
          try {
            const m = this.kernel.mesh(kid, { linearDeflection: 0.4, angularDeflection: 0.4 });
            if (!m.indices.length) throw new Error('圆角/倒角结果为空');
            this._kernelIds.set(b.id, kid);
            this._booleanFailed.delete(b.id);
          } catch (err) {
            try { this.kernel.deleteBody(kid); } catch (e2) { /* 忽略 */ }
            throw err;
          }
        } else {
          const kid = this.kernel['create' + b.kind[0].toUpperCase() + b.kind.slice(1)](b.params);
          if (b.transform) this.kernel.transform(kid, b.transform);
          this._kernelIds.set(b.id, kid);
        }
      } catch (e) {
        console.warn('[3d] 求值失败', b.label, e);
        if (b.kind === 'boolean') {
          this._booleanFailed.add(b.id);
          if (this._kernelIds.has(b.id)) {
            try { this.kernel.deleteBody(this._kernelIds.get(b.id)); } catch (e2) { /* 忽略 */ }
            this._kernelIds.delete(b.id);
          }
        }
      }
    }
    // 4) 第二遍：按最终成败网格化可见实体
    const consumed = this.consumedSet();
    const meshes = [];
    for (const b of this.bodies) {
      if (consumed.has(b.id)) continue;
      if ((b.kind === 'boolean' || b.kind === 'fillet' || b.kind === 'chamfer') && this._booleanFailed.has(b.id)) continue;
      try {
        const kids = this._kernelIds.get(b.id);
        if (kids == null) continue;
        for (const kid of [].concat(kids)) {
          const m = this.kernel.mesh(kid, { linearDeflection: 0.4, angularDeflection: 0.4 });
          if (m.indices.length) meshes.push({ modelId: b.id, positions: m.positions, indices: m.indices, color: b.color });
        }
      } catch (e) {
        console.warn('[3d] 网格化失败', b.label, e);
      }
    }
    this._dirty = false;
    return meshes;
  }
  extents() {
    if (!this.kernel) return null;
    const consumed = this.consumedSet();
    let bb = null;
    for (const [mid, kids] of this._kernelIds) {
      if (consumed.has(mid)) continue; // 被布尔消费的输入体不参与范围计算
      for (const kid of [].concat(kids)) {
        try {
          const b = this.kernel.bbox(kid);
          bb = bb
            ? {
                minX: Math.min(bb.minX, b.minX), minY: Math.min(bb.minY, b.minY), minZ: Math.min(bb.minZ, b.minZ),
                maxX: Math.max(bb.maxX, b.maxX), maxY: Math.max(bb.maxY, b.maxY), maxZ: Math.max(bb.maxZ, b.maxZ),
              }
            : b;
        } catch (e) { /* 忽略 */ }
      }
    }
    return bb;
  }
  summary() {
    const consumed = this.consumedSet();
    const lines = [`3D 模型摘要（${this.visibleCount()} 个可见实体 / ${this.bodies.length} 个特征）`];
    for (const b of this.bodies) {
      if (b.kind === 'boolean') {
        const names = { fuse: '并集', cut: '差集', common: '交集' };
        const a = this.byId(b.params.a);
        const bs = b.params.b.map((id) => this.byId(id)?.label || '?').join('、');
        lines.push(`  [${b.id}] boolean ${names[b.params.op]}  ${a?.label || '?'} ${b.params.op === 'cut' ? '-' : '+'} (${bs})`);
      } else if (b.kind === 'fillet' || b.kind === 'chamfer') {
        const a = this.byId(b.params.a);
        lines.push(`  [${b.id}] ${b.kind === 'fillet' ? '圆角' : '倒角'} r=${Math.round(b.params.r * 100) / 100} ← ${a?.label || '?'}`);
      } else if (b.kind === 'imported') {
        lines.push(`  [${b.id}] imported ${b.label} ${b.color}`);
      } else {
        const p = Object.entries(b.params).map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`).join(' ');
        lines.push(`  [${b.id}] ${b.kind} ${b.label} ${p} ${b.color}`);
      }
      if (consumed.has(b.id)) lines[lines.length - 1] += '（已并入布尔结果）';
      if (b.transform) {
        const t = Object.entries(b.transform).filter(([, v]) => v).map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`).join(' ');
        if (t) lines[lines.length - 1] += ` [变换 ${t}]`;
      }
    }
    return lines.join('\n');
  }

  /* ---------- 序列化 ---------- */
  serialize() {
    const bodies = deepClone(this.bodies).map((b) => {
      delete b._kids; // 运行时内核引用（跨会话失效）
      if (b._bytes instanceof Uint8Array) {
        b.stepBase64 = bytesToB64(b._bytes);
        delete b._bytes;
      }
      return b;
    });
    return { bodies, labelCounter: deepClone(this._labelCounter) };
  }
  load(json) {
    this.bodies = deepClone(json?.bodies || []).map((b) => {
      delete b._kids;
      if (b.stepBase64 && !(b._bytes instanceof Uint8Array)) b._bytes = b64ToBytes(b.stepBase64);
      delete b.stepBase64;
      return b;
    });
    this._labelCounter = deepClone(json?.labelCounter || {});
    // 换文档：历史与运行时内核映射全部作废
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._booleanFailed = new Set();
    this._kernelIds.clear();
    this.selection.clear();
    this._changed();
    this.emit('selection');
  }
}

/* ---------- base64（浏览器/Node 通用，不依赖 btoa） ---------- */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? B64[c & 63] : '=');
  }
  return s;
}
function b64ToBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((s[i + 2] === '=' ? 0 : B64.indexOf(s[i + 2])) << 6) | (s[i + 3] === '=' ? 0 : B64.indexOf(s[i + 3]));
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
    if (s[i + 2] === '=') out.pop();
    if (s[i + 3] === '=') out.pop();
  }
  return new Uint8Array(out);
}
