/* DWG 参考文件文本提取测试（合成 DWG 二进制） */
import { strict as assert } from 'node:assert';
import AIChatPanel from '../js/ai.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// 合成一个 DWG 文件：AC1027 头 + 二进制噪声 + ASCII 图层名 + UTF-16LE 中文文字
function synthDWG() {
  const parts = [];
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0) & 0xff);
  parts.push([0x41, 0x43, 0x31, 0x30, 0x32, 0x37]); // AC1027 = 2007
  parts.push(Array.from({ length: 256 }, (_, i) => (i * 37) & 0xff)); // 二进制噪声
  parts.push(ascii('WALL-LAYER'));
  parts.push([0, 1, 2, 3]);
  parts.push(ascii('S-COLU'));
  parts.push([0xff, 0xfe]);
  parts.push(ascii('DOOR'));
  parts.push(Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff));
  // UTF-16LE 中文
  const utf16 = (s) => {
    const out = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      out.push(c & 0xff, (c >> 8) & 0xff);
    }
    return out;
  };
  parts.push(utf16('一层平面图'));
  parts.push(utf16('客厅'));
  parts.push(utf16('主卧'));
  return new Uint8Array(parts.flat());
}

console.log('== DWG 文本提取 ==');
{
  const panel = Object.create(AIChatPanel.prototype);
  const bytes = synthDWG();
  assert.equal(panel._dwgVersion(bytes), '2013');
  ok('版本识别: AC1027 → 2013');
  const ascii = panel._extractASCII(bytes);
  assert(ascii.includes('WALL-LAYER') && ascii.includes('S-COLU') && ascii.includes('DOOR'));
  ok('ASCII 名称提取: 图层/块名');
  const utf16 = panel._extractUTF16Text(bytes);
  assert(utf16.some((t) => t.includes('客厅')));
  assert(utf16.some((t) => t.includes('主卧')));
  assert(utf16.some((t) => t.includes('一层平面图')));
  ok('UTF-16 中文文字提取: 图纸文字');
  const summary = panel._summarizeDWG(bytes);
  assert(summary.includes('版本 2013'));
  assert(summary.includes('WALL-LAYER'));
  assert(summary.includes('客厅'));
  assert(summary.includes('转换为 DXF'));
  ok('摘要生成: 版本+名称+文字+转换提示');
}

console.log(`\n全部通过：${n} 项`);
