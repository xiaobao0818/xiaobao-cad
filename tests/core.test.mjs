/* 小宝CAD 核心模块自动化测试（node tests/core.test.mjs） */
import { strict as assert } from 'node:assert';
import {
  dist, segSegIntersection, lineCircleIntersections, circleCircleIntersections,
  arcFromBulge, bulgeFromArc, circleThrough3, mirrorM, rotationM, translationM,
  scaleM, composeM, applyM, matrixScaleXY, pointInPolygon, flattenPolyline,
} from '../js/util.js';
import { make, transformEntity, entityIntersections, entityCurves, HANDLERS } from '../js/entities.js';
import { Scene } from '../js/scene.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

console.log('== 几何 ==');
{
  const p = segSegIntersection({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
  assert(p && Math.abs(p.x - 5) < 1e-9 && Math.abs(p.y - 5) < 1e-9);
  ok('线段相交');
  assert.equal(segSegIntersection({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 6 }), null);
  ok('平行线段无交点');
}
{
  const r = lineCircleIntersections({ x: -10, y: 0 }, { x: 10, y: 0 }, 0, 0, 5);
  assert.equal(r.length, 2);
  assert(Math.abs(Math.abs(r[0].x) - 5) < 1e-9);
  ok('直线与圆相交');
}
{
  const r = circleCircleIntersections({ x: 0, y: 0 }, 5, { x: 8, y: 0 }, 5);
  assert.equal(r.length, 2);
  assert(Math.abs(r[0].x - 4) < 1e-9);
  ok('两圆相交');
}
{
  const arc = arcFromBulge({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.4142);
  assert(arc && Math.abs(arc.r - 7.07) < 0.05);
  const b = bulgeFromArc({ ccw: arc.ccw, startAngle: arc.startAngle, endAngle: arc.endAngle });
  assert(Math.abs(b - 0.4142) < 1e-3);
  ok('凸度 ↔ 圆弧 互转');
}
{
  const cc = circleThrough3({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 });
  assert(cc && Math.abs(cc.cx - 5) < 1e-9 && Math.abs(cc.cy - 5) < 1e-9 && Math.abs(cc.r - 7.071) < 1e-3);
  ok('三点圆');
}
{
  const m = composeM(rotationM(Math.PI / 2, 10, 10), translationM(5, 5));
  const p = applyM(m, { x: 10, y: 10 });
  // 先平移 (10,10)->(15,15)，再绕 (10,10) 逆时针转 90° -> (5,15)
  assert(Math.abs(p.x - 5) < 1e-9 && Math.abs(p.y - 15) < 1e-9);
  ok('矩阵复合');
  const mir = mirrorM({ x: 0, y: 0 }, { x: 0, y: 1 });
  const q = applyM(mir, { x: 3, y: 2 });
  assert(Math.abs(q.x + 3) < 1e-9 && Math.abs(q.y - 2) < 1e-9);
  ok('镜像矩阵');
  const { sx, sy } = matrixScaleXY(scaleM(2, 0.5));
  assert(Math.abs(sx - 2) < 1e-9 && Math.abs(sy - 0.5) < 1e-9);
  ok('非等比缩放分解');
}
{
  const inside = pointInPolygon({ x: 1, y: 1 }, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);
  assert(inside && !pointInPolygon({ x: 5, y: 5 }, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]));
  ok('点在多边形内');
  const flat = flattenPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], [0.4142]);
  assert(flat.length > 5);
  ok('凸度多段线扁平化');
}

console.log('== 实体 ==');
{
  const l = make.line({ x: 0, y: 0 }, { x: 10, y: 0 });
  const t = transformEntity(l, translationM(5, 5));
  assert(Math.abs(t.x1 - 5) < 1e-9 && Math.abs(t.y1 - 5) < 1e-9 && Math.abs(t.x2 - 15) < 1e-9);
  ok('直线平移');
  const c = make.circle({ x: 0, y: 0 }, 5);
  const tc = transformEntity(c, scaleM(2));
  assert(Math.abs(tc.r - 10) < 1e-9);
  ok('圆等比缩放');
  const tcn = transformEntity(c, scaleM(2, 0.5));
  assert.equal(tcn.type, 'ellipse');
  assert(Math.abs(tcn.rx - 10) < 1e-9 && Math.abs(tcn.ry - 2.5) < 1e-9);
  ok('圆非等比缩放→椭圆');
  const pl = make.polyline([{ x: 0, y: 0 }, { x: 10, y: 0, bulge: 0.4142 }], { closed: false });
  const tpl = transformEntity(pl, rotationM(Math.PI, 0, 0));
  assert(Math.abs(tpl.points[1].bulge - 0.4142) < 1e-6);
  const mpl = transformEntity(pl, mirrorM({ x: 0, y: 0 }, { x: 0, y: 1 }));
  assert(Math.abs(mpl.points[1].bulge + 0.4142) < 1e-6);
  ok('凸度在旋转下不变、镜像下取反');
  const txt = make.text({ x: 0, y: 0 }, '你好', 5, 0);
  const ttxt = transformEntity(txt, scaleM(2));
  assert(Math.abs(ttxt.height - 10) < 1e-9);
  ok('文字等比缩放');
}
{
  const c1 = make.circle({ x: 0, y: 0 }, 5);
  const l1 = make.line({ x: -10, y: 0 }, { x: 10, y: 0 });
  const is = entityIntersections(c1, l1);
  assert.equal(is.length, 2);
  ok('实体求交（圆×线）');
  const curves = entityCurves(c1);
  assert.equal(curves[0].kind, 'circle');
  const c2 = make.circle({ x: 8, y: 0 }, 5);
  assert.equal(entityIntersections(c1, c2).length, 2);
  ok('实体求交（圆×圆）');
}

console.log('== 场景 ==');
{
  const s = new Scene();
  s.ensureLayer('轮廓', { color: '#ff0000' });
  s.setCurrentLayer('轮廓');
  const l = s.addEntity(make.line({ x: 0, y: 0 }, { x: 10, y: 0 }));
  assert.equal(s.count(), 1);
  assert.equal(l.layer, '轮廓');
  s.singleOp('移动', () => s.transformEntities(translationM(0, 5), [l.id]));
  assert(Math.abs(s.get(l.id).y1 - 5) < 1e-9);
  s.undo();
  assert(Math.abs(s.get(l.id).y1) < 1e-9);
  s.redo();
  assert(Math.abs(s.get(l.id).y1 - 5) < 1e-9);
  ok('撤销/重做');
}
{
  const s = new Scene();
  s.ensureLayer('墙体', { color: '#ffff00' });
  s.setCurrentLayer('墙体');
  const e1 = s.addEntity(make.line({ x: 0, y: 0 }, { x: 100, y: 0 }));
  const e2 = s.addEntity(make.circle({ x: 50, y: 50 }, 10));
  s.addBlock('门', { x: 0, y: 0 }, [e2]);
  s.addEntity(make.insert('门', { x: 30, y: 30 }));
  const json = JSON.stringify(s.serialize());
  const s2 = Scene.load(JSON.parse(json));
  assert.equal(s2.count(), 3);
  assert(s2.blocks.has('门'));
  assert.equal(s2.currentLayer, '墙体');
  assert.equal(s2.get(e1.id).type, 'line');
  ok('序列化/反序列化');
}
{
  const s = new Scene();
  s.beginUndoGroup('组');
  const a = s.addEntity(make.line({ x: 0, y: 0 }, { x: 1, y: 0 }));
  const b = s.addEntity(make.circle({ x: 0, y: 0 }, 1));
  s.endUndoGroup();
  s.undo();
  assert.equal(s.count(), 0);
  s.redo();
  assert.equal(s.count(), 2);
  ok('撤销组');
}

console.log(`\n全部通过：${n} 项`);
