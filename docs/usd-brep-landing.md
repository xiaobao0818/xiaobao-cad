# usd-brep 落地小宝CAD 方案（2026-10-21）

对象：<https://github.com/NVIDIA-Omniverse/usd-brep>（Apache-2.0，1758★，2026-10-08 创建）

## 一、这个项目到底是什么（事实核对）

| 维度 | 事实 |
|---|---|
| 定位 | "standalone C++ and Python library for NURBS-based BRep solid modeling" |
| 组成 | `smlib` C++ 内核（primitives/curves/surfaces/booleans/sweeps/fillets/offset/stitching）+ `usd_brep` Python 绑定（pybind11，模块名 `_omni_solid`） |
| 安装 | `pip install usd-brep`，**仅 CPython 3.12**，Windows/Linux x86_64/aarch64 wheel，自带 OpenUSD |
| USD 侧 | 运行时 schema `omniSolid`（`BrepArray` + 13 个 API schema）；另 vendored 两份 AOUSD 提案快照 `UsdSolid` / `cad_geometry`（Draft，PR #109/#108） |
| 依赖 | 构建走 Packman（OpenUSD 3.12、Python、pybind11、premake）；Tier 0 仅内核，Tier 1 才接 OpenUSD + OCCT |
| 浏览器 | **无任何 JS/WASM 产物，无 macOS wheel** |
| 贡献 | 当前不接受外部贡献（Apache-2.0 可自由使用/分发） |

**结论**：它是**桌面/服务端的建模内核 + USD B-rep 模式实现**，不是前端库。对纯前端的我们，直接"调用"不可行。

## 二、我们项目的现状（可作为基座）

- 3D：`js/three-dim/occ-kernel.js`（opencascade.js 1.1.1 WASM，真 B-rep：布尔/圆角/体积/STEP/STL）
- 视图：`js/three-dim/{app3d,model3d,viewport3d}.js`（three.js 0.185.1）
- **已有资产**：three 0.185.1 自带 `USDZExporter`、`USDZLoader`、`USDLoader`（`node_modules/three/examples/jsm/{exporters,loaders}/`）
- 现有导出：STEP / STL（3D）、DXF / DWG（2D）；**无 USD**
- 服务器：Alibaba Cloud Linux 3 x86_64，**Python 3.6.8**（装 usd-brep 需升级到 3.12）

### 实证探针（本次实跑，Node + 我们的 three）

```
USDZ 大小: 4216 bytes | ZIP 魔数 ✅ | 条目: model.usda + geometries/Geometry_2.usda
metersPerUnit = 1, upAxis = "Y"
```
**发现关键单位陷阱**：three 的 USDZExporter 硬编码 `metersPerUnit = 1`，我们模型单位是 **mm** →
100 mm 的泵壳会导出成 **100 米**。必须处理（方案见 T1），否则下游（Omniverse/AR）尺寸全错。

## 三、能利用的四条路径（可行性矩阵）

| 路径 | 内容 | 价值 | 成本 | 风险 | 依赖 |
|---|---|---|---|---|---|
| **T1 浏览器 USDZ 导出/导入** | three `USDZExporter` 导出 + `USDZLoader` 导入参考模型 | ★★★★★ 立即打通 Omniverse/AR/QuickLook 生态 | 0.5~1 天 | 低（已实证） | 无 |
| **T2 B-rep 语义注释** | 把 OCC 拓扑按 `omniSolid` 字段写成 USD 自定义属性 | ★★★★☆ 网格"带 B-rep 语义"，可校验/可重建 | 2~3 天 | 中（OCC 绑定覆盖度） | 无 |
| **T3 真 NURBS B-rep 写出** | `BrepSurfaceNurbAPI`/`BrepCurve3dNurbAPI` 字段级实现 | ★★★☆☆ 唯一"真 B-rep in USD"路径 | 1~2 周 | 高（NURBS 绑定 + trim/UV 曲线） | 绑定探针 |
| **T4 服务端转换/修复** | 服务器装 Python 3.12 + `pip install usd-brep`，STEP/IGES/JT→USD B-rep + `heal_file` | ★★★☆☆ 补浏览器做不了的高保真转换 | 2~5 天 | 中（破坏纯前端、运维） | Python 3.12 |

**不做的**：把 usd-brep 编译成 WASM（OpenUSD+pybind11+Packman，工程量远超收益；我们的 OCC-WASM 已承担 B-rep 计算）。

## 四、落地设计（按推荐顺序）

### T1 浏览器内 USDZ 导出/导入（先做）

**改动点**
- 新增 `js/three-dim/usdz-export.js`：fork three 的 `USDZExporter`（约 300 行，Apache-2.0/MIT 兼容），
  修正两处必需参数：
  - `metersPerUnit`：提供 `unit` 选项（`mm` → `0.001`，`cm` → `0.01`，`m` → `1`），默认按项目场景 mm；
  - `upAxis`：默认 `"Z"`（CAD 习惯），提供 `"Y"` 选项（Omniverse 偏好），与用户/下游对齐。
- `js/three-dim/app3d.js`：3D 工具栏/导出菜单新增"导出 USDZ"；`js/three-dim/model3d.js` 提供
  `toThreeScene()`（若已有等价物则复用：把可见实体转成 three 网格，三角化用现有 `kernel.mesh`）。
- 导入：新增 `js/three-dim/usd-import.js` 封装 `USDZLoader`（+ `USDLoader` 支持 USDA/USDC），
  作为"参考模型"加入场景（半透明 + 可对齐，复用现有 DWG/DXF 参考导入交互）。
- AI 工具：`js/three-dim/app3d.js` 的 AI 工具注册新增 `export_usd`（参数：`format: 'usdz'`、`unit`、`upAxis`），
  让"帮我导出一份给 Omniverse 的 USD" 可直接完成。

**验收标准（可测量）**
1. 导出 100×60×40 的盒体 → `unzip -l` 可见 `.usda`；`metersPerUnit = 0.001`、坐标按 1/1000 缩放；
2. `USDZLoader` 回读 → 三角面数与源一致，bbox 换算后误差 ≤0.5%；
3. 真实泵装配（含布尔级联）导出成功，体积/bbox 与 `kernel` 计算值一致（±1%）；
4. macOS QuickLook / Omniverse 打开正常（人工抽检）。

### T2 B-rep 语义注释（第二批）

- 新增 `js/three-dim/brep-export.js`：`OCC 拓扑 → 结构体`，字段严格对齐 `omniSolid`：
  `brep:extent`(Bnd_Box)、`brep:regionCount`、`shell:faceuseCount`、`face:surfaceType`
  （BRepAdaptor_Surface 判型：plane/cylinder/cone/sphere/torus/nurb）、`face:range`(UV)、
  `face:loopCount`、`edge:curveType`(line/circle/ellipse/nurb)、`edge:range`、`vertex:pointType`、
  容差与质量属性（`BRepGProp` 体积/质心）。
- 写出方式：在 T1 的 USDZ 导出器中给 Mesh prim 附 `customData` 字典（`xb:brep`），键名与
  `omniSolid` 一一对应；不做 schema 注册（我们不是 USD 运行时，只做互操作约定）。
- 验收：解包 USDA 断言字段存在且数值等于 OCC 直算值（bbox/面数/体积），差 ≤1%。

### T3 真 NURBS B-rep（先做绑定探针，再决定）

**第一步（0.5 天，关键）**：在浏览器控制台验证 opencascade.js 1.1.1 是否可读
`Geom_BSplineSurface` 的 `UDegree/VDegree/NbUPoles/NbVPoles/Weights/Knots`（`Supported APIs.md` 有 5 处引用，
但需实测可用性）。可用 → 继续；不可用 → T3 降级为"解析面 + 网格"，放弃 NURBS。

**第二步**：按 `BrepSurfaceNurbAPI`（controlVertices/uVertexCount/vVertexCount/uOrder/vOrder/uKnots/vKnots/weights）
与 `BrepCurve3dNurbAPI` 写出；只写 USDA（USDC 二进制 writer 不做）。
风险：trim loop（`BrepCurveUvNurbAPI`）与 face UV 范围是主要难点，建议先只写"未裁剪面"并在文档标注限制。

### T4 服务端（可选，非默认路径）

- 服务器装 CPython 3.12（现 3.6.8）→ `pip install usd-brep`；
- 提供离线转换：`STEP/IGES/JT → USDZ（真 B-rep）` + `usd_brep.usd.heal_file` 修复；
- 定位：**可选后端/内部工具**，前端不默认依赖（保持"打开即用、无需后端"的产品承诺）。

### T5 生态跟踪

- AOUSD `UsdSolid` 提案（Draft，2026-05 提交）一旦定稿，我们的字段映射可平滑迁移；
  现在按 `omniSolid` 语义实现 = 提前对齐事实标准。

## 五、排期与验收（与项目现有纪律一致）

| 阶段 | 内容 | 工期 | 验收 |
|---|---|---|---|
| T1 | USDZ 导出/导入 + 单位/upAxis + AI 工具 | 0.5~1 天 | 4 条验收 + npm test 绿 |
| T2 | B-rep 语义注释（字段对齐 omniSolid） | 2~3 天 | 字段一致性 ≤1% |
| T3 | 绑定探针 → NURBS 写出（可选） | 0.5 天 + 1~2 周 | 控制点/节点 round-trip |
| T4 | 服务端 Python 3.12 + usd-brep 转换 | 2~5 天 | STEP→USDZ 体积误差 ≤0.5% |

## 六、风险与边界

1. **单位/朝向**是最大坑（实测已确认 `metersPerUnit=1`）——必须显式提供选项并在 UI 标注；
2. **USDC 二进制**不可写（只 USDA 文本）；需要 USDC 时走 T4；
3. **schema 许可**：`omniSolid` schema 与 AOUSD 提案分别在 NVIDIA 仓库与 OpenUSD-proposals 下，
   我们只**按字段名实现互操作**，不复制 `schema.usda` 进仓库（如需 vendored，必须保留 NOTICE）；
4. **不做 WASM 移植**（成本/收益不成立）；
5. T3 的 NURBS 绑定存在不确定性，先探针后投入。
