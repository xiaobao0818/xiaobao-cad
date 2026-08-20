/* 小宝CAD 自动训练器：跨任务持续轮巡训练 + 日志累积 + 报告归档
 * 用法：
 *   node tests/auto-train.mjs                        # mock 全部任务各 1 轮
 *   node tests/auto-train.mjs --tasks pumpduty3d,axialflow3d --rounds 2
 *   REAL=1 MINIMAX_KEY=... node tests/auto-train.mjs --tasks conversation3d
 * 输出：training/logs/last-log.json（跨会话累积）+ archive 归档 JSON/Markdown 报告 */
import { spawn } from 'node:child_process';
import { TRAIN_TASKS } from '../training/tasks.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const taskArg = opt('tasks', 'all');
const tasks = taskArg === 'all'
  ? TRAIN_TASKS.map((t) => t.id)
  : taskArg.split(',').map((s) => s.trim()).filter(Boolean);
const rounds = Math.max(1, parseInt(opt('rounds', '1'), 10));

const run = (cmd, cargs, env = {}) => new Promise((resolve) => {
  const p = spawn(cmd, cargs, { stdio: 'inherit', env: { ...process.env, ...env } });
  p.on('close', (code) => resolve(code));
});

const SKIP3D_HINTS = ['bom', 'drawing', 'threeview', 'flange', 'bracket', 'pump2d', 'volute', 'pumpdrawing'];
const skip3d = (t) => (SKIP3D_HINTS.some((h) => t.includes(h)) ? '1' : '');

console.log(`== 自动训练：${tasks.length} 个任务 × ${rounds} 轮（${process.env.REAL ? '真实 MiniMax M3' : 'mock'}） ==`);
let fail = 0;
for (let r = 1; r <= rounds; r++) {
  for (const t of tasks) {
    const code = await run('node', ['tests/e2e-train-loop.mjs'], { TASK: t, ROUNDS: '1', KEEP: '1', SKIP3D: skip3d(t) });
    if (code !== 0) { fail++; console.log(`  ✗ ${t} 失败`); }
    else console.log(`  ✓ ${t} 完成（第 ${r}/${rounds} 轮）`);
  }
}
console.log(fail ? `训练完成（${fail} 个失败）` : '训练完成，全部通过');
await run('node', ['tests/dump-training.mjs']);
