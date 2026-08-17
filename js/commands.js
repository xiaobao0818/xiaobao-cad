/* ============================================================
 * 小宝CAD 命令框架 —— 命令行解析 / 交互输入（点/长度/角度/文本）/ 队列执行
 * ============================================================ */
import { Emitter, parsePoint, parseNumber, parseLength, dist, angleOf, R2D } from './util.js';

export const CANCELLED = Symbol('cancelled'); // Esc / 右键：取消整个命令
export const ENDED = Symbol('ended');         // Enter：正常结束

const DEFAULT_PROMPT = {
  point: '指定点:',
  number: '输入数值:',
  distance: '输入距离或点取:',
  angle: '输入角度或点取:',
  text: '输入文本:',
};

export class Commander extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.commands = new Map();
    this.aliases = new Map();
    this.history = [];
    this.last = null;
    this.current = null;
    this.queue = [];
    this._input = null;
    this._curPoint = null;
    this._lastPoint = null;
    this._running = null;
  }
  get vp() { return this.app.viewport; }

  register(name, fn, aliases = []) {
    this.commands.set(name.toUpperCase(), fn);
    for (const a of aliases) this.aliases.set(a.toUpperCase(), name.toUpperCase());
    return this;
  }

  /* ---------------- 输入原语 ---------------- */
  awaitPoint(opts = {}) { return this._await('point', opts); }
  awaitNumber(opts = {}) { return this._await('number', opts); }
  awaitDistance(base, opts = {}) { return this._await('distance', { ...opts, base }); }
  awaitAngle(base, opts = {}) { return this._await('angle', { ...opts, base }); }
  awaitText(opts = {}) { return this._await('text', opts); }

  _await(kind, opts) {
    if (this._input) return Promise.resolve(CANCELLED);
    return new Promise((resolve) => {
      this._input = { kind, opts: opts || {}, resolve };
      this._setupPreview(opts);
      this.vp.basePoint = opts.base || null;
      this._prompt(opts.prompt || DEFAULT_PROMPT[kind]);
      if (opts.initial !== undefined) this.emit('prefill', opts.initial);
      this._tryQueue();
    });
  }
  _setupPreview(opts) {
    if (opts.preview) {
      const fn = opts.preview;
      this.vp.previewFn = (ctx) => { if (this._curPoint) fn(ctx, this._curPoint); };
    } else {
      this.vp.previewFn = null;
    }
  }
  _prompt(msg) { this.emit('prompt', msg); }
  _effectivePoint(screen) {
    const base = this._input?.opts?.base || null;
    return this.vp.getEffectivePoint(screen, { base });
  }

  _tryQueue() {
    const inp = this._input;
    if (!inp || !this.queue.length || inp.kind === 'text') return;
    const token = this.queue[0];
    let v = null;
    if (inp.kind === 'point') v = parsePoint(token, inp.opts.base || this._lastPoint);
    else if (inp.kind === 'number') v = parseNumber(token);
    else if (inp.kind === 'distance') v = parseNumber(token);
    else if (inp.kind === 'angle') {
      v = parseNumber(token);
      if (v === null) { const pp = parsePoint(token, null); if (pp) v = angleOf({ x: 0, y: 0 }, pp) * R2D; }
    }
    if (v !== null && v !== undefined) {
      this.queue.shift();
      if (inp.kind === 'point') this._lastPoint = v;
      this._resolveInput(v);
      return;
    }
    // 选项（如 "C" 闭合）：onText 返回 true → 用该字符串解析本次输入
    if (inp.opts.onText && inp.opts.onText(token)) {
      this.queue.shift();
      this._resolveInput(token);
      return;
    }
    this.queue.shift();
    this.emit('error', `无效的输入: ${token}`);
    this._resolveInput(CANCELLED);
  }

  _resolveInput(v) {
    const inp = this._input;
    if (!inp) return;
    this._input = null;
    this._curPoint = null;
    this.vp.previewFn = null;
    this.vp.basePoint = null;
    inp.resolve(v);
  }
  _cancelInput() {
    const inp = this._input;
    if (!inp) return;
    this._input = null;
    this._curPoint = null;
    this.vp.previewFn = null;
    this.vp.basePoint = null;
    this.queue = [];
    inp.resolve(CANCELLED);
  }

  /* ---------------- 事件路由 ---------------- */
  onMouseMove(screen) {
    const inp = this._input;
    if (!inp) return;
    if (inp.kind === 'point' || inp.kind === 'distance' || inp.kind === 'angle') {
      this._curPoint = this._effectivePoint(screen);
      this.vp.requestRender();
    }
  }
  onMouseDown(screen) {
    const inp = this._input;
    if (!inp) return;
    if (inp.kind === 'point') {
      this._resolveInput(this._effectivePoint(screen));
    } else if (inp.kind === 'distance') {
      if (!inp.opts.base) return;
      const p = this._effectivePoint(screen);
      this._resolveInput(dist(inp.opts.base, p));
    } else if (inp.kind === 'angle') {
      if (!inp.opts.base) return;
      const p = this._effectivePoint(screen);
      this._resolveInput(angleOf(inp.opts.base, p) * R2D);
    }
  }
  onText(str) {
    const inp = this._input;
    if (!inp) { this.exec(str); return; }
    const s = str.trim();
    if (inp.kind === 'text') {
      this._resolveInput(s === '' && inp.opts.enterValue !== undefined ? inp.opts.enterValue : s);
      return;
    }
    if (s === '') {
      this._resolveInput(inp.opts.enterValue !== undefined ? inp.opts.enterValue : ENDED);
      return;
    }
    let v = null;
    if (inp.kind === 'point') v = parsePoint(s, inp.opts.base || this._lastPoint);
    else if (inp.kind === 'number') v = parseNumber(s);
    else if (inp.kind === 'distance') v = parseLength(s, 0);
    else if (inp.kind === 'angle') {
      v = parseNumber(s);
      if (v === null) { const pp = parsePoint(s, null); if (pp) v = angleOf({ x: 0, y: 0 }, pp) * R2D; }
    }
    if (v !== null && v !== undefined) {
      if (inp.kind === 'point') this._lastPoint = v;
      this._resolveInput(v);
      return;
    }
    if (inp.opts.onText && inp.opts.onText(s)) { this._resolveInput(s); return; }
    this.emit('error', `无效的输入: ${str}`);
  }
  /** 右键 = 回车：结束当前输入（带默认值时取默认值） */
  onRightClick() {
    const inp = this._input;
    if (!inp) return;
    if (inp.kind === 'text') {
      this._resolveInput(inp.opts.enterValue !== undefined ? inp.opts.enterValue : '');
    } else {
      this._resolveInput(inp.opts.enterValue !== undefined ? inp.opts.enterValue : ENDED);
    }
  }
  cancel() {
    if (this._input) this._cancelInput();
  }

  /* ---------------- 命令执行 ---------------- */
  exec(str) {
    str = (str || '').trim();
    if (this._input) { this.onText(str); return; }
    if (!str) {
      if (this.last) { this.exec(this.last); return; }
      this._prompt('命令:');
      return;
    }
    const parts = str.split(/\s+/);
    let name = parts[0].toUpperCase();
    if (this.aliases.has(name)) name = this.aliases.get(name);
    const fn = this.commands.get(name);
    if (!fn) {
      this.emit('error', `未知命令: ${parts[0]}`);
      return;
    }
    this.queue = parts.slice(1);
    this.last = str;
    this.current = name;
    if (!this.history.length || this.history[this.history.length - 1] !== str) this.history.push(str);
    this.emit('status', name);
    this._running = (async () => {
      try {
        await fn(this.app, this.queue);
      } catch (err) {
        console.error('[command]', name, err);
        this.emit('error', String(err?.message || err));
      } finally {
        this._finish();
      }
    })();
  }
  _finish() {
    if (this._input) this._cancelInput();
    this.queue = [];
    this.current = null;
    this._running = null;
    this.vp.previewFn = null;
    this.vp.basePoint = null;
    this._curPoint = null;
    this.emit('command-end');
  }
  /** 执行命令；若命令仍在等待下一个输入（如 LINE 连续画线），自动以回车结束。供脚本/AI 使用 */
  execAndEnd(str) {
    this.exec(str);
    setTimeout(() => {
      if (this._input) this.onText('');
    }, 0);
  }
}
