# usd-brep 二次全面研究：还能利用什么（2026-10-21 第三轮，严谨复核）

> 前提：A 组服务端实测已证明"布尔/修复/查询"对 AI 建模无增益（见 `usd-brep-agroup-results.md`）。
> 本轮目标：在排除了运行时能力后，逐项核查仓库中**还有没有值得利用的东西**，并给出可执行判断。

## 一、逐项核查清单（含证据与结论）

| # | 对象 | 证据 | 对我们可用？ | 结论 |
|---|---|---|---|---|
| 1 | `SMLib` C++ 内核（32.5MB/224 文件，Apache-2.0） | 无 WASM 产物；链接 TBB；A 组实测与 OCC 等效 | ❌ 不建议 | 移植周级成本，收益已实测为零 |
| 2 | Python wheel（86MB） | 需 CPython 3.12 + manylinux_2_34；服务器 glibc 2.32 | ⚠️ 仅 chroot 可用 | 生产不引入；已清理 |
| 3 | `omniSolid` schema + 导出样例 USDA | 已实测导出结构；逐字段对应 schema | ✅ **可用（唯一确定价值）** | 作为自研 USD B-rep 导出器的字段蓝图 |
| 4 | AOUSD `UsdSolid` 提案（Draft） | README 931 行；明确 **2D 制图/标注/装配不在范围** | ⚠️ 部分 | 只覆盖我们 3D 实体部分，2D 图纸无标准可依 |
| 5 | `KNOWN_ISSUES.md` | 官方自述：healing 假成功、默认精度面积/体积误差达 1.4%、样条细分法线反向 | ✅ 可用（知识） | 印证我们实测；作为自研导出/校验的设计注意项 |
| 6 | `tools/occt_to_usd` + `source/OCCT_BREP_IMPORT/EXPORT` | 处理的是 **OCCT .brep 文件格式**（非 STEP/IGES），自解析不链 OCCT | ⚠️ 参考 | 映射思路可借鉴；.brep 需另找输出路径 |
| 7 | `tools/brep_geometry_validator` | 导入 BrepArray → `SmBrep::AssertValid` | ⚠️ 思路 | "内核级有效性断言"思路可借鉴，但见第 9 条 |
| 8 | `TestFiles`（occt_breps / usd_TestFiles） | LFS 夹具 | ✅ 潜在 | 未来做 USD 读取时的测试样本（Apache-2.0） |
| 9 | 自研侧实测：我们内核的 `BRepCheck_Analyzer` / `ShapeFix_*` | 绑定存在且可调用（`new BRepCheck_Analyzer(shape,false)`） | ⚠️ 价值有限 | **实测对 1e-6 薄板、压扁球、空体均判 valid** → 抓不到 AI 典型退化 |
| 10 | `HYDRA_USD_BREP`（Hydra 渲染委托） | 离线渲染管线 | ❌ | 浏览器不适用 |
| 11 | `tools/agent` / `packman` / `repoman` / `smtess_usd` | 开发基建 | ❌ | 与我们无关 |
| 12 | 网格细分参数（弦高/角度/边长/长宽比） | AGENTS.md 记录 | ✅ 小 | 可借鉴到我们的 OCC 剖分参数，提升截图/导出质量 |

## 二、唯一值得做的事（如果要做）

**按 `omniSolid` 字段自研 USD B-rep 导出器**（浏览器内、零新依赖）：
- 输入：我们 OCC-WASM 的模型；输出：USDZ（含标准网格 + `BrepArray` 语义数据，参照 `docs/samples/*.usda`）
- 价值：Omniverse / AR / 下游 CAD 可直接消费；**不提升 AI 建模质量**
- 风险：opencascade.js 的 `GeomAbs_*` 枚举与 `TopoDS_*` 类型转换未见显式绑定，
  需先做 0.5 天探针（能否枚举 FACE/EDGE/VERTEX 并取得面类型）；做不到就降级为"网格 + 元数据"

## 三、明确不建议做的事

1. 服务端集成 SMLib（chroot/运行时/运维，收益已实测为零）
2. WASM 移植 SMLib（周级工程，与 OCC 能力重复）
3. 期待"换内核提升 AI 建模"——A 组证据否定了这条路径
4. 为 2D 制图找 USD 标准——提案明确把制图排除在外

## 四、对"AI 建模提升"的最终判断（与 A 组一致）

CAD 内核（无论 OCC 还是 SMLib）提供的是**几何执行能力**，不是**生成智能**。
AI 建模的真正杠杆仍是：特征级工具面、几何自检与修复闭环、知识注入、评测纪律。
本轮唯一从该项目学到并可直接落地的是：**有效性检测不足这一事实**（BRepCheck 抓不到退化），
这提示我们应改用**几何度量类自检**（体积/壁厚/包围盒/面数一致性）而非拓扑有效性断言。

## 五、清理记录

- 服务器 `/opt/brep-exp`（741MB）已删除并卸载挂载点，磁盘回落至 29%
- 本地临时包（rootfs / CPython / wheel）已清理
- 保留：`docs/samples/omnisolid-breparray-sample.usda`、`omnisolid-cylinder-cut-sample.usda`（自研导出参考）
