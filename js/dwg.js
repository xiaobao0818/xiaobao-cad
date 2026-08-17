/* ============================================================
 * 小宝CAD DWG 解析 —— 基于 @mlightcad/libredwg-web（LibreDWG WASM）
 * parseDWG(bytes) → { layers, entities, currentLayer, units }
 * 与 dxf.js 输出结构一致，可直接喂给 applyDXFData / buildDataSummary
 * ============================================================ */
import { uid } from './util.js';

let _libPromise = null;
function getLib() {
  if (!_libPromise) {
    _libPromise = (async () => {
      const mod = await import('/node_modules/@mlightcad/libredwg-web/dist/libredwg-web.js');
      const lib = await mod.LibreDwg.create('/node_modules/@mlightcad/libredwg-web/wasm');
      return { lib, Dwg_File_Type: mod.Dwg_File_Type };
    })();
  }
  return _libPromise;
}

/** 解析 DWG 二进制（浏览器）。返回 {layers, entities, currentLayer, units} */
let _queue = Promise.resolve();
export function parseDWG(bytes) {
  // libredwg WASM 不可重入：同一时刻只能有一个解析任务
  const run = _queue.then(() => doParseDWG(bytes));
  _queue = run.catch(() => {});
  return run;
}
async function doParseDWG(bytes) {
  const { lib, Dwg_File_Type } = await getLib();
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dwg = lib.dwg_read_data(arr, Dwg_File_Type.DWG);
  if (!dwg) throw new Error('DWG 解析失败（文件可能损坏或版本不受支持）');
  try {
    const db = lib.convert(dwg);
    if (!db || !Array.isArray(db.entities)) throw new Error('DWG 转换失败：未获得实体数据');
    return mapDwgDatabase(db);
  } finally {
    try { lib.dwg_free(dwg); } catch (e) { /* 释放失败忽略 */ }
  }
}

/* ---------------- 颜色 / 线型工具 ---------------- */
function mapColor(e) {
  const ci = e.colorIndex;
  if (ci === 0 || ci === 256 || ci == null) {
    // 真彩色
    if (typeof e.color === 'number' && e.color > 0 && e.color !== 16777215) {
      return '#' + e.color.toString(16).padStart(6, '0');
    }
    return null;
  }
  return ci;
}
function mapLayer(l) {
  const color = mapColor(l);
  return {
    name: l.name || '0',
    color: color ?? '#ffffff',
    on: !l.off && !l.frozen,
    locked: !!l.locked,
    ltype: l.lineType || 'CONTINUOUS',
  };
}
function base(e, type) {
  return {
    id: uid(), type, layer: e.layer || '0', color: mapColor(e),
    ltype: e.lineType || null, lw: e.lineweight ? e.lineweight / 100 : null,
  };
}
const V = (p) => ({ x: p?.x ?? 0, y: p?.y ?? 0 });

/* ---------------- 实体映射（纯函数，可单测） ---------------- */
export function mapDwgDatabase(db) {
  const layers = (db.tables?.LAYER?.entries || []).map(mapLayer);
  if (!layers.some((l) => l.name === '0')) layers.unshift({ name: '0', color: '#ffffff', on: true, locked: false, ltype: 'CONTINUOUS' });
  const entities = [];
  for (const e of db.entities || []) {
    try {
      switch (e.type) {
        case 'LINE':
          entities.push({ ...base(e, 'line'), x1: e.startPoint.x, y1: e.startPoint.y, x2: e.endPoint.x, y2: e.endPoint.y });
          break;
        case 'CIRCLE':
          if (e.center) entities.push({ ...base(e, 'circle'), cx: e.center.x, cy: e.center.y, r: e.radius ?? 0 });
          break;
        case 'ARC':
          if (e.center) entities.push({ ...base(e, 'arc'), cx: e.center.x, cy: e.center.y, r: e.radius ?? 0, startAngle: e.startAngle ?? 0, endAngle: e.endAngle ?? Math.PI * 2, ccw: true });
          break;
        case 'LWPOLYLINE': {
          const pts = (e.vertices || []).map((v) => ({ x: v.x, y: v.y, bulge: v.bulge || 0 }));
          if (pts.length >= 2) entities.push({ ...base(e, 'polyline'), points: pts, closed: !!(e.flag & 1) });
          break;
        }
        case 'ELLIPSE': {
          const mx = e.majorAxisEndPoint?.x ?? 0, my = e.majorAxisEndPoint?.y ?? 0;
          const rx = Math.hypot(mx, my) || 1;
          const ent = { ...base(e, 'ellipse'), cx: e.center?.x ?? 0, cy: e.center?.y ?? 0, rx, ry: rx * (e.axisRatio ?? 1), rot: Math.atan2(my, mx) };
          const full = ((e.startAngle ?? 0) === 0 && (e.endAngle ?? Math.PI * 2) >= Math.PI * 2 - 1e-6);
          if (!full) { ent.startAngle = e.startAngle ?? 0; ent.endAngle = e.endAngle ?? Math.PI * 2; }
          entities.push(ent);
          break;
        }
        case 'TEXT': {
          const halign = e.halign === 1 ? 'center' : e.halign === 2 ? 'right' : 'left';
          const valign = e.valign === 1 ? 'bottom' : e.valign === 2 ? 'middle' : e.valign === 3 ? 'top' : 'baseline';
          entities.push({ ...base(e, 'text'), x: e.startPoint?.x ?? 0, y: e.startPoint?.y ?? 0, text: String(e.text ?? ''), height: e.textHeight ?? 2.5, rotation: e.rotation ?? 0, halign, valign });
          break;
        }
        case 'MTEXT': {
          const ap = e.attachmentPoint || 1;
          const halign = [1, 4, 7].includes(ap) ? 'left' : [3, 6, 9].includes(ap) ? 'right' : 'center';
          const valign = [1, 2, 3].includes(ap) ? 'top' : [7, 8, 9].includes(ap) ? 'bottom' : 'middle';
          entities.push({ ...base(e, 'text'), x: e.insertionPoint?.x ?? 0, y: e.insertionPoint?.y ?? 0, text: String(e.text ?? '').replace(/\\P/g, '\n'), height: e.textHeight ?? 2.5, rotation: e.rotation ?? 0, halign, valign });
          break;
        }
        case 'POINT':
          entities.push({ ...base(e, 'point'), x: e.position?.x ?? 0, y: e.position?.y ?? 0 });
          break;
        case 'INSERT':
          entities.push({ ...base(e, 'insert'), block: e.name || '', x: e.insertionPoint?.x ?? 0, y: e.insertionPoint?.y ?? 0, scaleX: e.xScale ?? 1, scaleY: e.yScale ?? 1, rotation: e.rotation ?? 0 });
          break;
        default:
          break; // SPLINE/HATCH/DIMENSION/3DSOLID 等暂不支持
      }
    } catch (err) { /* 单个实体失败不阻断整体 */ }
  }
  return { layers, entities, currentLayer: db.header?.CLAYER || '0', units: 'mm' };
}
