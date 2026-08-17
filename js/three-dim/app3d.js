/* ============================================================
 * 小宝CAD 3D 建模工作区 —— 内核加载 / 工具栏 / 交互 / AI 工具 / 文件
 * ============================================================ */
import { Viewport3D } from './viewport3d.js';
import { Model3D } from './model3d.js';
import { initKernel } from './occ-kernel.js';
import { download, escapeHtml } from '../util.js';

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
    this._buildToolbar();
    this._wireModel();
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
        // 布尔结果为空（实体不相交等）：自动回滚并提示
        this.model.removeBody(body.id);
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
        // 作为"导入体"加入模型
        const body = {
          id: 'imp' + Date.now().toString(36), label: `导入:${f.name}`, kind: 'imported',
          params: { importId: 'imp' + Date.now().toString(36) }, color: '#c8c8c8', visible: true,
          _bytes: bytes, _kids: kids,
        };
        this.model.bodies.push(body);
        this.model._changed();
        this.model.select([body.id], 'set');
        this.refresh(true);
        this.app.notify(`已导入 STEP：${f.name}（${kids.length} 个实体）`);
      } catch (e) {
        this.app.notify('STEP 导入失败：' + (e?.message || e), 'error');
      }
    });
    inp.click();
  }
  async _exportStep() {
    if (!this.model.visibleCount()) { this.app.notify('模型为空', 'error'); return; }
    this.refresh();
    try {
      const kids = [...this.model._kernelIds.values()].flat().filter((x) => x != null);
      if (!kids.length) throw new Error('没有可导出的实体');
      const bytes = this.kernel.exportSTEP(kids);
      download('模型.step', bytes, 'application/step');
      this.app.notify('已导出 STEP 文件');
    } catch (e) { this.app.notify('STEP 导出失败：' + (e?.message || e), 'error'); }
  }
  async _exportStl() {
    if (!this.model.visibleCount()) { this.app.notify('模型为空', 'error'); return; }
    this.refresh();
    try {
      const kids = [...this.model._kernelIds.values()].flat().filter((x) => x != null);
      if (!kids.length) throw new Error('没有可导出的实体');
      const bytes = this.kernel.exportSTL(kids.length === 1 ? kids[0] : kids);
      download('模型.stl', bytes, 'model/stl');
      this.app.notify('已导出 STL 文件（可直接用于 3D 打印）');
    } catch (e) { this.app.notify('STL 导出失败：' + (e?.message || e), 'error'); }
  }

  /* ---------------- 刷新 ---------------- */
  refresh(fitView = false) {
    if (!this.ready || !this.vp) return [];
    const meshes = this.model.evaluate();
    this.vp.setBodies(meshes);
    this.vp.highlight([...this.model.selection][0] || null);
    if (fitView) this.vp.fitView(this.model.extents());
    const sel = [...this.model.selection][0];
    this._hint(sel ? `已选择：${this.model.byId(sel)?.label}` : `3D 模型：${this.model.visibleCount()} 个实体（左键旋转 · 滚轮缩放 · 右键平移 · 点击选择）`);
    return meshes;
  }
  _wireModel() {
    this.model.on('change', () => { if (this.ready) this.refresh(); });
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
          m.removeBody(b.id);
          this.refresh(true);
          const names = { fuse: '并集', cut: '差集', common: '交集' };
          throw new Error(`布尔${names[op]}失败：结果为空（实体可能不相交）。已保留原始实体，请检查实体坐标后重试。`);
        }
        return `布尔${op}完成：${b.label}（id=${b.id}）`;
      },
      list_3d: () => m.summary(),
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
      { type: 'function', function: { name: 'redo_3d', description: '重做三维操作', parameters: { type: 'object', properties: {} } } },
    ];
    const promptLine = '三维实体建模可用（工具 create_primitive_3d/boolean_3d/list_3d/transform_3d/remove_3d/undo_3d 等）：基本体 box(长宽高 dx,dy,dz)/cylinder(r,h)/sphere(r)/cone(r1,r2,h)/torus(r1,r2)，中心坐标 x,y,z；布尔 op: fuse 并集/cut 差集/common 交集，先 list_3d 查 id 再 boolean_3d。';
    if (CAD.aiRegisterTools) {
      CAD.aiRegisterTools(toolDefs, promptLine);
    }
  }
}
