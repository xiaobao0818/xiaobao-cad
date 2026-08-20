/* ============================================================
 * 小宝CAD 3D 建模工作区 —— 内核加载 / 工具栏 / 交互 / AI 工具 / 文件
 * ============================================================ */
import { Viewport3D } from './viewport3d.js';
import { Model3D } from './model3d.js';
import { initKernel } from './occ-kernel.js';
import { download, escapeHtml, uid } from '../util.js';

/** 导出文件名安全化（去掉非法字符） */
const safeName = (n) => (String(n || '模型').replace(/[\\/:*?"<>|]/g, '_') || '模型');

const PRIM_DEFS = {
  box: { name: '长方体', fields: [
    { k: 'x', label: '中心 X', def: 0 }, { k: 'y', label: '中心 Y', def: 0 }, { k: 'z', label: '中心 Z', def: 0 },
    { k: 'dx', label: '长 (X)', def: 40 }, { k: 'dy', label: '宽 (Y)', def: 40 }, { k: 'dz', label: '高 (Z)', def: 40 },
  ]},
  cylinder: { name: '圆柱', fields: [
    { k: 'x', label: '中心 X', def: 0 }, { k: 'y', label: '中心 Y', def: 0 }, { k: 'z', label: '中心 Z', def: 0 },
    { k: 'r', label: '半径', def: 20 }, { k: 'h', label: '高度', def: 50 },
  ]},
  sphere: { name: '球体', fields: [
    { k: 'x', label: '中心 X', def: 0 }, { k: 'y', label: '中心 Y', def: 0 }, { k: 'z', label: '中心 Z', def: 0 },
    { k: 'r', label: '半径', def: 25 },
  ]},
  cone: { name: '圆锥', fields: [
    { k: 'x', label: '底面中心 X', def: 0 }, { k: 'y', label: '底面中心 Y', def: 0 }, { k: 'z', label: '底面中心 Z', def: 0 },
    { k: 'r1', label: '底面半径', def: 25 }, { k: 'r2', label: '顶面半径', def: 8 }, { k: 'h', label: '高度', def: 50 },
  ]},
  torus: { name: '圆环', fields: [
    { k: 'x', label: '中心 X', def: 0 }, { k: 'y', label: '中心 Y', def: 0 }, { k: 'z', label: '中心 Z', def: 0 },
    { k: 'r1', label: '主半径', def: 30 }, { k: 'r2', label: '管半径', def: 10 },
  ]},
};

const TOOLS_3D = [
  { kind: 'box', label: '长方体', icon: '▣' },
  { kind: 'cylinder', label: '圆柱', icon: '⬤' },
  { kind: 'sphere', label: '球', icon: '◯' },
  { kind: 'cone', label: '圆锥', icon: '△' },
  { kind: 'torus', label: '圆环', icon: '◎' },
  null,
  { op: 'fuse', label: '并集', icon: '∪' },
  { op: 'cut', label: '差集', icon: '−' },
  { op: 'common', label: '交集', icon: '∩' },
  null,
  { act: 'transform', label: '移动/旋转', icon: '⤢' },
  { act: 'color', label: '颜色', icon: '🎨' },
  { act: 'delete', label: '删除', icon: '🗑' },
  null,
  { act: 'fillet', label: '圆角', icon: '⧉' },
  { act: 'chamfer', label: '倒角', icon: '⌐' },
  null,
  { act: 'undo', label: '撤销', icon: '↶' },
  { act: 'redo', label: '重做', icon: '↷' },
  { act: 'fit', label: '适应视图', icon: '⛶' },
  { act: 'viewmode', label: '着色/线框', icon: '◇' },
  null,
  { act: 'importStep', label: '导入 STEP', icon: '⇩' },
  { act: 'exportStep', label: '导出 STEP', icon: '⇧' },
  { act: 'exportStl', label: '导出 STL', icon: '⬆' },
  { act: 'clear', label: '清空', icon: '✕' },
];

export class App3D {
  constructor(app) {
    this.app = app;
    this.model = new Model3D();
    this.vp = null;
    this.kernel = null;
    this.ready = false;
    this._pickState = null;
    this._kernelStarted = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    this.readyPromise.catch(() => {}); // 防止内核失败时无人 await 导致 unhandledrejection
    this._buildToolbar();
    this._wireModel();
    // 开机自动恢复/打开含 3D 的图纸时 app3d 可能晚于 scene 就绪：此处回读已载入的 3D 数据
    if (this.app.scene?._bodies3d) {
      const wasDirty = !!this.app.scene.dirty;
      this.model.load(this.app.scene._bodies3d);
      if (!wasDirty) this.app.scene.dirty = false; // 载入文件不应伪造"未保存"状态
    }
  }

  /** 懒加载：首次切换到 3D 工作区时才下载 63MB 内核 */
  ensureLoaded() {
    if (this._kernelStarted) return;
    this._kernelStarted = true;
    this._loadKernel();
  }

  /* ---------------- 内核加载 ---------------- */
  async _loadKernel() {
    const loadingEl = document.getElementById('kernelLoading');
    try {
      if (window.__xbcadDebug) window.__xbcadDebug('[3d] initKernel 开始');
      this.kernel = await initKernel({ locateFile: (f) => '/node_modules/opencascade.js/dist/' + f });
      if (window.__xbcadDebug) window.__xbcadDebug('[3d] initKernel 完成');
      this.model.setKernel(this.kernel);
      this.ready = true;
      this._readyResolve();
      if (loadingEl) loadingEl.remove();
      this._ensureViewport();
      this.refresh(this.app.workspace === '3d');
      this.app.notify('三维实体内核 OpenCASCADE 已就绪，开始建模吧！');
      this._registerAITools();
    } catch (e) {
      console.error('[3d] 内核加载失败', e);
      this._readyReject(e);
      // 允许重试（如网络恢复后再次切换工作区）
      this._kernelStarted = false;
      this.readyPromise = new Promise((resolve, reject) => {
        this._readyResolve = resolve;
        this._readyReject = reject;
      });
      this.readyPromise.catch(() => {});
      if (loadingEl) {
        loadingEl.querySelector('.kl-text').textContent = '三维内核加载失败：' + (e?.message || e) + '（刷新页面重试）';
      }
    }
  }
  _ensureViewport() {
    if (this.vp) return;
    const container = document.getElementById('canvas3d');
    if (!container) return;
    this.vp = new Viewport3D(container);
    this.vp.onClick((e) => this._onCanvasClick(e));
  }

  /* ---------------- 工具栏 ---------------- */
  _buildToolbar() {
    const bar = document.getElementById('toolbar3d');
    if (!bar) return;
    for (const t of TOOLS_3D) {
      if (!t) {
        const sep = document.createElement('div');
        sep.style.cssText = 'width:1px;background:var(--border);margin:4px 6px;';
        bar.appendChild(sep);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'tool-btn';
      b.title = t.label;
      b.innerHTML = `<span style="font-size:16px">${t.icon}</span><span class="t-label">${t.label}</span>`;
      b.addEventListener('click', () => this._onTool(t));
      bar.appendChild(b);
    }
  }
  _onTool(t) {
    if (!this.ready) { this.app.notify('三维内核加载中，请稍候…', 'error'); return; }
    if (t.kind) this._addPrimitiveDialog(t.kind);
    else if (t.op) this._startBoolean(t.op);
    else if (t.act === 'transform') this._transformDialog();
    else if (t.act === 'color') this._colorDialog();
    else if (t.act === 'delete') this._delete();
    else if (t.act === 'fillet' || t.act === 'chamfer') this._filletTool(t.act);
    else if (t.act === 'undo') this.model.undo();
    else if (t.act === 'redo') this.model.redo();
    else if (t.act === 'fit') { this.refresh(true); }
    else if (t.act === 'viewmode') {
      const next = this.vp?.getViewMode() === 'shaded' ? 'wireframe' : 'shaded';
      this.vp?.setViewMode(next);
      this.app.notify(next === 'shaded' ? '着色显示' : '线框显示');
    }
    else if (t.act === 'importStep') this._importStep();
    else if (t.act === 'exportStep') this._exportStep();
    else if (t.act === 'exportStl') this._exportStl();
    else if (t.act === 'clear') this._clear();
  }

  /* ---------------- 拾取流程 ---------------- */
  _startBoolean(op) {
    const names = { fuse: '并集', cut: '差集', common: '交集' };
    this._pickState = { step: 1, op, a: null };
    this._hint(`布尔${names[op]}：请在视图中点击第一个实体`);
  }
  _pickBody() {
    return new Promise((resolve) => {
      this._pickState = { step: 0, resolve };
    });
  }
  _onCanvasClick(e) {
    const st = this._pickState;
    if (st?.step === 1) {
      const id = this.vp.pick(e.clientX, e.clientY);
      if (id) {
        st.a = id;
        st.step = 2;
        this.model.select([id], 'set');
        this.vp.highlight(id);
        const names = { fuse: '并集', cut: '差集', common: '交集' };
        this._hint(`布尔${names[st.op]}：已选第一个，再点击第二个实体（右键/空白取消）`);
      }
      return;
    }
    if (st?.step === 2) {
      const id = this.vp.pick(e.clientX, e.clientY);
      if (!id) { this._cancelPick(); return; }
      if (id === st.a) { this._hint('请点击另一个实体'); return; }
      this._pickState = null;
      this.vp.highlight(null);
      this._doBoolean(st.op, st.a, [id]);
      return;
    }
    if (st?.step === 0 && st.resolve) {
      const id = this.vp.pick(e.clientX, e.clientY);
      this._pickState = null;
      st.resolve(id);
      return;
    }
    // 普通选择
    const id = this.vp.pick(e.clientX, e.clientY);
    this.model.select(id ? [id] : [], id ? (e.shiftKey ? 'add' : 'set') : 'set');
    this.vp.highlight(id);
    if (id) this._hint(`已选择：${this.model.byId(id)?.label}`);
  }
  _hint(msg) { document.getElementById('st3dInfo').textContent = msg; }
  _cancelPick() {
    if (this._pickState) {
      const st = this._pickState;
      this._pickState = null;
      if (st.step === 0 && st.resolve) st.resolve(null);
      this.vp?.highlight(null);
      this._hint('3D 建模工作区：左键旋转 · 滚轮缩放 · 右键平移 · 点击实体选择');
    }
  }
  _doBoolean(op, aId, bIds) {
    try {
      const body = this.model.boolean(op, aId, bIds);
      this.refresh(true);
      if (this.model._booleanFailed.has(body.id)) {
        // 布尔结果为空（实体不相交等）：自动回滚并提示（不留历史，避免 undo 复活失败节点）
        this.model.purgeBody(body.id);
        this.refresh(true);
        const names = { fuse: '并集', cut: '差集', common: '交集' };
        this.app.notify(`布尔${names[op]}失败：实体可能不相交（交集为空）。已保留原始实体。`, 'error');
        return;
      }
      this.app.notify(`布尔${op}完成：${body.label}`);
    } catch (e) {
      this.app.notify(String(e?.message || e), 'error');
      this.refresh(true);
    }
  }

  /* ---------------- 圆角/倒角 ---------------- */
  async _filletTool(kind) {
    const name = kind === 'fillet' ? '圆角' : '倒角';
    let id = [...this.model.selection][0] || null;
    if (!id) {
      this._hint(`请点击要${name}的实体（Esc 取消）`);
      id = await this._pickBody();
      this._hint('3D 建模工作区：左键旋转 · 滚轮缩放 · 右键平移 · 点击实体选择');
      if (!id) return;
    }
    const box = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'form-row';
    const l = document.createElement('label');
    l.textContent = kind === 'fillet' ? '圆角半径' : '倒角距离';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = 'any';
    inp.value = 2;
    row.appendChild(l);
    row.appendChild(inp);
    box.appendChild(row);
    this.app.openDialog({
      title: `${name}（作用于全部棱边）`,
      body: box,
      buttons: [
        { label: '取消' },
        {
          label: '确定', primary: true, onClick: () => {
            const r = parseFloat(inp.value);
            if (!(r > 0)) { this.app.notify('数值必须大于 0', 'error'); return; }
            this._doFillet(kind, id, r);
          },
        },
      ],
    });
  }
  _doFillet(kind, id, r) {
    const name = kind === 'fillet' ? '圆角' : '倒角';
    try {
      const body = this.model.filletChamfer(kind, id, r);
      this.refresh(true);
      if (this.model._booleanFailed.has(body.id)) {
        this.model.purgeBody(body.id);
        this.refresh(true);
        this.app.notify(`${name}失败：尺寸可能过大（棱边无法构造）。已保留原实体。`, 'error');
        return;
      }
      this.app.notify(`${name}完成：${body.label}`);
    } catch (e) {
      this.app.notify(`${name}失败：` + (e?.message || e), 'error');
      this.refresh(true);
    }
  }

  /* ---------------- 对话框 ---------------- */
  _addPrimitiveDialog(kind) {
    const def = PRIM_DEFS[kind];
    const box = document.createElement('div');
    const inputs = {};
    for (const f of def.fields) {
      const row = document.createElement('div');
      row.className = 'form-row';
      const l = document.createElement('label');
      l.textContent = f.label;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = 'any';
      inp.value = f.def;
      inputs[f.k] = inp;
      row.appendChild(l);
      row.appendChild(inp);
      box.appendChild(row);
    }
    this.app.openDialog({
      title: `新建${def.name}`,
      body: box,
      buttons: [
        { label: '取消' },
        { label: '创建', primary: true, onClick: () => {
          const params = {};
          for (const f of def.fields) {
            const v = parseFloat(inputs[f.k].value);
            params[f.k] = Number.isFinite(v) ? v : f.def;
          }
          const POSITIVE = { box: ['dx', 'dy', 'dz'], cylinder: ['r', 'h'], sphere: ['r'], cone: ['r1', 'h'], torus: ['r1', 'r2'] }[kind];
          const bad = POSITIVE.find((k) => !(params[k] > 0));
          if (bad) { this.app.notify(`尺寸「${def.fields.find((f) => f.k === bad).label}」必须大于 0`, 'error'); return; }
          if (kind === 'cone' && params.r2 < 0) { this.app.notify('顶面半径不能为负', 'error'); return; }
          const body = this.model.addPrimitive(kind, params);
          this.refresh(true);
          this.app.notify(`已创建${body.label}`);
        } },
      ],
    });
  }
  async _transformDialog() {
    let ids = [...this.model.selection];
    if (!ids.length) {
      this._hint('请点击要变换的实体（Esc 取消）');
      const id = await this._pickBody();
      this._hint('3D 建模工作区：左键旋转 · 滚轮缩放 · 右键平移 · 点击实体选择');
      if (!id) return;
      ids = [id];
    }
    const box = document.createElement('div');
    const mk = (label, def) => {
      const row = document.createElement('div');
      row.className = 'form-row';
      const l = document.createElement('label');
      l.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = 'any';
      inp.value = def;
      row.appendChild(l);
      row.appendChild(inp);
      box.appendChild(row);
      return inp;
    };
    const dx = mk('移动 X', 0), dy = mk('移动 Y', 0), dz = mk('移动 Z', 0);
    const rx = mk('绕X旋转°', 0), ry = mk('绕Y旋转°', 0), rz = mk('绕Z旋转°', 0);
    const sc = mk('缩放倍数', 1);
    this.app.openDialog({
      title: '移动 / 旋转 / 缩放',
      body: box,
      buttons: [
        { label: '取消' },
        { label: '应用', primary: true, onClick: () => {
          const t = { dx: +dx.value || 0, dy: +dy.value || 0, dz: +dz.value || 0, rx: +rx.value || 0, ry: +ry.value || 0, rz: +rz.value || 0, scale: +sc.value || 1 };
          this.model.transformBody(ids[0], t);
          this.refresh();
        } },
      ],
    });
  }
  _colorDialog() {
    let ids = [...this.model.selection];
    if (!ids.length) { this.app.notify('请先点击选择一个实体', 'error'); return; }
    const row = document.createElement('div');
    row.className = 'form-row';
    const l = document.createElement('label');
    l.textContent = '颜色';
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = this.model.byId(ids[0])?.color || '#7fb2e8';
    row.appendChild(l);
    row.appendChild(inp);
    this.app.openDialog({
      title: '实体颜色',
      body: row,
      buttons: [
        { label: '取消' },
        { label: '应用', primary: true, onClick: () => {
          for (const id of ids) this.model.setColor(id, inp.value);
          this.refresh();
        } },
      ],
    });
  }
  _delete() {
    const n = this.model.removeSelection();
    if (!n) this.app.notify('未选择实体（点击实体后再删除）', 'error');
    else { this.refresh(); this.app.notify(`已删除 ${n} 个实体`); }
  }
  _clear() {
    if (!this.model.count()) return;
    if (!confirm('确定清空整个三维模型？')) return;
    this.model.clear();
    this.refresh();
  }

  /* ---------------- 文件 ---------------- */
  _importStep() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.step,.stp';
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const kids = this.kernel.importSTEP(bytes);
        // 作为"导入体"加入模型（走单步历史，可撤销）
        const body = {
          id: uid(), label: `导入:${f.name}`, kind: 'imported',
          params: { importId: uid() }, color: '#c8c8c8', visible: true,
          _bytes: bytes, _kids: kids,
        };
        this.model.singleOp('导入STEP', () => {
          this.model.bodies.push(body);
          this.model.select([body.id], 'set');
        });
        this.refresh(true);
        this.app.notify(`已导入 STEP：${f.name}（${kids.length} 个实体）`);
      } catch (e) {
        this.app.notify('STEP 导入失败：' + (e?.message || e), 'error');
      }
    });
    inp.click();
  }
  /** 导出用内核 id：跳过被布尔消费的输入体（否则导出含重复几何） */
  _exportKids() {
    const consumed = this.model.consumedSet();
    const kids = [];
    for (const [mid, kid] of this.model._kernelIds) {
      if (consumed.has(mid)) continue;
      for (const k of [].concat(kid)) if (k != null) kids.push(k);
    }
    return kids;
  }
  async _exportStep() {
    if (!this.model.visibleCount()) { this.app.notify('模型为空', 'error'); return; }
    this.refresh();
    try {
      const kids = this._exportKids();
      if (!kids.length) throw new Error('没有可导出的实体');
      const bytes = this.kernel.exportSTEP(kids);
      download(safeName(this.app.docName) + '.step', bytes, 'application/step');
      this.app.notify('已导出 STEP 文件');
    } catch (e) { this.app.notify('STEP 导出失败：' + (e?.message || e), 'error'); }
  }
  async _exportStl() {
    if (!this.model.visibleCount()) { this.app.notify('模型为空', 'error'); return; }
    this.refresh();
    try {
      const kids = this._exportKids();
      if (!kids.length) throw new Error('没有可导出的实体');
      const bytes = this.kernel.exportSTL(kids.length === 1 ? kids[0] : kids);
      download(safeName(this.app.docName) + '.stl', bytes, 'model/stl');
      this.app.notify('已导出 STL 文件（可直接用于 3D 打印）');
    } catch (e) { this.app.notify('STL 导出失败：' + (e?.message || e), 'error'); }
  }

  /* ---------------- 刷新 ---------------- */
  refresh(fitView = false) {
    if (!this.ready || !this.vp) return [];
    let meshes;
    try {
      meshes = this.model.evaluate();
    } catch (e) {
      console.error('[3d] 求值崩溃', e);
      this._hint('⚠️ 模型求值异常（内核错误），已保留当前画面。可尝试撤销或刷新页面。');
      return [];
    }
    // 有可见实体但网格为空 → 求值异常，保留现有画面不清空
    if (!meshes.length && this.model.visibleCount() > 0) {
      console.warn('[3d] 可见实体存在但网格为空，保留当前画面');
      this._hint('⚠️ 模型求值异常（' + this.model.visibleCount() + ' 个可见实体未能生成网格），已保留当前画面。');
      return [];
    }
    this.vp.setBodies(meshes);
    this.vp.highlight([...this.model.selection][0] || null);
    if (fitView) this.vp.fitView(this.model.extents());
    const sel = [...this.model.selection][0];
    this._hint(sel ? `已选择：${this.model.byId(sel)?.label}` : `3D 模型：${this.model.visibleCount()} 个实体（左键旋转 · 滚轮缩放 · 右键平移 · 点击选择）`);
    return meshes;
  }
  _wireModel() {
    this.model.on('change', () => {
      if (this.app.scene) this.app.scene.dirty = true; // 3D 修改传播到图纸脏标记（自动保存/未保存确认依赖）
      if (this.ready) this.refresh();
    });
    this.model.on('selection', () => { this.vp?.highlight([...this.model.selection][0] || null); });
  }

  /* ---------------- AI 工具 ---------------- */
  _registerAITools() {
    const CAD = window.CAD;
    if (!CAD || CAD.ai3d) return;
    const m = this.model;
    const num = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
    const findId = (v) => {
      if (v == null) return null;
      if (m.byId(v)) return v;
      const byLabel = m.bodies.find((b) => b.label === String(v));
      return byLabel ? byLabel.id : null;
    };
    CAD.ai3d = {
      create_primitive_3d: (args) => {
        const kind = String(args.kind || '').toLowerCase();
        if (!PRIM_DEFS[kind]) throw new Error('未知基本体: ' + kind + '，可选: ' + Object.keys(PRIM_DEFS).join('/'));
        const p = {};
        for (const f of PRIM_DEFS[kind].fields) p[f.k] = num(args[f.k], f.def);
        // 尺寸必须为正（位置/角度可为负）；r2=0 允许（圆锥体）
        const POSITIVE = { box: ['dx', 'dy', 'dz'], cylinder: ['r', 'h'], sphere: ['r'], cone: ['r1', 'h'], torus: ['r1', 'r2'] }[kind];
        for (const k of POSITIVE) {
          if (!(p[k] > 0)) throw new Error(`参数 ${k} 必须大于 0（收到 ${p[k]}）`);
        }
        if (kind === 'cone' && p.r2 < 0) throw new Error('顶面半径 r2 不能为负');
        const b = m.addPrimitive(kind, p, args.color ? { color: args.color } : {});
        this.refresh(true);
        return `已创建${b.label}（id=${b.id}，${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(', ')}）`;
      },
      boolean_3d: (args) => {
        const op = String(args.op || '').toLowerCase();
        if (!['fuse', 'cut', 'common'].includes(op)) throw new Error('op 必须是 fuse/cut/common');
        const aId = findId(args.a);
        if (!aId) throw new Error('未找到第一个实体: ' + args.a + '（请先用 list_3d 获取 id）');
        const bIds = (Array.isArray(args.b) ? args.b : [args.b]).map(findId).filter(Boolean);
        if (!bIds.length) throw new Error('未找到第二个实体');
        const b = m.boolean(op, aId, bIds);
        this.refresh(true);
        if (m._booleanFailed.has(b.id)) {
          m.purgeBody(b.id);
          this.refresh(true);
          const names = { fuse: '并集', cut: '差集', common: '交集' };
          throw new Error(`布尔${names[op]}失败：结果为空（实体可能不相交）。已保留原始实体，请检查实体坐标后重试。`);
        }
        return `布尔${op}完成：${b.label}（id=${b.id}）`;
      },
      list_3d: () => m.summary(),
      fillet_3d: (args) => {
        const id = findId(args.id);
        if (!id) throw new Error('未找到实体: ' + args.id + '（请先用 list_3d 获取 id）');
        const r = num(args.r);
        if (!(r > 0)) throw new Error('圆角半径必须大于 0');
        // 半径预检：必须小于实体最小棱边尺寸的一半，否则必然失败（也避免模型反复重试空耗）
        const kid = m._kernelIds.get(id);
        if (kid != null) {
          try {
            const bb = this.kernel.bbox([].concat(kid)[0]);
            const minDim = Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY, bb.maxZ - bb.minZ);
            if (r >= minDim / 2) {
              throw new Error(`圆角半径 ${r} 过大：实体最小尺寸 ${Math.round(minDim)}，半径应 < ${Math.round(minDim / 2)}`);
            }
          } catch (e) {
            if (/过大/.test(String(e.message))) throw e;
            /* bbox 失败则跳过预检，交给内核报错 */
          }
        }
        const b = m.filletChamfer('fillet', id, r);
        this.refresh(true);
        if (m._booleanFailed.has(b.id)) {
          m.purgeBody(b.id);
          this.refresh(true);
          throw new Error(`圆角失败：半径 ${r} 可能过大（棱边无法构造）。已保留原实体，请减小半径重试。`);
        }
        return `圆角完成：${b.label}（id=${b.id}，半径=${r}）`;
      },
      chamfer_3d: (args) => {
        const id = findId(args.id);
        if (!id) throw new Error('未找到实体: ' + args.id + '（请先用 list_3d 获取 id）');
        const d = num(args.d);
        if (!(d > 0)) throw new Error('倒角距离必须大于 0');
        const b = m.filletChamfer('chamfer', id, d);
        this.refresh(true);
        if (m._booleanFailed.has(b.id)) {
          m.purgeBody(b.id);
          this.refresh(true);
          throw new Error(`倒角失败：距离 ${d} 可能过大（棱边无法构造）。已保留原实体，请减小距离重试。`);
        }
        return `倒角完成：${b.label}（id=${b.id}，距离=${d}）`;
      },
      transform_3d: (args) => {
        const id = findId(args.id);
        if (!id) throw new Error('未找到实体: ' + args.id);
        m.transformBody(id, { dx: num(args.dx), dy: num(args.dy), dz: num(args.dz), rx: num(args.rx), ry: num(args.ry), rz: num(args.rz), scale: args.scale != null ? num(args.scale, 1) : null });
        this.refresh();
        return '已变换实体 ' + id;
      },
      set_color_3d: (args) => {
        const id = findId(args.id);
        if (!id) throw new Error('未找到实体: ' + args.id);
        m.setColor(id, String(args.color || '#7fb2e8'));
        this.refresh();
        return '已修改颜色';
      },
      remove_3d: (args) => {
        if (args.all) { const n = m.count(); m.clear(); this.refresh(); return `已清空 ${n} 个实体`; }
        const id = findId(args.id);
        if (!id) throw new Error('未找到实体: ' + args.id);
        m.removeBody(id);
        this.refresh();
        return '已删除实体 ' + id;
      },
      select_3d: (args) => {
        if (args.all) { m.select(m.bodies.map((b) => b.id), 'set'); return `已全选 ${m.count()} 个实体`; }
        const id = findId(args.id);
        if (!id) throw new Error('未找到实体: ' + args.id);
        m.select([id], 'set');
        return '已选择 ' + id;
      },
      undo_3d: () => (m.undo() ? '已撤销' : '没有可撤销的操作'),
      redo_3d: () => (m.redo() ? '已重做' : '没有可重做的操作'),
    };
    const toolDefs = [
      {
        type: 'function', function: {
          name: 'create_primitive_3d',
          description: '在三维工作区创建基本实体（长方体/圆柱/球/圆锥/圆环）。坐标为 mm。',
          parameters: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['box', 'cylinder', 'sphere', 'cone', 'torus'], description: '基本体类型' },
              x: { type: 'number', description: '中心 X（默认 0）' }, y: { type: 'number', description: '中心 Y（默认 0）' }, z: { type: 'number', description: '中心 Z（默认 0）' },
              dx: { type: 'number', description: 'box 长' }, dy: { type: 'number', description: 'box 宽' }, dz: { type: 'number', description: 'box 高' },
              r: { type: 'number', description: 'cylinder/sphere 半径' }, h: { type: 'number', description: 'cylinder/cone 高度' },
              r1: { type: 'number', description: 'cone 底面半径 / torus 主半径' }, r2: { type: 'number', description: 'cone 顶面半径 / torus 管半径' },
              color: { type: 'string', description: '颜色 #rrggbb（可选）' },
            },
          },
        },
      },
      {
        type: 'function', function: {
          name: 'boolean_3d',
          description: '三维布尔运算：并集(fuse)/差集(cut)/交集(common)。a 为目标实体，b 为工具实体（支持数组）。',
          parameters: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['fuse', 'cut', 'common'] },
              a: { type: 'string', description: '目标实体 id（用 list_3d 查询）' },
              b: { type: 'array', items: { type: 'string' }, description: '工具实体 id 数组' },
            },
            required: ['op', 'a', 'b'],
          },
        },
      },
      {
        type: 'function', function: {
          name: 'list_3d', description: '列出三维模型中的全部实体（id/类型/参数/颜色）',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function', function: {
          name: 'transform_3d', description: '移动/旋转/缩放三维实体',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' }, dz: { type: 'number' },
              rx: { type: 'number', description: '绕X旋转(度)' }, ry: { type: 'number' }, rz: { type: 'number' },
              scale: { type: 'number' },
            },
            required: ['id'],
          },
        },
      },
      {
        type: 'function', function: {
          name: 'set_color_3d', description: '修改实体颜色',
          parameters: { type: 'object', properties: { id: { type: 'string' }, color: { type: 'string', description: '#rrggbb' } }, required: ['id', 'color'] },
        },
      },
      {
        type: 'function', function: {
          name: 'remove_3d', description: '删除实体（id）或清空全部（all:true）',
          parameters: { type: 'object', properties: { id: { type: 'string' }, all: { type: 'boolean' } } },
        },
      },
      {
        type: 'function', function: {
          name: 'select_3d', description: '选择实体（id）或全选（all:true）',
          parameters: { type: 'object', properties: { id: { type: 'string' }, all: { type: 'boolean' } } },
        },
      },
      { type: 'function', function: { name: 'undo_3d', description: '撤销上一次三维操作', parameters: { type: 'object', properties: {} } } },
      {
        type: 'function', function: {
          name: 'switch_workspace',
          description: '切换工作区（2d/3d）。联合任务（先建模再出图纸）时用。',
          parameters: { type: 'object', properties: { ws: { type: 'string', enum: ['2d', '3d'] } }, required: ['ws'] },
        },
      },
      {
        type: 'function', function: {
          name: 'query_knowledge',
          description: '检索本平台知识库（水泵设计知识：材料/公差/比转速/公式/标准）。不确定设计参数时先查。',
          parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
        },
      },
      {
        type: 'function', function: {
          name: 'pump_sizing',
          description: '工业级离心泵设计计算：输入工况（Q m³/h、H m、n rpm）返回叶轮外径/叶片数/蜗壳基圆/轴径等关键尺寸。做泵时先调用确定尺寸再建模。',
          parameters: { type: 'object', properties: { Q: { type: 'number' }, H: { type: 'number' }, n: { type: 'number' } }, required: ['Q', 'H'] },
        },
      },
      { type: 'function', function: { name: 'redo_3d', description: '重做三维操作', parameters: { type: 'object', properties: {} } } },
      {
        type: 'function', function: {
          name: 'fillet_3d', description: '对实体全部棱边做圆角（id 用 list_3d 查询，r 为圆角半径）',
          parameters: { type: 'object', properties: { id: { type: 'string' }, r: { type: 'number' } }, required: ['id', 'r'] },
        },
      },
      {
        type: 'function', function: {
          name: 'chamfer_3d', description: '对实体全部棱边做倒角（id 用 list_3d 查询，d 为倒角距离）',
          parameters: { type: 'object', properties: { id: { type: 'string' }, d: { type: 'number' } }, required: ['id', 'd'] },
        },
      },
    ];
    const promptLine = '三维实体建模可用（工具 create_primitive_3d/boolean_3d/list_3d/transform_3d/remove_3d/fillet_3d/chamfer_3d/undo_3d 等）：基本体 box(长宽高 dx,dy,dz)/cylinder(r,h)/sphere(r)/cone(r1,r2,h)/torus(r1,r2)，中心坐标 x,y,z；布尔 op: fuse 并集/cut 差集/common 交集，先 list_3d 查 id 再 boolean_3d。';
    if (CAD.aiRegisterTools) {
      CAD.aiRegisterTools(toolDefs, promptLine);
    }
  }
}
