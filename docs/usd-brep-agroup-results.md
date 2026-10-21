# A 组实测报告：SMLib（usd-brep）vs 我们的 OCC-WASM 管线（2026-10-21）

> 目的：验证"服务端 SMLib 能否提升 AI 建模成品率"（A1 修复 / A2 布尔鲁棒 / A3 几何自检）
> 环境：服务器 chroot（Ubuntu 24.04 rootfs, glibc 2.39）+ CPython 3.12.15 + `usd_brep` 1.0.0（wheel 86MB）
> 说明：服务器原生 glibc 2.32，wheel 要求 manylinux_2_34 且 `libusd_sdf.so` 引用 GLIBC_2.34 → 只能用 chroot 运行

## 一、环境结论（可复现）

| 项 | 结果 |
|---|---|
| `pip install usd-brep` 直装服务器 | ❌ 失败（glibc 2.32 < 2.34） |
| chroot + Ubuntu 24.04 rootfs | ✅ 成功，`usd_brep` 导入正常 |
| 缺失运行库 | 需补 `libtbb.so.12`（wheel 未自带，从 PyPI `tbb` 包取） |
| 内核实测可用 API | `primitives` / `booleans` / `queries` / `stitching` / `usd` / `fillets` / `sweeps` / `io` / `brep_ops` |

## 二、A2 布尔鲁棒性（同几何对比）

**重要修正**：首轮对比出现"OCC 共面切除偏 +50%"是**错误的**——OCC 的 `createBox({x,y,z})`
是**中心式**（盒体以 (x,y,z) 为中心），SMLib 的 `create_box(origin,…)` 是**角点式**，两者几何不同。
用同几何重测后，OCC 全部精确：

| 案例 | OCC（同几何重测） | SMLib | 结论 |
|---|---|---|---|
| 共面切除 box100 - box(100,100,50)@z50 | **500,000.0（0.0000%）** | **500,000.0（0.0000%）** | 平手（都正确） |
| 相切切除 box - cyl(r50) | 607,300.9（0.0000%） | 607,300.79（1e-6 精度下 0.0000%；默认 0.001 精度 −0.376%） | 平手（SMLib 需收紧积分精度） |
| 同心管 cyl(R50)−cyl(R20) | 659,734.5（0.0000%） | 659,895.7（默认 +0.024%；1e-6 下精确） | 平手 |
| 薄壁相切 cyl(r49.999) | 607,316.6（0.0000%） | 607,316.50（1e-6 下 0.0000%） | 平手 |
| 完全重合 cut | 0.0 | 0.0 | 平手 |
| 面接触 intersection | 抛"无重叠区域" | 返回空体 0.0 | SMLib 语义更宽松 |

**结论：未发现 SMLib 在布尔鲁棒性上优于 OCC 的证据**（此前怀疑的共面失效不成立）。

## 三、A3 几何自检（查询准确性）

| 查询 | SMLib 表现 |
|---|---|
| `compute_volume` 默认精度 0.001 | 曲面布尔结果偏差可达 −0.376%；**传 `relative_accuracy=1e-6` 后精确** |
| `is_manifold_solid` | 正确识别正常实体=True、仅共享棱的 union=False（真非流形） |
| `brep_bounding_box` | 正常（含 2e-5 容差外扩） |
| `face_area` / `get_faces_via_api` / `get_edges_via_api` | 可用 |

→ 自检能力可用，但**默认精度不足以做验收**，必须显式收紧；这一点我们 OCC 侧的 volume 直接精确。

## 四、A1 修复（healing）实测

| 场景 | 结果 |
|---|---|
| 箱体/圆柱正常布尔 | 结果天然流形，`stitch_into_solid` 报告 `stitched=0, gaps=0`（无事可做） |
| 上下/左右叠放 union（共面贴合，含 0.001~5mm 缝隙） | SMLib 布尔直接给出流形结果，体积精确 2,000,000；无需修复 |
| 仅共享一条棱的 union（真非流形） | `is_manifold_solid=False` 正确识别；`stitch_into_solid` 仍 `is_solid=True` 但 **manifold=False（修不了非流形拓扑）** |
| USDA 缺陷（顶点/边偏移 2~5mm） | `usd.heal_file` 返回 `SM_SUCCESS`，体积回归干净值（±0.0001%）；`import_brep(heal=True)` 同样有效 |
| USDA 缺陷（边偏移 20 / 50mm） | **修复无效**（体积误差 +7.0% / +17.4% 原样保留）→ 修复只针对容差级缺陷，不能纠正严重几何错误 |
| `heal_file` 细节 | 要求输出文件不存在（存在即报 `SM_ERR_INVALID_INPUT`）；返回 `BrepArrayHealResult{ok,status_code,status_name,prim_path,brep_count,message}` |

## 五、互操作（对我们最相关的两条）

| 项 | 结果 |
|---|---|
| OCC 导出 STEP → SMLib 导入 | ❌ **不可用**：`io.read_part_from_file` 对 STEP 返回 4 个空列表；`read_brep_from_file` 只认 SMLib 原生格式（源码里的 `OCCT_BREP_IMPORT/EXPORT` 未在 wheel 中暴露） |
| SMLib USD B-rep 导出 → 导入 | ✅ 完全精确：体积 717,256.62 往返一致；USDA 结构与 `omniSolid` schema 逐字段对应（`brep:extent` / `face:surfaceType` / `edge:curveType` / `vertexPoint` 等） |

## 六、对"AI 建模是否提升"的判定

| 假设 | 实测结论 |
|---|---|
| SMLib 布尔更鲁棒 → 减少 AI 建模失败 | ❌ 无证据（同几何对比全部平手） |
| SMLib healing 能自动修 AI 破损模型 | ⚠️ 仅限容差级缺陷（≤5mm 级扰动）；对非流形拓扑、重大几何错误无效；AI 用 OCC 的正常布尔输出本身已是流形，无缺陷可修 |
| SMLib 提供更可靠的几何自检 | ⚠️ 能力齐全但默认精度问题；OCC 侧已有等价查询且精确 |
| SMLib 能读 STEP/IGES/JT 做高保真转换 | ❌ wheel 未暴露（需 C++ 层自行编译） |
| SMLib 的 omniSolid 结构 → USD 互通 | ✅ 唯一确定成立的价值（且不需要服务端：我们可自行按字段实现导出） |

## 七、结论与建议

1. **A 组目标（提升 AI 建模成品率）不成立**：SMLib 的布尔/查询与 OCC 等效，healing 只覆盖容差级缺陷，
   而 AI 建模的失败模式（漏件、规格执行偏差、布尔选择错误）不在其能力射程内。
2. **不建议**为 A 组做服务端集成（成本：chroot/运行时 ~400MB、运维、破坏纯前端）。
3. **建议保留的两条**：
   - **USD B-rep 互通**（C 路径）：按 `omniSolid` 字段自行实现导出（前端可做，零依赖）——这是唯一高性价比价值；
   - **离线交叉校验**：SMLib 可作为独立 oracle 校验 OCC 输出（本轮已验证其体积/拓扑查询可信），
     仅用于开发期回归，不进生产链路。
4. 若要 STEP/IGES/JT 高保真转换，需要 C++ 层自编（`source/OCCT_BREP_IMPORT`），成本远超收益，**暂缓**。

## 八、环境清理说明

测试套件位于服务器 `/opt/brep-exp/`（rootfs + python + wheel ≈ 400MB，磁盘余量 27G 不受影响），
保留以便后续需要时复跑；如需清理：`rm -rf /opt/brep-exp`。
