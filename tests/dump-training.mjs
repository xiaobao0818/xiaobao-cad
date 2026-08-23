/* 小宝CAD 训练日志导出：E2E 落盘的 training/logs/last-log.json → 归档 JSON + Markdown 报告
 * 用法：node tests/dump-training.mjs [输出目录] */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { entriesToMarkdown } from '../training/report.mjs';
import { realOnly } from '../training/stats.mjs';

const SRC = 'training/logs/last-log.json';
const OUT = process.argv[2] || 'training/logs/archive';
const WITH_MOCK = process.argv.includes('--with-mock');
let all = [];
try { all = JSON.parse(readFileSync(SRC, 'utf8')); }
catch (e) { console.log('未找到 ' + SRC + '（先跑一轮训练：npm run test:e2e）'); process.exit(1); }
if (!all.length) { console.log('训练日志为空'); process.exit(1); }
// mock 剧本分数写死，进报告会让趋势失真；--with-mock 可强制包含
const entries = WITH_MOCK ? all : realOnly(all);
if (!entries.length) { console.log(`${all.length} 轮日志中没有真实模型轮次（全部为 mock）`); process.exit(1); }
if (entries.length !== all.length) console.log(`只统计真实模型轮次：${entries.length}/${all.length}（已排除 mock ${all.length - entries.length} 轮）`);
mkdirSync(OUT, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(join(OUT, `training-log-${ts}.json`), JSON.stringify(entries, null, 2));
const md = entriesToMarkdown(entries);
writeFileSync(join(OUT, `training-report-${ts}.md`), md);
console.log(md.split('\n').slice(0, 12).join('\n'));
console.log(`\n导出完成：${OUT}/training-log-${ts}.json（${entries.length} 轮）+ training-report-${ts}.md`);
