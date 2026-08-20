/* ============================================================
 * 小宝CAD 画图训练 · 确定性验收器（纯函数，Node/浏览器通用）
 * 输入：
 *   2D：实体数组（scene.all() / serialize().entities）
 *   3D：{ bodies: [...] }（Model3D.serialize()）
 * 输出：{ score: 0-100, total, passed, checks: [{name, pass, detail, weight}] }
 * ============================================================ */

const approx = (a, b, tol) => Math.abs(a - b) <= tol;
const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

/* 2D 辅助 */
function bboxOf(ents) {
  let bb = null;
  for (const e of ents) {
    let pts = [];
    if (e.type === 'line') pts = [[e.x1, e.y1], [e.x2, e.y2]];
    else if (e.type === 'circle') pts = [[e.cx - e.r, e.cy - e.r], [e.cx + e.r, e.cy + e.r]];
    else if (e.type === 'arc') {
      const a = e.startAngle ?? 0, b = e.endAngle ?? Math.PI * 2;
      pts = [];
      for (let k = 0; k <= 32; k++) {
        const t = a + ((b - a) * k) / 32;
        pts.push([e.cx + e.r * Math.cos(t), e.cy + e.r * Math.sin(t)]);
      }
    } else if (e.type === 'ellipse') {
      const rot = e.rot || 0;
      for (let k = 0; k <= 32; k++) {
        const t = (k / 32) * Math.PI * 2;
        const x = e.cx + e.rx * Math.cos(t) * Math.cos(rot) - e.ry * Math.sin(t) * Math.sin(rot);
        const y = e.cy + e.rx * Math.cos(t) * Math.sin(rot) + e.ry * Math.sin(t) * Math.cos(rot);
        pts.push([x, y]);
      }
    } else if (e.type === 'polyline') {
      for (const p of e.points || []) pts.push([p.x, p.y]);
    } else if (e.type === 'point') pts = [[e.x, e.y]];
    else if (e.type === 'insert') pts = [[e.x, e.y]];
    else if (e.type === 'text') pts = [[e.x, e.y]];
    for (const [x, y] of pts) {
      bb = bb ? [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)] : [x, y, x, y];
    }
  }
  return bb;
}
/** 点到（无限）直线的距离 */
function distToLine(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return dist(px, py, x1, y1);
  return Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len;
}

/* 3D 辅助：镜像 Model3D.consumedSet 语义（serialize 里没有 _booleanFailed，失败布尔按求值态处理） */
function consumed3d(bodies) {
  const consumed = new Set();
  for (const b of bodies) {
    if ((b.kind === 'boolean' || b.kind === 'fillet' || b.kind === 'chamfer')) {
      consumed.add(b.params?.a);
      for (const id of b.params?.b || []) consumed.add(id);
    }
  }
  return consumed;
}

/* ---------------- 检查执行 ---------------- */
function check2d(check, ents) {
  const pick = (t) => ents.filter((e) => e.type === t);
  switch (check.type) {
    case 'count': {
      const n = pick(check.kind).length;
      const pass = n >= (check.min ?? 0) && n <= (check.max ?? Infinity);
      return { pass, detail: `${check.kind} 数量=${n}（期望≥${check.min}${check.max != null ? ` 且≤${check.max}` : ''}）` };
    }
    case 'circleAt': {
      const found = pick('circle').find((e) => approx(e.r, check.r, check.tol) && dist(e.cx, e.cy, check.cx, check.cy) <= check.tol);
      return { pass: !!found, detail: found ? `圆 @(${found.cx.toFixed(1)},${found.cy.toFixed(1)}) r=${found.r.toFixed(1)}` : `未找到 r≈${check.r} @(${check.cx},${check.cy}) 的圆` };
    }
    case 'holesOnRing': {
      const holes = pick('circle').filter((e) => approx(e.r, check.holeR, check.holeRTol) && approx(dist(e.cx, e.cy, check.cx, check.cy), check.radius, check.rTol));
      const pass = holes.length >= check.count;
      return { pass, detail: `圆周孔 ${holes.length}/${check.count}` };
    }
    case 'linesThrough': {
      const n = pick('line').filter((e) => distToLine(check.cx, check.cy, e.x1, e.y1, e.x2, e.y2) <= check.tol).length;
      return { pass: n >= check.min, detail: `过圆心的直线 ${n}（期望≥${check.min}）` };
    }
    case 'bbox': {
      const bb = bboxOf(ents);
      if (!bb) return { pass: false, detail: '无实体' };
      const w = bb[2] - bb[0], h = bb[3] - bb[1];
      const pass = approx(w, check.w, check.tol) && approx(h, check.h, check.tol);
      return { pass, detail: `范围 ${w.toFixed(1)}×${h.toFixed(1)}（期望 ${check.w}×${check.h} ±${check.tol}）` };
    }
    case 'closedPolylineBbox': {
      const pl = pick('polyline').find((e) => e.closed);
      if (!pl) return { pass: false, detail: '无闭合多段线' };
      const bb = bboxOf([pl]);
      const w = bb[2] - bb[0], h = bb[3] - bb[1];
      const pass = approx(w, check.w, check.tol) && approx(h, check.h, check.tol);
      return { pass, detail: `闭合轮廓 ${w.toFixed(1)}×${h.toFixed(1)}（期望 ${check.w}×${check.h} ±${check.tol}）` };
    }
    case 'spiralGrowth': {
      // 蜗壳型线验收：系列圆圆心沿螺旋线渐进放大（半径随角度单调不减）
      const TAU = Math.PI * 2;
      const circs = pick('circle').filter((e) => dist(e.cx, e.cy, check.cx, check.cy) > 1e-6);
      const items = circs
        .map((e) => ({ d: dist(e.cx, e.cy, check.cx, check.cy), a: ((Math.atan2(e.cy - check.cy, e.cx - check.cx) % TAU) + TAU) % TAU }))
        .sort((x, y) => x.a - y.a);
      const N = items.length;
      const pass = N >= (check.minCount ?? 4) && items.every((it, i) => i === 0 || it.d >= items[i - 1].d - 1e-9);
      return { pass, detail: `螺旋圆 ${N} 个，半径序列 [${items.map((i) => i.d.toFixed(1)).join(', ')}]（${pass ? '渐进放大✓' : `需≥${check.minCount ?? 4} 且单调不减✗`}）` };
    }
    default:
      return { pass: false, detail: `未知检查类型 ${check.type}` };
  }
}

function check3d(check, bodies) {
  const kinds = (k) => bodies.filter((b) => b.kind === k);
  switch (check.type) {
    case 'featureCount': {
      const n = bodies.length;
      const pass = n >= check.min;
      return { pass, detail: `特征数=${n}（期望≥${check.min}）` };
    }
    case 'kindCount': {
      const n = kinds(check.kind).length;
      const pass = n >= check.min;
      return { pass, detail: `${check.kind} 数量=${n}（期望≥${check.min}）` };
    }
    case 'primDim': {
      const found = kinds(check.kind).find((b) => approx(b.params?.[check.field], check.approx, check.tol));
      return { pass: !!found, detail: found ? `${check.kind}.${check.field}=${found.params[check.field]}` : `${check.kind}.${check.field}≈${check.approx} 未找到` };
    }
    case 'primParam': {
      const hits = kinds(check.kind).filter((b) => approx(b.params?.[check.field], check.approx, check.tol));
      const pass = hits.length >= (check.minCount ?? 1);
      return { pass, detail: `${check.kind}.${check.field}≈${check.approx} 命中 ${hits.length}/${check.minCount ?? 1}` };
    }
    case 'primPos': {
      const hits = kinds(check.kind).filter((b) => approx(b.params?.x, check.x, check.tol) && approx(b.params?.y, check.y, check.tol));
      const pass = hits.length >= (check.minCount ?? 1);
      return { pass, detail: `${check.kind} @(±${check.x},±${check.y}) 命中 ${hits.length}/${check.minCount ?? 1}` };
    }
    /* —— 水泵组件专用验收 —— */
    case 'coaxial': {
      // 同轴度：多个圆柱(或指定 kind)轴线均过 (cx,cy)（台阶轴/轴套/泵壳内腔）
      const items = kinds(check.kind).filter((b) => b.params?.x != null);
      const offs = items.map((b) => dist(b.params.x, b.params.y, check.cx, check.cy)).sort((a, b) => a - b);
      const hits = items.filter((b) => approx(b.params?.x, check.cx, check.tol) && approx(b.params?.y, check.cy, check.tol));
      const pass = hits.length >= (check.minCount ?? 2);
      const list = offs.map((d) => d.toFixed(2)).join(', ');
      return { pass, detail: `${check.kind} 偏心量 [${list}]，同轴于(${check.cx},${check.cy})：${hits.length}/${check.minCount ?? 2}` };
    }
    case 'primSeq': {
      // 台阶轴验收：不同直径段数（台阶数）达到要求，并按直径降序排列
      const eps = (check.eps ?? 0.5);
      const rs = kinds(check.kind).map((b) => b.params?.[check.field]).filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
      const distinct = rs.filter((v, i) => i === 0 || rs[i - 1] - v > eps);
      const dec = rs.every((v, i) => i === 0 || rs[i - 1] >= v - eps);
      const pass = distinct.length >= (check.minCount ?? 2) && (check.dir === 'inc' ? rs.every((v, i) => i === 0 || rs[i - 1] <= v + eps) : dec);
      return { pass, detail: `${check.kind} 直径段 [${distinct.map((v) => Math.round(v * 10) / 10).join(', ')}]（${distinct.length}/${check.minCount ?? 2} 级台阶）` };
    }
    case 'ringDist': {
      // 环形均布：kind 实体中心落在半径 radius 的圆上（叶轮叶片/法兰孔）
      const items = kinds(check.kind).filter((b) => b.params?.x != null);
      const dists = items.map((b) => dist(b.params.x, b.params.y, check.cx, check.cy)).sort((a, b) => a - b);
      const onRing = items.filter((b) => approx(dist(b.params.x, b.params.y, check.cx, check.cy), check.radius, check.tol));
      const pass = onRing.length >= (check.minCount ?? 3);
      const list = dists.map((d) => d.toFixed(1)).join(', ');
      return { pass, detail: `${check.kind} 圆心距 [${list}]，R=${check.radius}±${check.tol} 命中 ${onRing.length}/${check.minCount ?? 3}` };
    }
    case 'angularEven': {
      // 叶片/孔的角度均匀性：按角排序后相邻角差接近 360/N（叶轮叶片均布验收）
      const items = kinds(check.kind).filter((b) => dist(b.params?.x, b.params?.y, check.cx, check.cy) > 1e-6);
      const TAU = Math.PI * 2;
      const angles = items.map((b) => Math.atan2(b.params.y - check.cy, b.params.x - check.cx)).sort((a, b) => a - b);
      const N = angles.length;
      if (N < 2) return { pass: false, detail: `${check.kind} 角度均布：实体不足 2 个` };
      const gaps = angles.map((a, i) => ((angles[(i + 1) % N] - a) % TAU + TAU) % TAU);
      const expected = TAU / N;
      const maxDev = Math.max(...gaps.map((g) => Math.abs(g - expected)));
      const devDeg = (maxDev * 180) / Math.PI;
      const pass = devDeg <= (check.maxDevDeg ?? 5);
      const list = angles.map((a) => ((a * 180) / Math.PI).toFixed(1)).join(', ');
      return { pass, detail: `${check.kind} 角度 [${list}]，最大角差偏差 ${devDeg.toFixed(1)}°（≤${check.maxDevDeg ?? 5}°${pass ? '✓' : '✗'}）` };
    }
    case 'dimSum': {
      // 尺寸求和：台阶轴总长 = 各段 h 之和
      const total = kinds(check.kind).reduce((s, b) => s + (Number(b.params?.[check.field]) || 0), 0);
      const pass = approx(total, check.approx, check.tol);
      return { pass, detail: `${check.kind}.${check.field} 求和=${Math.round(total * 10) / 10}（期望≈${check.approx}）` };
    }
    case 'fitClearance': {
      // 装配配合：轴径 outerR 与孔径 boreR 的间隙配合（工业装配验收：不得干涉、间隙在容差内）
      const cyls = kinds('cylinder').filter((c) => c.params?.r != null);
      const shafts = cyls.filter((c) => approx(c.params.r, check.outerR, check.outerTol ?? 1));
      const bores = cyls.filter((c) => approx(c.params.r, check.boreR, check.boreTol ?? 1));
      // 干涉：接近孔公差带、但半径小于轴径的圆柱（孔径偏小 → 轴装不进）
      const interference = cyls.some((c) => Math.abs(c.params.r - check.boreR) <= (check.boreTol ?? 1) + 1 && c.params.r < check.outerR);
      const gap = bores.length && shafts.length ? check.boreR - check.outerR : null;
      const pass = shafts.length >= 1 && bores.length >= 1 && !interference &&
        gap >= (check.minGap ?? 0) && gap <= (check.maxGap ?? Infinity);
      const why = [];
      if (!shafts.length) why.push('缺轴');
      if (!bores.length) why.push('缺孔');
      if (interference) why.push('干涉');
      if (gap != null && (gap < (check.minGap ?? 0) || gap > (check.maxGap ?? Infinity))) why.push('间隙超差');
      return {
        pass,
        detail: `轴 Φ${check.outerR * 2}/孔 Φ${check.boreR * 2}：${shafts.length ? '轴✓' : '缺轴'}·${bores.length ? '孔✓' : '缺孔'}${interference ? '·干涉!' : ''}·间隙=${gap == null ? '—' : gap.toFixed(2)}（${pass ? '配合合格' : '配合不合格：' + why.join('、')}）`,
      };
    }
    case 'fitChain': {
      // 多级配合链：轴→叶轮孔→轴承孔 逐级同轴、半径逐级增大（间隙配合链）
      const levels = check.chain || [];
      const cyls = kinds('cylinder');
      const axisTol = check.axisTol ?? 2;
      const found = levels.map((lv) => cyls.filter((c) =>
        approx(c.params.r, lv.r, lv.tol ?? 0.5) &&
        approx(c.params.x, check.cx, axisTol) && approx(c.params.y, check.cy, axisTol)));
      const gaps = [];
      for (let i = 1; i < levels.length; i++) gaps.push(levels[i].r - levels[i - 1].r);
      const allPresent = found.every((f) => f.length >= 1);
      const positiveGaps = gaps.every((g) => g > 0);
      const pass = levels.length >= 2 && allPresent && positiveGaps;
      const chain = levels.map((lv, i) => `${lv.name || 'L' + i} Φ${lv.r * 2}${found[i].length ? '✓' : '✗'}`).join(' → ');
      const gapTxt = gaps.length ? `，间隙[${gaps.map((g) => g.toFixed(2)).join(' / ')}]` : '';
      return { pass, detail: `${chain}${gapTxt}（配合链${pass ? '合格' : '不合格'}）` };
    }
    default:
      return { pass: false, detail: `未知检查类型 ${check.type}` };
  }
}

/* ---------------- 主入口 ---------------- */
/**
 * 验收打分
 * @param task  TRAIN_TASKS 中的任务
 * @param input 2D: 实体数组；3D: { bodies: [...] }
 */
export function evaluate(task, input) {
  const checks = task.checks || [];
  const total = checks.reduce((s, c) => s + (c.weight ?? 1), 0);
  let passed = 0;
  const results = [];
  if (task.ws === '2d') {
    const ents = Array.isArray(input) ? input : (input?.entities || []);
    for (const c of checks) {
      const r = check2d(c, ents);
      results.push({ name: `${c.type}:${JSON.stringify(c)}`, ...r, weight: c.weight ?? 1 });
      if (r.pass) passed += c.weight ?? 1;
    }
  } else {
    const bodies = Array.isArray(input?.bodies) ? input.bodies : [];
    for (const c of checks) {
      const r = check3d(c, bodies);
      results.push({ name: `${c.type}:${JSON.stringify(c)}`, ...r, weight: c.weight ?? 1 });
      if (r.pass) passed += c.weight ?? 1;
    }
  }
  return {
    score: total ? Math.round((passed / total) * 100) : 0,
    total, passed,
    checks: results,
  };
}

/** 训练日志条目序列化（页面与 Node 共用） */
export function logEntry({ taskId, taskName, round, ws, scoreBefore, scoreAfter, reviewOutcome, reviewRounds, fbRounds = 0, fails = [], ts = Date.now(), note = '' }) {
  return { ts, taskId, taskName, round, ws, scoreBefore, scoreAfter, delta: scoreAfter - scoreBefore, reviewOutcome, reviewRounds, fbRounds, fails, note };
}

/** 验收反馈提示：把未通过的检查明细转成给模型的修复指令（训练闭环的"梯度"） */
export function feedbackPrompt(task, result) {
  const fails = (result?.checks || []).filter((c) => !c.pass);
  if (!fails.length) return '';
  const lines = fails.map((c) => `- ${c.detail}`);
  return `[训练任务:${task.id}] [验收反馈] 当前图纸验收 ${result.score} 分，以下检查项未通过，请直接修复（只做修复，不要重复说明）：\n${lines.join('\n')}`;
}
