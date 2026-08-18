/* DWG 解析映射测试（用 LibreDWG 官方示例文件） */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapDwgDatabase } from '../js/dwg.js';

const libPath = fileURLToPath(new URL('../node_modules/@mlightcad/libredwg-web/dist/libredwg-web.js', import.meta.url));
const { LibreDwg, Dwg_File_Type } = await import(libPath);

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

console.log('== DWG 解析映射（真实示例文件 example_2007.dwg） ==');
{
  const lib = await LibreDwg.create();
  const bytes = new Uint8Array(readFileSync(new URL('../samples/sample_example_2007.dwg', import.meta.url)));
  const dwg = lib.dwg_read_data(bytes, Dwg_File_Type.DWG);
  assert(dwg, 'DWG 读取失败');
  const db = lib.convert(dwg);
  const data = mapDwgDatabase(db);

  assert(data.entities.length >= 30, '实体数量应 ≥30，实际 ' + data.entities.length);
  ok(`解析实体 ${data.entities.length} 个`);

  const byType = {};
  for (const e of data.entities) byType[e.type] = (byType[e.type] || 0) + 1;
  assert(byType.line > 0 && byType.polyline > 0 && byType.arc > 0 && byType.text > 0);
  ok(`类型分布: ${Object.entries(byType).map(([k, v]) => k + '×' + v).join(', ')}`);

  const line = data.entities.find((e) => e.type === 'line');
  assert(Number.isFinite(line.x1) && Number.isFinite(line.y2));
  assert(line.layer && line.layer !== '0');
  ok('线实体：坐标与图层正确');

  const arc = data.entities.find((e) => e.type === 'arc');
  assert(arc.r > 100 && arc.startAngle >= 0 && arc.endAngle >= 0);
  ok('圆弧实体：半径与弧度角正确');

  const pl = data.entities.find((e) => e.type === 'polyline');
  assert(pl.points.length >= 2 && typeof pl.points[0].bulge === 'number');
  ok('多段线实体：顶点与凸度正确');

  const txt = data.entities.find((e) => e.type === 'text');
  assert(typeof txt.text === 'string' && txt.height > 0);
  ok('文字实体：内容与字高正确');

  const mtext = data.entities.find((e) => e.type === 'text' && e.text.includes('\n'));
  ok(mtext ? '多行文字已转换（\\P→换行）' : '多行文字未出现（本文件无多行换行）');

  const ins = data.entities.find((e) => e.type === 'insert');
  if (ins) {
    assert(ins.block && ins.block.length > 0);
    ok('块引用实体：块名正确');
  }

  assert(data.layers.length >= 2);
  const l0 = data.layers.find((l) => l.name === '0');
  assert(l0, '必须包含 0 图层');
  const l2 = data.layers.find((l) => l.name !== '0');
  assert(l2 && (typeof l2.color === 'string' || typeof l2.color === 'number'));
  ok(`图层表：${data.layers.length} 个图层（含 0 层）`);
}
{
  // 空/异常输入防御
  const data = mapDwgDatabase({ tables: {}, header: {}, entities: [] });
  assert.equal(data.entities.length, 0);
  assert(data.layers.some((l) => l.name === '0'));
  ok('空数据库：返回默认 0 图层，不崩溃');
}
{
  // 传统 POLYLINE2D/3D 多段线（旧版本 DWG 常见，此前被静默丢弃）
  const data = mapDwgDatabase({
    tables: { LAYER: { entries: [] } }, header: {},
    entities: [
      { type: 'POLYLINE2D', flag: 1, layer: '0', vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 0.5 }, { x: 10, y: 10, bulge: 0 }] },
      { type: 'POLYLINE3D', flag: 0, layer: '0', vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
    ],
  });
  const pls = data.entities.filter((e) => e.type === 'polyline');
  assert.equal(pls.length, 2, `传统多段线应全部导入，实际 ${pls.length}`);
  const closed = pls.find((e) => e.closed);
  assert(closed && closed.points.length === 3 && Math.abs(closed.points[1].bulge - 0.5) < 1e-9, 'POLYLINE2D 应闭合且保留 bulge');
  const open = pls.find((e) => !e.closed);
  assert(open && open.points.length === 2, 'POLYLINE3D 应导入 2 个顶点');
  ok('传统 POLYLINE2D/3D 多段线导入');
}

console.log(`\n全部通过：${n} 项`);
