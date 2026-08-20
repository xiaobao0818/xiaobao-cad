/* 小宝CAD 训练日志导出：E2E 落盘的 training/logs/last-log.json → 归档 JSON + Markdown 报告
 * 用法：node tests/dump-training.mjs [输出目录] */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { entriesToMarkdown } from '../training/report.mjs';

const SRC = 'training/logs/last-log.json';
const OUT = process.argv[2] || 'training/logs/archive';
let entries = [];
try { entries = JSON.parse(readFileSync(SRC, 'utf8')); }
catch (e) { console.log('未找到 ' + SRC + '（先跑一轮训练：npm run test:e2e）'); process.exit(1); }
if (!entries.length) { console.log('训练日志为空'); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(join(OUT, `training-log-${ts}.json`), JSON.stringify(entries, null, 2));
const md = entriesToMarkdown(entries);
writeFileSync(join(OUT, `training-report-${ts}.md`), md);
console.log(md.split('\n').slice(0, 12).join('\n'));
console.log(`\n导出完成：${OUT}/training-log-${ts}.json（${entries.length} 轮）+ training-report-${ts}.md`);
