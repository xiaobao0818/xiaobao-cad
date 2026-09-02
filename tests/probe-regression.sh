#!/usr/bin/env bash
# ============================================================
# 探针门禁（G0）：知识/系统提示注入前的异类任务回归探测
# 背景：变量5 幅面条目污染 flange2d/volute2d（100→50/17）导致 24 轮预算浪费。
# 规则：任何 knowledge/data.js 或 js/ai.js 系统提示的知识性改动，在跑正式固定
#       EVAL 集之前，必须先通过本门禁（flange2d/volute2d/threeview2d 各 1 轮 EVAL）。
# 用法：bash tests/probe-regression.sh          # 真实 MiniMax（需 MINIMAX_KEY）
#       THRESHOLD=90 bash tests/probe-regression.sh   # 自定义阈值
# 判定：三任务最新一轮首绘分 ≥ 阈值（默认 85）→ exit 0；任一低于 → exit 1（禁止注入提交）
# 说明：探针任务 = 简单零件图(flange2d) + 型线图(volute2d) + 多视图(threeview2d)，
#       分别覆盖"无图框零件图/曲线型线/多视图"三类易被全局规则污染的场景。
# ============================================================
set -u
cd "$(dirname "$0")/.." || exit 2
THRESHOLD="${THRESHOLD:-85}"
if [ -z "${MINIMAX_KEY:-}" ]; then echo "❌ 需要 MINIMAX_KEY 环境变量"; exit 2; fi

pkill -f "http.server 8899" 2>/dev/null; sleep 0.5
python3 -m http.server 8899 >/tmp/xbcad-http.log 2>&1 &
HTTP_PID=$!
sleep 1.5

FAILED=0
for T in flange2d volute2d threeview2d; do
  echo "== 探针 $T ×1 =="
  TASK=$T EVAL=1 REAL=1 ROUNDS=1 KEEP=1 MINIMAX_KEY="$MINIMAX_KEY" node tests/e2e-train-loop.mjs >/tmp/probe-$T.log 2>&1
  RC=$?
  SCORE=$(python3 -c "
import json
es = json.load(open('training/logs/last-log.json'))
rs = [e for e in es if e.get('mode')=='real' and (e.get('taskId') or e.get('taskName'))=='$T']
rs.sort(key=lambda e: e['ts'])
print(rs[-1].get('scoreAfter', -1) if rs else -1)
" 2>/dev/null)
  echo "  $T: exit=$RC score=$SCORE (阈值 $THRESHOLD)"
  if [ "$RC" != "0" ] || [ "$SCORE" = "-1" ] || [ "$SCORE" -lt "$THRESHOLD" ]; then
    echo "  ✗ $T 未过门禁"; FAILED=1
  fi
done
kill $HTTP_PID 2>/dev/null
if [ "$FAILED" = "0" ]; then
  echo "✅ 探针门禁通过（三任务均 ≥$THRESHOLD）——允许进行知识/提示注入"
  exit 0
else
  echo "❌ 探针门禁未通过——知识/提示改动会污染异类任务，禁止注入；先回退改动或换注入通道（知识库检索）"
  exit 1
fi
