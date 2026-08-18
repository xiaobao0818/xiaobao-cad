/* ============================================================
 * 小宝CAD 应用外壳 —— UI 构建 / 事件绑定 / 菜单 / 面板 / 快捷键
 * ============================================================ */
import { Scene } from './scene.js';
import { Viewport } from './viewport.js';
import { Commander } from './commands.js';
import * as io from './io.js';
import { registerTools } from './tools.js';
import { registerDimTools } from './dim.js';
import { HANDLERS } from './entities.js';
import { escapeHtml, fmt, download } from './util.js';

/* ---------------- 图标 ---------------- */
const S = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  line: S('<path d="M4 20 L20 4"/>'),
  pline: S('<path d="M3 19 L8 8 L13 15 L18 5 L21 10"/>'),
  rect: S('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  polygon: S('<path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z"/>'),
  circle: S('<circle cx="12" cy="12" r="8.5"/>'),
  arc: S('<path d="M4.5 17 A 9.5 9.5 0 0 1 19.5 17"/>'),
  ellipse: S('<ellipse cx="12" cy="12" rx="9" ry="5.5"/>'),
  point: S('<path d="M12 6 V4 M12 18 V20 M6 12 H4 M18 12 H20"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>'),
  text: S('<path d="M5 19 L9.5 5 L12 14 L14.5 5 L19 19 M7.5 15 H16.5"/>'),
  hatch: S('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 13 L9 8 M8 18 L13 13 M12 20 L17 15 M11 5 L16 10 M16 4 L20 8"/>'),
  move: S('<path d="M12 3 V21 M3 12 H21 M12 3 L9.5 5.5 M12 3 L14.5 5.5 M12 21 L9.5 18.5 M12 21 L14.5 18.5 M3 12 L5.5 9.5 M3 12 L5.5 14.5 M21 12 L18.5 9.5 M21 12 L18.5 14.5"/>'),
  copy: S('<rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 4 H6 A1 1 0 0 0 5 5 V16"/>'),
  rotate: S('<path d="M20 12 A8 8 0 1 1 12 4"/><path d="M20 4 V9 H15"/>'),
  scale: S('<path d="M4 4 H8 V8 H4 Z M16 16 H20 V20 H16 Z"/><path d="M9 15 L19 5 M14 5 H19 V10"/>'),
  mirror: S('<path d="M12 4 V20 M12 6 L7 9.5 V14.5 L12 18 Z M12 6 L17 9.5 V14.5 L12 18 Z"/>'),
  offset: S('<path d="M3 12 H21 M3 16 H21" stroke-dasharray="0"/><path d="M12 12 V7" stroke-dasharray="2.5 2"/>'),
  trim: S('<path d="M4 20 V10 Q4 5 9 5 H20"/><path d="M12 5 V8"/>'),
  extend: S('<path d="M5 20 V12"/><path d="M9 8 H20 V20"/><path d="M5 8 H9" stroke-dasharray="2.5 2"/>'),
  fillet: S('<path d="M4 20 V12 Q4 8 8 8 H20"/>'),
  chamfer: S('<path d="M4 20 V13 H9 L14 8 H20 M14 8 V3"/>'),
  array: S('<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/>'),
  parray: S('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="3.5" r="1.4" fill="currentColor"/><circle cx="19.5" cy="8" r="1.4" fill="currentColor"/><circle cx="4.5" cy="8" r="1.4" fill="currentColor"/>'),
  stretch: S('<rect x="4" y="9" width="16" height="6" rx="1"/><path d="M9 12 L3 12 M3 12 L6 10 M3 12 L6 14 M15 12 L21 12 M21 12 L18 10 M21 12 L18 14"/>'),
  erase: S('<path d="M5 7 H19 M10 7 V5 H14 V7 M7 7 L8 20 H16 L17 7 M10 11 V16 M14 11 V16"/>'),
  explode: S('<path d="M12 3 L14.5 9.5 L21 12 L14.5 14.5 L12 21 L9.5 14.5 L3 12 L9.5 9.5 Z"/>'),
  dim: S('<path d="M4 12 H20 M5 9 L4 12 L5 15 M19 9 L20 12 L19 15 M4 7 V17 M20 7 V17"/>'),
  dimr: S('<path d="M12 12 L12 5"/><path d="M12 12 A7 7 0 1 1 5.5 6.5 M12 5 L10.8 7 M12 5 L13.2 7"/>'),
  block: S('<path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z M4 7.5 L12 12 L20 7.5 M12 12 V21"/>'),
  insert: S('<path d="M12 4 L18 7.5 V14.5 L12 18 L6 14.5 V7.5 Z M6 7.5 L12 11 L18 7.5 M12 11 V18"/><path d="M12 13.5 V17 M10.2 15.2 H13.8"/>'),
  zoomE: S('<path d="M3 9 H8 V13 H3 Z M13 3 H21 V11 H13 Z M8 9 L16 15 M14 20 H21 V15 H14 Z"/>'),
  zoomIn: S('<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 L21 21 M11 8 V14 M8 11 H14"/>'),
  zoomOut: S('<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 L21 21 M8 11 H14"/>'),
  zoomWin: S('<path d="M4 5 H12 V12 H4 Z M6 7 H10 V10 H6 Z"/>'),
  pan: S('<path d="M12 4 V16 M8 8 L12 4 L16 8 M8 12 H4 M4 12 L6.5 10 M4 12 L6.5 14 M16 12 H20 M20 12 L17.5 10 M20 12 L17.5 14"/>'),
  ai: S('<path d="M12 4 A8 8 0 1 1 4 12 A8 8 0 0 1 12 4 Z M9 10.5 H15 M9 13.5 H13"/><circle cx="17" cy="7" r="1.6" fill="currentColor"/><circle cx="19" cy="10" r="1.1" fill="currentColor"/>'),
};

/* ---------------- 工具栏定义 ---------------- */
const TOOL_GROUPS = [
  { name: '绘图', items: [
    { cmd: 'L', label: '直线', icon: ICONS.line, tip: '直线 (L)' },
    { cmd: 'PL', label: '多段线', icon: ICONS.pline, tip: '多段线 (PL)' },
    { cmd: 'REC', label: '矩形', icon: ICONS.rect, tip: '矩形 (REC)' },
    { cmd: 'POL', label: '多边形', icon: ICONS.polygon, tip: '多边形 (POL)' },
    { cmd: 'C', label: '圆', icon: ICONS.circle, tip: '圆 (C)，支持 2P/3P' },
    { cmd: 'A', label: '圆弧', icon: ICONS.arc, tip: '圆弧 (A)，三点/SCE' },
    { cmd: 'EL', label: '椭圆', icon: ICONS.ellipse, tip: '椭圆 (EL)' },
    { cmd: 'PO', label: '点', icon: ICONS.point, tip: '点 (PO)' },
    { cmd: 'TEXT', label: '文字', icon: ICONS.text, tip: '单行文字 (TEXT)' },
    { cmd: 'H', label: '填充', icon: ICONS.hatch, tip: '图案填充 (H)' },
  ]},
  { name: '修改', items: [
    { cmd: 'M', label: '移动', icon: ICONS.move, tip: '移动 (M)' },
    { cmd: 'CO', label: '复制', icon: ICONS.copy, tip: '复制 (CO)' },
    { cmd: 'RO', label: '旋转', icon: ICONS.rotate, tip: '旋转 (RO)' },
    { cmd: 'SC', label: '缩放', icon: ICONS.scale, tip: '缩放 (SC)' },
    { cmd: 'MI', label: '镜像', icon: ICONS.mirror, tip: '镜像 (MI)' },
    { cmd: 'O', label: '偏移', icon: ICONS.offset, tip: '偏移 (O)' },
    { cmd: 'TR', label: '修剪', icon: ICONS.trim, tip: '修剪 (TR)' },
    { cmd: 'EX', label: '延伸', icon: ICONS.extend, tip: '延伸 (EX)' },
    { cmd: 'F', label: '圆角', icon: ICONS.fillet, tip: '圆角 (F)' },
    { cmd: 'CHA', label: '倒角', icon: ICONS.chamfer, tip: '倒角 (CHA)' },
    { cmd: 'AR', label: '矩形阵列', icon: ICONS.array, tip: '矩形阵列 (AR)' },
    { cmd: 'ARP', label: '环形阵列', icon: ICONS.parray, tip: '环形阵列 (ARP)' },
    { cmd: 'S', label: '拉伸', icon: ICONS.stretch, tip: '拉伸 (S)' },
    { cmd: 'E', label: '删除', icon: ICONS.erase, tip: '删除 (E)' },
    { cmd: 'X', label: '分解', icon: ICONS.explode, tip: '分解 (X)' },
  ]},
  { name: '标注', items: [
    { cmd: 'DLI', label: '线性标注', icon: ICONS.dim, tip: '线性标注 (DLI)' },
    { cmd: 'DAL', label: '对齐标注', icon: ICONS.dim, tip: '对齐标注 (DAL)' },
    { cmd: 'DRA', label: '半径标注', icon: ICONS.dimr, tip: '半径标注 (DRA)' },
    { cmd: 'DDI', label: '直径标注', icon: ICONS.dimr, tip: '直径标注 (DDI)' },
    { cmd: 'DAN', label: '角度标注', icon: ICONS.dim, tip: '角度标注 (DAN)' },
  ]},
  { name: '块', items: [
    { cmd: 'B', label: '定义块', icon: ICONS.block, tip: '定义块 (B)' },
    { cmd: 'I', label: '插入块', icon: ICONS.insert, tip: '插入块 (I)' },
  ]},
  { name: '视图', items: [
    { cmd: 'ZE', label: '缩放范围', icon: ICONS.zoomE, tip: '缩放至全部图形 (ZE)' },
    { cmd: 'ZW', label: '缩放窗口', icon: ICONS.zoomWin, tip: '缩放窗口 (ZW)' },
    { cmd: 'ZI', label: '放大', icon: ICONS.zoomIn, tip: '放大 (ZI)' },
    { cmd: 'ZO', label: '缩小', icon: ICONS.zoomOut, tip: '缩小 (ZO)' },
    { cmd: 'PAN', label: '平移', icon: ICONS.pan, tip: '平移 (PAN)' },
  ]},
  { name: '智能', items: [
    { cmd: 'AI', label: 'AI 助手', icon: ICONS.ai, tip: '与 AI 对话创作 (AI)', primary: true },
  ]},
];

/* ---------------- 应用 ---------------- */
class App {
  constructor() {
    this.scene = new Scene();
    this.viewport = new Viewport(document.getElementById('canvas'), this.scene);
    this.commander = new Commander(this);
    this.selectionDrag = null;
    this.panning = null;
    this.docName = '未命名图纸';
    this.workspace = '2d';
    this.app3d = null;
    this._bindEvents();
    this._buildToolbar();
    this._buildMenus();
    this._bindPanels();
    this._bindStatusbar();
    this._bindWorkspace();
    registerTools(this);
    registerDimTools(this);
    this._registerAppCommands();
    this._wireScene();
    this._boot();
  }

  /* ---------------- 启动 ---------------- */
  _boot() {
    const autosave = localStorage.getItem('xbcad:autosave');
    if (autosave) {
      try {
        this.loadScene(Scene.load(JSON.parse(autosave)));
        this.notify('已恢复上次自动保存的图纸');
      } catch (e) { console.warn(e); this._loadDemo(); }
    } else {
      this._loadDemo();
    }
    this.viewport.zoomExtents();
    this._autosaveTimer = setInterval(() => {
      this._sync3dToScene();
      if (this.scene.dirty || this.app3d?.model?._dirty) {
        try {
          localStorage.setItem('xbcad:autosave', JSON.stringify(this.scene.serialize()));
          this.scene.dirty = false;
          if (this.app3d?.model) this.app3d.model._dirty = false;
        } catch (e) { this.notify('自动保存失败：浏览器存储空间不足', 'error'); }
      }
    }, 25000);
    this._loadModules();
    // 提示渐隐
    setTimeout(() => { const el = document.getElementById('viewHint'); if (el) el.style.opacity = '0'; }, 12000);
  }
  _loadDemo() {
    io.makeDemoScene(this.scene);
  }
  async _loadModules() {
    try {
      const dxfMod = await import('./dxf.js');
      window.CAD.dxf = dxfMod;
    } catch (e) { console.warn('DXF 模块加载失败:', e); }
    try {
      const dwgMod = await import('./dwg.js');
      window.CAD.dwg = { parseDWG: dwgMod.parseDWG };
    } catch (e) { console.warn('DWG 模块加载失败:', e); }
    try {
      const aiMod = await import('./ai.js');
      if (aiMod.default) window.__aiPanel = new aiMod.default(window.CAD);
    } catch (e) {
      console.warn('AI 模块加载失败:', e);
      document.getElementById('tab-ai').innerHTML =
        '<div class="empty-note">🤖 AI 模块加载失败，请检查 js/ai.js 是否存在。<br>刷新页面重试。</div>';
    }
    // 3D 建模工作区（内核异步加载，不阻塞 2D）
    try {
      const mod3d = await import('./three-dim/app3d.js');
      if (mod3d.App3D) {
        this.app3d = new mod3d.App3D(this);
        // 若用户已在 3D 工作区等待，立即开始内核加载
        if (this.workspace === '3d') this.app3d.ensureLoaded();
      }
    } catch (e) {
      console.warn('3D 模块加载失败:', e);
      const el = document.getElementById('kernelLoading');
      if (el) el.querySelector('.kl-text').textContent = '三维模块加载失败：' + (e?.message || e);
    }
  }

  loadScene(s) {
    this.scene = s;
    this.viewport.scene = s;
    window.CAD.scene = s;
    this._wireScene();
    s.emit('layers');
    s.emit('change');
    s.emit('selection');
    this.viewport.requestRender();
    // 3D 模型随图纸文件一起加载；app3d 未就绪时由其构造器回读 scene._bodies3d
    if (this.app3d) this.app3d.model.load(s._bodies3d || null);
  }
  _sync3dToScene() {
    if (this.app3d?.model) this.scene._bodies3d = this.app3d.model.serialize();
  }
  saveNative() {
    this._sync3dToScene();
    io.saveNative(this.scene, this.docName);
  }
  newDrawing() {
    if (this.scene.dirty && !confirm('当前图纸有未保存修改，确定新建？')) return;
    this.loadScene(new Scene());
    this.viewport.zoomExtents();
    this.notify('已新建图纸');
  }

  /* ---------------- 场景事件 ---------------- */
  _wireScene() {
    this.scene.on('change', () => { this.viewport.requestRender(); });
    this.scene.on('selection', () => { this.viewport.requestRender(); this._refreshProps(); });
    this.scene.on('layers', () => { this._refreshLayers(); this._refreshProps(); this._refreshStatus(); });
    this.scene.on('history', () => { this.viewport.requestRender(); });
    this.viewport.on('view', () => this._refreshStatus());
    this.commander.on('prompt', (msg) => {
      document.getElementById('cmdPrompt').textContent = msg || '命令:';
      const inp = document.getElementById('cmdInput');
      if (this.commander._input?.kind === 'text' && this.commander._input.opts.initial !== undefined && inp.value === '') {
        inp.value = this.commander._input.opts.initial;
        inp.select();
      }
    });
    this.commander.on('error', (msg) => this.notify(msg, 'error'));
    this.commander.on('command-end', () => { document.getElementById('cmdPrompt').textContent = '命令:'; });
  }

  /* ---------------- 画布事件 ---------------- */
  _bindEvents() {
    const canvas = this.viewport.canvas;
    canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    window.addEventListener('mouseup', (e) => this._onMouseUp(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      this.viewport.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY > 0 ? 0.85 : 1.18);
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dblclick', (e) => {
      const p = this._screenPoint(e);
      const ent = this.viewport.hitTest(p);
      if (ent?.type === 'text') {
        this.scene.select([ent.id], 'set');
        this.commander.exec('ED');
      }
    });
    canvas.addEventListener('mouseleave', () => { this.viewport.cursor.visible = false; this.viewport.requestRender(); });
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('beforeunload', () => {
      this._sync3dToScene();
      if (this.scene.dirty || this.app3d?.model?._dirty) {
        try { localStorage.setItem('xbcad:autosave', JSON.stringify(this.scene.serialize())); } catch (err) { /* ignore */ }
      }
    });
  }
  _screenPoint(e) {
    const r = this.viewport.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  _onMouseMove(e) {
    const p = this._screenPoint(e);
    const vp = this.viewport;
    vp.cursor = { x: p.x, y: p.y, world: vp.screenToWorld(p), snap: null, visible: true };
    this._updateCoords();
    this.commander.onMouseMove(p);
    if (this.panning) {
      vp.panByScreen(p.x - this.panning.x, p.y - this.panning.y);
      this.panning = p;
    } else if (this.selectionDrag) {
      this.selectionDrag.cur = p;
      const d = this.selectionDrag;
      vp.previewFn = (ctx) => this._drawSelectionRect(ctx, d.start, d.cur);
      vp.requestRender();
    }
  }
  _drawSelectionRect(ctx, s1, s2) {
    const vp = this.viewport;
    const w1 = vp.screenToWorld(s1), w2 = vp.screenToWorld(s2);
    const x0 = Math.min(w1.x, w2.x), y0 = Math.min(w1.y, w2.y);
    const x1 = Math.max(w1.x, w2.x), y1 = Math.max(w1.y, w2.y);
    const crossing = s2.x < s1.x;
    ctx.save();
    ctx.fillStyle = crossing ? 'rgba(126,224,138,.12)' : 'rgba(93,179,255,.12)';
    ctx.strokeStyle = crossing ? '#7ee08a' : '#5db3ff';
    ctx.lineWidth = 1.2 / vp.scale;
    ctx.setLineDash([6 / vp.scale, 4 / vp.scale]);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  _onMouseDown(e) {
    const p = this._screenPoint(e);
    const vp = this.viewport;
    if (e.button === 2) {
      // 右键：命令等待输入时 = 回车（结束/默认值）；否则平移
      if (this.commander._input) { this.commander.onRightClick(); return; }
      this.panning = p;
      return;
    }
    if (e.button === 1) { this.panning = p; return; }
    if (e.button !== 0) return;
    const inp = this.commander._input;
    if (inp && (inp.kind === 'point' || inp.kind === 'distance' || inp.kind === 'angle')) {
      this.commander.onMouseDown(p);
      return;
    }
    // 无命令 → 选择
    this.selectionDrag = { start: p, cur: p, moved: false };
  }
  _onMouseUp(e) {
    if (this.panning) { this.panning = null; return; }
    const p = this._screenPoint(e);
    const vp = this.viewport;
    const drag = this.selectionDrag;
    if (!drag) return;
    this.selectionDrag = null;
    const moved = Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4;
    if (moved) {
      vp.previewFn = null;
      const w1 = vp.screenToWorld(drag.start), w2 = vp.screenToWorld(p);
      const bb = [Math.min(w1.x, w2.x), Math.min(w1.y, w2.y), Math.max(w1.x, w2.x), Math.max(w1.y, w2.y)];
      const crossing = p.x < drag.start.x;
      const ids = [];
      for (const ent of this.scene.all()) {
        const l = this.scene.layer(ent.layer);
        if (!l?.on || l?.locked) continue;
        const eb = HANDLERS[ent.type]?.bbox?.(ent, this.scene);
        if (!eb) continue;
        const inside = eb[0] >= bb[0] && eb[1] >= bb[1] && eb[2] <= bb[2] && eb[3] <= bb[3];
        const overlap = !(eb[2] < bb[0] || eb[0] > bb[2] || eb[3] < bb[1] || eb[1] > bb[3]);
        if (crossing ? overlap : inside) ids.push(ent.id);
      }
      this.scene.select(ids, e.shiftKey ? 'add' : 'set');
    } else {
      const ent = vp.hitTest(p);
      if (ent) {
        this.scene.select([ent.id], e.shiftKey ? 'toggle' : 'set');
      } else if (!e.shiftKey) {
        this.scene.clearSelection();
      }
    }
    vp.requestRender();
  }

  /* ---------------- 键盘 ---------------- */
  _onKeyDown(e) {
    const tag = e.target?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    const cmdInput = document.getElementById('cmdInput');
    if (e.key === 'Escape') {
      if (this.workspace === '3d' && this.app3d) { this.app3d._cancelPick(); return; }
      this.commander.cancel();
      if (this.commander._input) return;
      cmdInput.value = '';
      if (typing) e.target.blur();
      return;
    }
    if (typing) {
      if (e.target === cmdInput && e.key === 'Enter') {
        const v = cmdInput.value;
        cmdInput.value = '';
        this.commander.onText(v);
      } else if (e.target === cmdInput && e.key === 'ArrowUp') {
        e.preventDefault();
        this._historyNav(-1);
      } else if (e.target === cmdInput && e.key === 'ArrowDown') {
        e.preventDefault();
        this._historyNav(1);
      }
      return;
    }
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') {
        e.preventDefault();
        if (this.workspace === '3d' && this.app3d) this.app3d.model.undo();
        else this.scene.undo();
      }
      else if (k === 'y') {
        e.preventDefault();
        if (this.workspace === '3d' && this.app3d) this.app3d.model.redo();
        else this.scene.redo();
      }
      else if (k === 's') { e.preventDefault(); this.saveNative(); this.notify('已保存 JSON'); }
      else if (k === 'o') { e.preventDefault(); this.openFileDialog(); }
      else if (k === 'a') {
        e.preventDefault();
        if (this.workspace === '3d' && this.app3d) this.app3d.model.select(this.app3d.model.bodies.map((b) => b.id), 'set');
        else this.scene.selectAll();
      }
      return;
    }
    if (e.key === 'Enter') { this.commander.onText(''); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.workspace === '3d' && this.app3d) { this.app3d._delete(); return; }
      if (this.scene.selection.size) {
        this.scene.singleOp('删除', () => this.scene.removeEntities([...this.scene.selection]));
      }
      return;
    }
    if (e.key === 'F7') { this.viewport.gridOn = !this.viewport.gridOn; this._refreshStatus(); this.viewport.requestRender(); }
    if (e.key === 'F8') { this.viewport.ortho = !this.viewport.ortho; this._refreshStatus(); this.notify(`正交模式 ${this.viewport.ortho ? '开' : '关'}`); }
    if (e.key === 'F9') { this.viewport.snapGridOn = !this.viewport.snapGridOn; this._refreshStatus(); }
    if (k === '+' || k === '=') this.viewport.zoomBy(1.25);
    if (k === '-') this.viewport.zoomBy(0.8);
  }
  _historyNav(dir) {
    const c = this.commander;
    if (!c._histIdx) c._histIdx = c.history.length;
    c._histIdx = Math.max(0, Math.min(c.history.length, c._histIdx + dir));
    const inp = document.getElementById('cmdInput');
    if (c._histIdx < c.history.length) inp.value = c.history[c._histIdx];
    else inp.value = '';
  }

  /* ---------------- 工具栏 / 菜单 ---------------- */
  _buildToolbar() {
    const bar = document.getElementById('toolbar');
    for (const g of TOOL_GROUPS) {
      const div = document.createElement('div');
      div.className = 'tool-group';
      for (const t of g.items) {
        const b = document.createElement('button');
        b.className = 'tool-btn' + (t.primary ? ' primary' : '');
        b.title = t.tip;
        b.innerHTML = `${t.icon}<span class="t-label">${t.label}</span>`;
        b.addEventListener('click', () => this.commander.exec(t.cmd));
        div.appendChild(b);
      }
      bar.appendChild(div);
    }
  }
  _buildMenus() {
    const menus = [
      {
        name: '文件', items: [
          { label: '新建图纸', kbd: '', fn: () => this.newDrawing() },
          { label: '打开文件 (DXF/JSON/SVG)', kbd: 'Ctrl+O', fn: () => this.openFileDialog() },
          { label: '恢复示例图纸', fn: () => { if (this.scene.dirty && !confirm('当前图纸有未保存修改，确定恢复示例？')) return; io.makeDemoScene(this.scene); this.viewport.zoomExtents(); this.notify('已恢复示例图纸'); } },
          { sep: true },
          { label: '保存 (小宝CAD JSON)', kbd: 'Ctrl+S', fn: () => { this.saveNative(); this.notify('已保存'); } },
          { label: '导出 DXF', fn: async () => { try { await io.exportDXF(this.scene, this.docName); this.notify('已导出 DXF'); } catch (err) { this.notify(String(err.message || err), 'error'); } } },
          { label: '导出 SVG', fn: () => io.exportSVG(this.scene, this.docName) },
          { label: '导出 PNG 图片', fn: () => io.exportPNG(this.viewport, this.docName) },
        ],
      },
      {
        name: '编辑', items: [
          { label: '撤销', kbd: 'Ctrl+Z', fn: () => this.scene.undo() },
          { label: '重做', kbd: 'Ctrl+Y', fn: () => this.scene.redo() },
          { label: '删除所选', kbd: 'Del', fn: () => { if (this.scene.selection.size) this.scene.singleOp('删除', () => this.scene.removeEntities([...this.scene.selection])); } },
          { label: '全选', kbd: 'Ctrl+A', fn: () => this.scene.selectAll() },
        ],
      },
      {
        name: '视图', items: [
          { label: '缩放至全部', fn: () => this.viewport.zoomExtents() },
          { label: '缩放窗口', fn: () => this.commander.exec('ZW') },
          { label: '放大', kbd: '+', fn: () => this.viewport.zoomBy(1.25) },
          { label: '缩小', kbd: '-', fn: () => this.viewport.zoomBy(0.8) },
          { sep: true },
          { label: '栅格显示', kbd: 'F7', fn: () => { this.viewport.gridOn = !this.viewport.gridOn; this._refreshStatus(); this.viewport.requestRender(); } },
          { label: '正交模式', kbd: 'F8', fn: () => { this.viewport.ortho = !this.viewport.ortho; this._refreshStatus(); } },
          { label: '栅格捕捉', kbd: 'F9', fn: () => { this.viewport.snapGridOn = !this.viewport.snapGridOn; this._refreshStatus(); } },
        ],
      },
      {
        name: '工具', items: [
          { label: 'AI 助手设置', fn: () => this.openAISettings() },
          { label: 'AI 助手', fn: () => this.switchTab('ai') },
          { label: '图层管理', fn: () => this.switchTab('layers') },
          { label: '属性', fn: () => this.switchTab('props') },
        ],
      },
      {
        name: '帮助', items: [
          { label: '快捷键', fn: () => this.showShortcuts() },
          { label: '关于小宝CAD', fn: () => this.showAbout() },
        ],
      },
    ];
    const bar = document.getElementById('menubar');
    for (const m of menus) {
      const btn = document.createElement('button');
      btn.className = 'menu-btn';
      btn.textContent = m.name;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pop = btn.nextElementSibling;
        const wasOpen = pop.classList.contains('open');
        document.querySelectorAll('.menu-pop').forEach((p) => p.classList.remove('open'));
        document.querySelectorAll('.menu-btn').forEach((b) => b.classList.remove('open'));
        if (!wasOpen) {
          pop.classList.add('open');
          btn.classList.add('open');
          const r = btn.getBoundingClientRect();
          pop.style.left = Math.min(r.left, window.innerWidth - 210) + 'px';
          pop.style.top = (r.bottom + 2) + 'px';
        }
      });
      const pop = document.createElement('div');
      pop.className = 'menu-pop';
      for (const it of m.items) {
        if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; pop.appendChild(s); continue; }
        const d = document.createElement('div');
        d.className = 'menu-item';
        d.innerHTML = `<span>${escapeHtml(it.label)}</span>${it.kbd ? `<span class="kbd">${escapeHtml(it.kbd)}</span>` : ''}`;
        d.addEventListener('click', () => {
          pop.classList.remove('open');
          btn.classList.remove('open');
          it.fn();
        });
        pop.appendChild(d);
      }
      bar.appendChild(btn);
      bar.appendChild(pop);
    }
    document.addEventListener('click', () => {
      document.querySelectorAll('.menu-pop').forEach((p) => p.classList.remove('open'));
      document.querySelectorAll('.menu-btn').forEach((b) => b.classList.remove('open'));
    });
  }

  /* ---------------- 面板 ---------------- */
  _bindPanels() {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.addEventListener('click', () => this.switchTab(b.dataset.tab));
    });
    this._refreshLayers();
    this._refreshProps();
  }
  switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  }
  _refreshLayers() {
    const el = document.getElementById('tab-layers');
    const scene = this.scene;
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'pane-head';
    head.innerHTML = '<span>图层</span><span></span>';
    const btns = document.createElement('span');
    const addBtn = document.createElement('button');
    addBtn.className = 'mini-btn';
    addBtn.textContent = '+ 新建';
    addBtn.addEventListener('click', () => this.addLayerDialog());
    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn';
    delBtn.textContent = '删除';
    delBtn.style.marginLeft = '6px';
    delBtn.addEventListener('click', () => this.deleteCurrentLayer());
    btns.appendChild(addBtn);
    btns.appendChild(delBtn);
    head.appendChild(btns);
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'pane-body';
    for (const l of scene.layers.values()) {
      const row = document.createElement('div');
      row.className = 'layer-row' + (l.name === scene.currentLayer ? ' current' : '') + (l.on ? '' : ' off') + (l.locked ? ' locked' : '');
      const sw = document.createElement('input');
      sw.type = 'color';
      sw.className = 'swatch';
      sw.value = typeof l.color === 'string' && l.color.startsWith('#') ? l.color : '#ffffff';
      sw.title = '图层颜色';
      sw.addEventListener('click', (e) => e.stopPropagation());
      sw.addEventListener('input', () => { l.color = sw.value; this.scene.emit('layers'); this.viewport.requestRender(); });
      const name = document.createElement('span');
      name.className = 'lname';
      name.textContent = l.name;
      name.title = '双击重命名';
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.renameLayerDialog(l.name);
      });
      const eye = document.createElement('span');
      eye.className = 'lbtn';
      eye.textContent = l.on ? '👁' : '🚫';
      eye.title = l.on ? '隐藏图层' : '显示图层';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        l.on = !l.on;
        this.scene.emit('layers');
        this.viewport.requestRender();
      });
      const lock = document.createElement('span');
      lock.className = 'lbtn';
      lock.textContent = l.locked ? '🔒' : '🔓';
      lock.title = l.locked ? '解锁图层' : '锁定图层';
      lock.addEventListener('click', (e) => {
        e.stopPropagation();
        l.locked = !l.locked;
        this.scene.emit('layers');
      });
      row.appendChild(sw);
      row.appendChild(name);
      row.appendChild(eye);
      row.appendChild(lock);
      row.addEventListener('click', () => { scene.setCurrentLayer(l.name); this._refreshStatus(); });
      body.appendChild(row);
    }
    el.appendChild(body);
  }
  _refreshProps() {
    const el = document.getElementById('tab-props');
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'pane-head';
    head.innerHTML = `<span>属性</span>`;
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'pane-body';
    const sel = this.scene.selected();
    if (!sel.length) {
      body.innerHTML = '<div class="empty-note">未选择对象。<br>点击图形选择，按住 Shift 加选，<br>拖动鼠标框选（右→左为交叉选择）。</div>';
      el.appendChild(body);
      return;
    }
    const multi = sel.length > 1;
    if (multi) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = `已选择 ${sel.length} 个对象（公共属性）`;
      body.appendChild(note);
    }
    const layerSel = document.createElement('select');
    for (const l of this.scene.layers.values()) {
      const o = document.createElement('option');
      o.value = l.name;
      o.textContent = l.name;
      if (!multi && sel[0].layer === l.name) o.selected = true;
      layerSel.appendChild(o);
    }
    layerSel.addEventListener('change', () => {
      const v = layerSel.value;
      this.scene.singleOp('修改图层', () => { for (const e of sel) e.layer = v; this.scene._changed(); });
    });
    body.appendChild(this._propRow('图层', layerSel));
    const colorIn = document.createElement('input');
    colorIn.type = 'color';
    const c0 = sel[0].color ?? (this.scene.layer(sel[0].layer)?.color || '#ffffff');
    colorIn.value = typeof c0 === 'string' && c0.startsWith('#') ? c0 : '#ffffff';
    colorIn.addEventListener('input', () => {
      const v = colorIn.value;
      this.scene.singleOp('修改颜色', () => { for (const e of sel) e.color = v; this.scene._changed(); });
    });
    const bylayerBtn = document.createElement('button');
    bylayerBtn.className = 'mini-btn';
    bylayerBtn.textContent = '随层';
    bylayerBtn.style.flex = 'none';
    bylayerBtn.addEventListener('click', () => {
      this.scene.singleOp('颜色随层', () => { for (const e of sel) e.color = null; this.scene._changed(); });
    });
    const colorWrap = document.createElement('span');
    colorWrap.style.cssText = 'display:flex;flex:1;gap:6px;align-items:center;';
    colorWrap.appendChild(colorIn);
    colorWrap.appendChild(bylayerBtn);
    body.appendChild(this._propRow('颜色', colorWrap));
    const ltSel = document.createElement('select');
    for (const t of ['随层', 'CONTINUOUS', 'CENTER', 'DASHED', 'HIDDEN', 'DASHDOT', 'PHANTOM', 'DOT']) {
      const o = document.createElement('option');
      o.value = t === '随层' ? '__bylayer__' : t;
      o.textContent = t === '随层' ? '随层（实线）' : t;
      ltSel.appendChild(o);
    }
    const l0 = sel[0].ltype;
    ltSel.value = l0 || '__bylayer__';
    ltSel.addEventListener('change', () => {
      const v = ltSel.value;
      this.scene.singleOp('修改线型', () => { for (const e of sel) e.ltype = v === '__bylayer__' ? null : v; this.scene._changed(); });
    });
    body.appendChild(this._propRow('线型', ltSel));
    const lwIn = document.createElement('input');
    lwIn.type = 'number';
    lwIn.min = '0';
    lwIn.step = '0.5';
    lwIn.value = sel[0].lw ?? 0;
    lwIn.addEventListener('change', () => {
      const v = parseFloat(lwIn.value) || 0;
      this.scene.singleOp('修改线宽', () => { for (const e of sel) e.lw = v; this.scene._changed(); });
    });
    body.appendChild(this._propRow('线宽', lwIn));
    // 类型特有属性
    if (!multi) {
      const e = sel[0];
      for (const p of this._entityProps(e)) {
        if (p.type === 'select') {
          const sel2 = document.createElement('select');
          for (const opt of p.options || []) {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            if (p.get() === opt) o.selected = true;
            sel2.appendChild(o);
          }
          sel2.addEventListener('change', () => {
            const v = sel2.value;
            this.scene.singleOp('修改属性', () => { p.set(v); this.scene._changed(); });
          });
          body.appendChild(this._propRow(p.label, sel2));
        } else if (p.type === 'bool') {
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.checked = !!p.get();
          chk.addEventListener('change', () => {
            const v = chk.checked;
            this.scene.singleOp('修改属性', () => { p.set(v); this.scene._changed(); });
          });
          body.appendChild(this._propRow(p.label, chk));
        } else {
          const inp2 = document.createElement('input');
          inp2.type = p.type === 'number' ? 'number' : 'text';
          inp2.step = 'any';
          inp2.value = p.get();
          inp2.addEventListener('change', () => {
            let v = inp2.value;
            if (p.type === 'number') v = parseFloat(v);
            if (v === undefined || v === '' || Number.isNaN(v)) return;
            this.scene.singleOp('修改属性', () => { p.set(v); this.scene._changed(); });
          });
          body.appendChild(this._propRow(p.label, inp2));
        }
      }
    }
    el.appendChild(body);
  }
  _entityProps(e) {
    try { return HANDLERS[e.type]?.props?.(e, this.scene) || []; }
    catch (err) { return []; }
  }
  _propRow(label, control) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const l = document.createElement('label');
    l.textContent = label;
    row.appendChild(l);
    row.appendChild(control);
    return row;
  }

  /* ---------------- 工作区切换（2D / 3D） ---------------- */
  _bindWorkspace() {
    document.querySelectorAll('.ws-btn').forEach((b) => {
      b.addEventListener('click', () => this.showWorkspace(b.dataset.ws));
    });
  }
  showWorkspace(ws) {
    this.workspace = ws;
    document.querySelectorAll('.ws-btn').forEach((b) => b.classList.toggle('active', b.dataset.ws === ws));
    const is3d = ws === '3d';
    document.getElementById('toolbar').style.display = is3d ? 'none' : '';
    document.getElementById('toolbar3d').style.display = is3d ? '' : 'none';
    document.getElementById('canvasWrap').style.display = is3d ? 'none' : '';
    document.getElementById('canvas3dWrap').style.display = is3d ? '' : 'none';
    document.getElementById('cmdbar').style.display = is3d ? 'none' : '';
    document.getElementById('statusbar').style.display = is3d ? 'none' : '';
    document.getElementById('statusbar3d').style.display = is3d ? '' : 'none';
    if (is3d) {
      this.commander.cancel();
      this.viewport.requestRender();
    }
    if (this.app3d) {
      if (is3d) {
        this.app3d.ensureLoaded();
        this.app3d.refresh(true);
        setTimeout(() => this.app3d.refresh(true), 300); // 等 canvas 显示后再适配
      } else {
        this.app3d._cancelPick?.(); // 离开 3D 时清理布尔/变换拾取状态
      }
    } else if (is3d) {
      this.notify('3D 模块仍在加载中…', 'error');
    }
    this.notify(is3d ? '已切换到 3D 建模工作区' : '已切换到 2D 制图工作区');
  }

  /* ---------------- 状态栏 ---------------- */
  _bindStatusbar() {
    document.querySelectorAll('.st-toggle').forEach((el) => {
      el.addEventListener('click', () => {
        const vp = this.viewport;
        const t = el.dataset.toggle;
        if (t === 'osnap') vp.osnap.enabled = !vp.osnap.enabled;
        else if (t === 'ortho') vp.ortho = !vp.ortho;
        else if (t === 'grid') vp.gridOn = !vp.gridOn;
        else if (t === 'gridsnap') vp.snapGridOn = !vp.snapGridOn;
        this._refreshStatus();
        this.viewport.requestRender();
      });
    });
    this._refreshStatus();
  }
  _refreshStatus() {
    const vp = this.viewport;
    const set = (id, on) => document.getElementById(id).classList.toggle('on', on);
    set('stOsnap', vp.osnap.enabled);
    set('stOrtho', vp.ortho);
    set('stGrid', vp.gridOn);
    set('stSnap', vp.snapGridOn);
    document.getElementById('stLayer').textContent = `图层: ${this.scene.currentLayer}`;
    document.getElementById('stZoom').textContent = `${Math.round((vp.scale / 2) * 100)}%`;
  }
  _updateCoords() {
    const c = this.viewport.cursor;
    if (!c.visible) return;
    document.getElementById('stCoords').textContent = `${fmt(c.world.x, 3)}, ${fmt(c.world.y, 3)}`;
    const snap = c.snap;
    const names = { endpoint: '端点', midpoint: '中点', center: '圆心', quadrant: '象限点', intersection: '交点', nearest: '最近点', node: '节点', grid: '栅格' };
    document.getElementById('stSnapInfo').textContent = snap ? `[${names[snap.type] || snap.type}]` : '';
  }

  /* ---------------- 对话框 / 提示 ---------------- */
  openDialog({ title, body, buttons = [], onClose }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-title">${escapeHtml(title)}</div><div class="modal-body"></div>`;
    const bd = modal.querySelector('.modal-body');
    if (typeof body === 'string') bd.innerHTML = body;
    else bd.appendChild(body);
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const close = (fn) => {
      if (fn) { const r = fn(); if (r === false) return; }
      overlay.remove();
      onClose?.();
    };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = 'mini-btn' + (b.primary ? ' primary' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => close(b.onClick));
      foot.appendChild(btn);
    }
    if (!buttons.length) {
      const btn = document.createElement('button');
      btn.className = 'mini-btn primary';
      btn.textContent = '关闭';
      btn.addEventListener('click', () => close());
      foot.appendChild(btn);
    }
    modal.appendChild(foot);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && buttons[0]?.label === '取消') close(); });
    document.getElementById('dialogs').appendChild(overlay);
    return { close };
  }
  promptDialog(title, def = '') {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.value = def;
      inp.placeholder = '输入…';
      inp.style.cssText = 'flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:7px 9px;font-size:13px;outline:none;';
      const wrap = document.createElement('div');
      wrap.className = 'form-row';
      wrap.appendChild(inp);
      const dlg = this.openDialog({
        title,
        body: wrap,
        buttons: [
          { label: '取消', onClick: () => { resolve(null); } },
          { label: '确定', primary: true, onClick: () => { const v = inp.value.trim(); resolve(v); } },
        ],
      });
      setTimeout(() => { inp.focus(); inp.select(); }, 50);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { const v = inp.value.trim(); resolve(v); dlg.close(); }
      });
    });
  }
  chooseBlock() {
    return new Promise((resolve) => {
      const list = document.createElement('div');
      list.className = 'block-list';
      const names = [...this.scene.blocks.keys()];
      if (!names.length) {
        list.innerHTML = '<div class="empty-note">暂无块定义。先用 B 命令定义块。</div>';
      }
      for (const n of names) {
        const it = document.createElement('div');
        it.className = 'block-item';
        it.textContent = `🧩 ${n}（${this.scene.blocks.get(n).entities.size} 个图元）`;
        it.addEventListener('click', () => { resolve(n); dlg.close(); });
        list.appendChild(it);
      }
      const dlg = this.openDialog({
        title: '插入块',
        body: list,
        buttons: [{ label: '取消', onClick: () => { resolve(null); } }],
      });
    });
  }
  addLayerDialog() {
    this.promptDialog('新建图层名称').then((name) => {
      if (!name) return;
      try {
        const palette = ['#e8e8e8', '#5db3ff', '#7ee08a', '#ffd166', '#ff8c42', '#c792ea'];
        this.scene.addLayer(name, { color: palette[Math.floor(Math.random() * palette.length)] });
        this.notify(`已创建图层 ${name}`);
      } catch (e) { this.notify(String(e.message || e), 'error'); }
    });
  }
  renameLayerDialog(oldName) {
    this.promptDialog(`重命名图层「${oldName}」`, oldName).then((name) => {
      if (!name || name === oldName) return;
      if (this.scene.layers.has(name)) { this.notify('图层名已存在', 'error'); return; }
      const l = this.scene.layers.get(oldName);
      this.scene.layers.delete(oldName);
      l.name = name;
      this.scene.layers.set(name, l);
      for (const e of this.scene.entities.values()) if (e.layer === oldName) e.layer = name;
      if (this.scene.currentLayer === oldName) this.scene.currentLayer = name;
      this.scene.emit('layers');
      this.scene.emit('change');
    });
  }
  deleteCurrentLayer() {
    const name = this.scene.currentLayer;
    if (name === '0') { this.notify('不能删除 0 图层', 'error'); return; }
    if (!confirm(`删除图层「${name}」？其上的实体将移至 0 层。`)) return;
    try {
      this.scene.removeLayer(name);
      this.notify(`已删除图层 ${name}`);
    } catch (e) { this.notify(String(e.message || e), 'error'); }
  }
  showShortcuts() {
    this.openDialog({
      title: '快捷键',
      body: `<table class="help-table">
        <tr><td>Esc</td><td>取消当前命令</td></tr>
        <tr><td>Enter</td><td>重复上一命令 / 结束输入</td></tr>
        <tr><td>Delete</td><td>删除所选对象</td></tr>
        <tr><td>Ctrl+Z / Ctrl+Y</td><td>撤销 / 重做</td></tr>
        <tr><td>Ctrl+S</td><td>保存（JSON）</td></tr>
        <tr><td>Ctrl+O</td><td>打开文件</td></tr>
        <tr><td>Ctrl+A</td><td>全选</td></tr>
        <tr><td>F7 / F8 / F9</td><td>栅格 / 正交 / 栅格捕捉</td></tr>
        <tr><td>滚轮</td><td>缩放</td></tr>
        <tr><td>中键/右键拖动</td><td>平移</td></tr>
        <tr><td>双击文字</td><td>编辑文字内容</td></tr>
        <tr><td>Shift+点击</td><td>加选/减选</td></tr>
      </table>
      <p class="form-help" style="margin-top:10px">命令行支持坐标输入：<b>100,50</b> 绝对坐标、<b>@50&lt;45</b> 相对极坐标、<b>@20,10</b> 相对坐标。<br>
      常用命令：L 直线 · PL 多段线 · REC 矩形 · C 圆 · A 圆弧 · EL 椭圆 · TEXT 文字 · M 移动 · CO 复制 · RO 旋转 · O 偏移 · TR 修剪 · EX 延伸 · F 圆角 · DLI 标注 · U 撤销 · AI 对话</p>`,
    });
  }
  showAbout() {
    this.openDialog({
      title: '关于小宝CAD',
      body: `<div class="form-help" style="font-size:13px;line-height:1.9">
        <p><b style="font-size:16px">🐻 小宝CAD</b> v1.0</p>
        <p>一款运行在浏览器中的轻量 CAD 绘图软件：</p>
        <p>· 绘图：直线/多段线/矩形/圆/圆弧/椭圆/多边形/文字/填充<br>
        · 修改：移动/复制/旋转/缩放/镜像/偏移/修剪/延伸/圆角/倒角/阵列/拉伸<br>
        · 标注：线性/对齐/半径/直径/角度<br>
        · 图层、块、对象捕捉、正交、栅格、撤销重做<br>
        · 文件：DXF 读写、JSON 原生格式、SVG 导入导出、PNG 导出<br>
        · <b>🤖 AI 助手</b>：接入 MiniMax M3 大模型（原生多模态），对话式 CAD 创作与看图审阅</p>
        <p style="color:var(--text-dim)">DWG 为专有格式，请先用 ODA/LibreDWG 转换为 DXF。</p>
      </div>`,
    });
  }
  openAISettings() {
    if (window.__aiPanel?.openSettings) window.__aiPanel.openSettings();
    else { this.switchTab('ai'); this.notify('AI 模块未加载', 'error'); }
  }
  openFileDialog() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.dxf,.json,.xbcad,.svg,.dwg';
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (!f) return;
      if (this.scene.dirty && !confirm('当前图纸有未保存修改，打开新文件将覆盖，继续？')) return;
      try {
        const r = await io.openFile(this, f);
        this.docName = f.name.replace(/\.[^.]+$/, '');
        document.getElementById('docTitle').textContent = f.name;
        this.viewport.zoomExtents();
        this.notify(`已打开 ${f.name}（${r.count} 个实体）`);
      } catch (err) {
        this.notify(String(err.message || err), 'error');
        this.openDialog({ title: '无法打开文件', body: `<div class="form-help">${escapeHtml(String(err.message || err))}</div>` });
      }
    });
    inp.click();
  }
  notify(msg, kind = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = kind;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 4200 : 2600);
  }

  /* ---------------- 内置命令 ---------------- */
  _registerAppCommands() {
    const c = this.commander;
    c.register('U', () => { if (!this.scene.undo()) this.notify('没有可撤销的操作'); }, ['UNDO', 'OOPS']);
    c.register('REDO', () => { if (!this.scene.redo()) this.notify('没有可重做的操作'); }, ['MREDO']);
    c.register('ZE', () => this.viewport.zoomExtents(), ['ZOOME', 'ZALL']);
    c.register('ZW', async (app, args) => {
      const p1 = await c.awaitPoint({ prompt: '窗口第一角:', preview: (ctx, p) => {} });
      if (p1 === undefined || p1 === null) return;
      const p2 = await c.awaitPoint({ prompt: '窗口对角:', base: p1 });
      if (p2 === undefined || p2 === null) return;
      this.viewport.zoomWindow(this.viewport.worldToScreen(p1), this.viewport.worldToScreen(p2));
    }, ['ZOOMW']);
    c.register('ZI', () => this.viewport.zoomBy(1.25), ['ZOOMIN']);
    c.register('ZO', () => this.viewport.zoomBy(0.8), ['ZOOMOUT']);
    c.register('ZOOM', (app, args) => {
      const a = (args[0] || '').toUpperCase();
      if (a === 'E') this.viewport.zoomExtents();
      else if (a === 'W') c.exec('ZW');
      else { const n = parseFloat(a); if (Number.isFinite(n)) this.viewport.zoomBy(n); else this.notify('用法: ZOOM E | W | 系数', 'error'); }
    }, ['Z']);
    c.register('PAN', async () => {
      const p1 = await c.awaitPoint({ prompt: '平移基点:' });
      if (!p1 || p1 === null) return;
      const p2 = await c.awaitPoint({ prompt: '平移到:', base: p1 });
      if (!p2 || p2 === null) return;
      this.viewport.panByWorld(p1.x - p2.x, p1.y - p2.y);
    }, ['P']);
    c.register('REGEN', () => { this.viewport.requestRender(); this.notify('已重生成'); }, ['RE']);
    c.register('SELALL', () => { this.scene.selectAll(); this.notify(`已选择 ${this.scene.selection.size} 个对象`); });
    c.register('SAVE', () => { this.saveNative(); this.notify('已保存 JSON 文件'); });
    c.register('OPEN', () => this.openFileDialog());
    c.register('NEW', () => this.newDrawing());
    c.register('LA', () => this.switchTab('layers'), ['LAYER']);
    c.register('PROPS', () => this.switchTab('props'), ['PROPERTIES', 'MO', 'CH']);
    c.register('HELP', () => this.showShortcuts());
    c.register('AI', (app, args) => {
      const text = args.join(' ');
      if (window.__aiPanel) window.__aiPanel.ask(text);
      this.switchTab('ai');
    }, ['XIAOBAO']);
  }
}

/* ---------------- 启动 ---------------- */
window.CAD = {
  get scene() { return app.scene; },
  get viewport() { return app.viewport; },
  get commander() { return app.commander; },
  get app() { return app; },
  get workspace() { return app.workspace; },
  get app3d() { return app.app3d; },
  dxf: null,
  dwg: null,
  ai: null,
  ai3d: null,
  aiAsk: null,
  aiRegisterTools: null,
  ui: null,
  notify: null,
  runCommand: (s) => app.commander.exec(s),
  askAI: (text) => { if (window.__aiPanel) window.__aiPanel.ask(text); app.switchTab('ai'); },
  summarize: (opts) => io.buildSceneSummary(app.scene, opts),
  render: () => app.viewport.requestRender(),
  /** 供 AI 多模态审阅：截取当前有内容的工作区渲染图（PNG dataURL） */
  captureForAI: () => {
    const has2d = app.scene.count() > 0;
    const has3d = !!(app.app3d?.model && app.app3d.model.visibleCount() > 0);
    const active3d = app.workspace === '3d';
    try {
      if (active3d && has3d && app.app3d?.vp) return app.app3d.vp.capture();
      if (!active3d && has2d) return app.viewport.captureForAI(true);
      if (has3d && app.app3d?.vp) return app.app3d.vp.capture();
      if (has2d) return app.viewport.captureForAI(true);
    } catch (e) { console.warn('[capture]', e); }
    return null;
  },
};

const app = new App();
window.CAD.ui = {
  toast: (m, k) => app.notify(m, k),
  dialog: (o) => app.openDialog(o),
  prompt: (t, d) => app.promptDialog(t, d),
  chooseBlock: () => app.chooseBlock(),
  switchTab: (n) => app.switchTab(n),
  openSettings: () => app.openAISettings(),
};
window.CAD.notify = (m, k) => app.notify(m, k);
window.app = app;
