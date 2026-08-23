# 失败率成因分析（阶段 3）

## 结论
失败几乎全是 **noproduce（模型首轮不调用工具）**，timeout = 0。

| outcome | 数量 | 占比 | 性质 |
|---|---|---|---|
| ok | 153 | 90% | 正常 |
| noproduce | 14 | 8.2% | 模型能力/行为：首轮只输出 think 计划，未调用创建工具 |
| unknown-fail | 3 | 1.8% | 老日志回填启发式（scoreBefore=0 且 note=绘制未完成），非事实 |

## EVAL 新采证据（48 轮）
- noproduce 3 轮（6.3%）：volute2d、doublesuction3d、minipump3d
- 三例一致模式：模型第一轮回复为 `<think>...计划...</think>` 纯文字，
  未调用任何 create_primitive_3d/draw_entities；第二轮才真正绘制（100/88 分）
- 首轮纪律在 EVAL（noreview）场景下偶发失效

## 针对性改动（阶段 5 实施）
js/ai.js `_runWithTools`：首轮无工具调用且工作区无产出时，
自动追加「请直接调用工具，不要只输出计划」并重试一次（运行时兜底，非提示词改动）。
