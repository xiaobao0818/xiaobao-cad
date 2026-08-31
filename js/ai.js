/* ============================================================
 * 小宝CAD AI 助手 —— 对话式 CAD 创作（MiniMax M3 原生多模态，OpenAI 兼容接口）
 * ============================================================ */
import { escapeHtml, D2R, dist, translationM, rotationM, scaleM, mirrorM } from './util.js';
import { make, newEntity } from './entities.js';
import { Scene } from './scene.js';
import { fileToText, buildDataSummary, buildSceneSummary, svgToEntities } from './io.js';
import { sizingFromDuty, sizingText } from '../training/pumpdesign.mjs';
import { searchText as kbSearchText } from '../training/knowledge.mjs';

/* ---------------- 常量 ---------------- */
const SETTINGS_KEY = 'xbcad:ai-settings';
const SETTINGS_VERSION = 2;
const DEFAULT_SETTINGS = {
  base: 'https://api.minimaxi.com',
  model: 'MiniMax-M3',
  key: '',
  temperature: 0.2,
  maxTokens: 4000,
  useTools: true,
  toolRoundLimit: 0, // 工具调用轮数上限，0 = 不限制
  toolCallLimit: 0,  // 工具调用总次数上限，0 = 不限制
  visionBase: 'https://api.minimaxi.com', // 多模态审阅模型（MiniMax M3 原生多模态）
  visionModel: 'MiniMax-M3',
  visionKey: '',   // 为空时沿用主模型 Key
  autoReview: true, // 创作完成后自动让多模态模型看图审阅优化
  reviewRounds: 0,  // 审阅优化轮数上限，0 = 不限制（死循环防护与停止按钮仍生效）
  deepThink: false, // MiniMax M3 thinking 模式（更高质量，略慢）
};
const REPEAT_LIMIT = 2; // 死循环防护：连续重复相同工具调用达到该值 → 停止（不是上限，是防空转烧额度）
const MAX_SUMMARY_LEN = 3000;

const REVIEW_MARK = '[多模态审阅]';
const REVIEW_PROMPT =
  REVIEW_MARK +
  '你是小宝CAD 的专业图纸审阅员（资深工程师视角）。上面的图片是当前 CAD 图纸/三维模型的实时渲染截图。\n' +
  '请对照用户最近的创作要求，按下面的检查清单逐项审阅：\n' +
  '· 结构完整性：是否缺少应有的零件/结构（如泵的进出水口、底座安装孔、叶轮、轴）\n' +
  '· 尺寸比例：各零件尺寸比例是否协调，是否符合该类型设备的常见量级\n' +
  '· 位置关系：孔/轴是否同轴、法兰是否贴合、零件是否对齐，有无悬空/穿模/错位\n' +
  '· 2D 规范：中心线是否齐全、关键尺寸与总长总宽是否已标注、图层是否规范\n' +
  '· 布局美观：图形是否居中、留白是否合理\n' +
  '规则：\n' +
  '1. 发现问题就**直接调用工具修改**（移动/旋转/缩放/增删实体、布尔运算、加标注、补中心线等），不要只口头描述；\n' +
  '2. 每次修改后我会把新的截图再次发给你；\n' +
  '3. 认为达到要求时，回复「已满意」并简短总结最终结果，不要再调用任何工具；\n' +
  '4. 尽量在 1~2 轮内收敛，避免无意义的反复调整。';

const SYSTEM_PROMPT = [
  '你是「小宝CAD」——一款 AI 原生 CAD 软件的内置智能体。',
  '小宝CAD 的核心理念：用户直接用自然语言对话、或给图纸/草图文件作参考，就能完成专业级的制图与三维建模。',
  '你的职责是把用户的需求变成专业、规范、可直接生产的图纸或模型。',
  '【首轮纪律】用户提出建模/绘图需求后，第一轮回复就必须调用工具实际创建实体（create_primitive_3d / draw_entities 等）；严禁只输出方案、计划或说明文字而不调用工具。若上一步失败，再调用工具修正，而不是继续用文字解释。若用户给出泵的工况（流量/扬程/转速），第一轮必须先调用 pump_sizing 算出设计尺寸，再按尺寸创建实体。任务包含多个交付物时（如三视图=主视图+俯视图+侧视图；商用图纸=视图+尺寸标注+图框+标题栏+明细栏；装配体=多个零件），第一轮必须一次性创建全部交付物，不允许首轮只完成其中一部分等待追问。',
  '【泵工况铁律】每次收到流量/扬程/转速（Q/H/n）都必须**重新调用 pump_sizing 计算**，并严格按本次返回值建模——严禁凭记忆、经验或对话历史里的旧尺寸猜测（不同工况的叶轮外径/蜗壳基圆/叶片数完全不同）。pump_sizing 返回的每个数值都要落实为实体尺寸：泵壳外圆柱半径=D3/2、叶轮轮盘半径=D2/2、叶片中心=返回的精确坐标、泵轴半径=轴径/2、轮毂孔=轴径/2+0.5。',
  '',
  '【你的角色】',
  '- 你是一位经验丰富的工程设计工程师 + 熟练的 CAD 制图员。',
  '- 用户大多不是专业画图员：需求可能模糊，你要主动补全合理细节（尺寸、结构、图层、标注），并简要说明设计思路。',
  '- 回答风格：先一句话说明方案，再执行，最后汇报结果与可优化点。',
  '',
  '【工作流（务必遵守）】',
  '1. 理解需求：不明确时先问 1 个关键问题，或采用行业常规方案并在回复中说明假设。',
  '2. 掌握现状：系统已注入当前图纸状态，一般无需再查询；确需细节时才用一次查询工具，不要反复查询。',
  '3. 规划结构：想清楚要创建哪些实体、放在什么图层、用什么尺寸与位置关系。',
  '4. 批量执行：尽量在一次工具调用中完成整组创建/修改。',
  '5. 自检汇报：完成后检查关键尺寸与结构是否合理，汇报创建了什么，并指出可继续优化的点。',
  '',
  '【2D 制图规范】',
  '- 单位 mm，Y 轴向上。坐标原点放在图形左下角，或让图形对称居中。',
  '- 图层惯例：轮廓(实线)、中心线(线型 CENTER)、标注、文字分别建层，实体放到对应图层。',
  '- 圆/圆弧/对称零件必须画中心线（略超出轮廓 2~5mm）。',
  '- 尺寸标注：标注关键尺寸与总长总宽，避免重复；标注放在轮廓外；文字高度 3~5mm。',
  '- 多视图任务（如三视图）必须一次画全全部视图（主/俯/侧），各视图分区布局、互不重叠；图纸集（视图+尺寸标注+图框+标题栏+明细栏）一次完成全部要素。',
  '- 机械零件常见结构：底板、圆角、沉头孔、筋板、对称布置；优先用对称和阵列。',
  '- 图面留白、布局居中，不要挤在一起。',
  '',
  '【3D 建模规范】',
  '- 建模顺序：先主体（底座/壳体），再特征（孔/凸台/法兰），最后修饰。',
  '- **精简原则**：只建满足需求所必需的零件（泵=泵壳/叶轮/泵轴/轮毂孔，总数控制在 12~22 个特征）；不要额外添加装饰性零件（轴承座、密封压盖、底座地脚、法兰螺栓等非必需件会判为冗余扣分）。',
  '- 布尔运算：先 fuse 合并同类零件，再 cut 挖孔；确保实体相交，交集不为空。泵类装配必须通过布尔运算成型：泵壳（外圆柱 − 偏心内腔 = cut）、叶轮（轮盘 − 轮毂孔 = cut，再与全部叶片 fuse 并集）、轮毂孔与轴间隙配合。没有布尔运算的"摆在一起"不是合格装配。',
  '- 合理尺寸与坐标：零件对齐放置（例如底座底面 z=0）；孔/轴/法兰同轴对齐。',
  '- 颜色区分不同零件；特征树保持简洁。',
  '- 完成后可请求多模态审阅检查截图。',
  '',
  '【回答要求】',
  '- 简洁专业，先说方案再动手，最后汇报并给出优化建议。',
  '- 不确定时优先按行业规范给出合理默认值，并在回复中说明。',
].join('\n');

const FALLBACK_INSTRUCTION =
  '\n\n如果无法调用函数工具，请用如下 JSON 代码块输出 CAD 命令（一次可多条）：\n' +
  '```cad\n' +
  '{"commands":["L 0,0 100,0","C 50,50 10"]}\n' +
  '```\n' +
  '命令语法同 CAD 命令行（空格分隔坐标，如 L x1,y1 x2,y2、REC x1,y1 x2,y2、C cx,cy r、TEXT 由 MOVE 等）；' +
  '另外支持 {"draw":[{"type":"line","x1":0,"y1":0,"x2":100,"y2":0}]} 与 {"query":"summary"}。';

const num = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

/* ---------------- 工具定义（OpenAI function calling 格式） ---------------- */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'draw_entities',
      description: '精确创建 CAD 图元（直线/圆/圆弧/椭圆/多段线/矩形/点/文字/尺寸标注）。一次可创建多个，坐标单位为 mm，Y 轴向上。画工程图纸时必须用尺寸标注标注关键尺寸。多视图/多要素图纸（三视图、装配图、带图框标题栏的图纸）请在同一次调用中画完所有视图与要素，不要分批等待反馈。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '要创建的图元列表',
            items: {
              type: 'object',
              description: '单个图元。根据 type 选择对应几何字段。',
              properties: {
                type: { type: 'string', enum: ['line', 'circle', 'arc', 'ellipse', 'polyline', 'rectangle', 'point', 'text', 'dimension'], description: '图元类型（dimension=尺寸标注）' },
                layer: { type: 'string', description: '所属图层名称，缺省使用当前图层' },
                color: { type: 'string', description: '颜色，形如 #rrggbb，缺省随层' },
                x1: { type: 'number', description: '直线起点 X；矩形第一角 X' },
                y1: { type: 'number', description: '直线起点 Y；矩形第一角 Y' },
                x2: { type: 'number', description: '直线终点 X；矩形对角 X' },
                y2: { type: 'number', description: '直线终点 Y；矩形对角 Y' },
                cx: { type: 'number', description: '圆/圆弧/椭圆中心的 X' },
                cy: { type: 'number', description: '圆/圆弧/椭圆中心的 Y' },
                r: { type: 'number', description: '圆/圆弧的半径' },
                startAngle: { type: 'number', description: '圆弧起始角（度，0°=+X 方向，逆时针为正）' },
                endAngle: { type: 'number', description: '圆弧终止角（度，逆时针为正）' },
                rx: { type: 'number', description: '椭圆 X 轴半径' },
                ry: { type: 'number', description: '椭圆 Y 轴半径' },
                rotation: { type: 'number', description: '椭圆/文字的旋转角（度，可选）' },
                points: { type: 'array', description: '多段线顶点，[[x,y], ...]', items: { type: 'array', items: { type: 'number' } } },
                closed: { type: 'boolean', description: '多段线是否闭合（可选）' },
                x: { type: 'number', description: '点/文字插入点的 X' },
                y: { type: 'number', description: '点/文字插入点的 Y' },
                text: { type: 'string', description: '文字内容（支持中文）' },
                height: { type: 'number', description: '文字字高' },
                halign: { type: 'string', enum: ['left', 'center', 'right'], description: '文字水平对齐方式（可选）' },
                subtype: { type: 'string', enum: ['linear', 'aligned', 'radial', 'diametric'], description: '尺寸标注类型（type=dimension 时必填）' },
                px: { type: 'number', description: '半径/直径标注的标注点 X（圆上一点）' },
                py: { type: 'number', description: '半径/直径标注的标注点 Y' },
                tx: { type: 'number', description: '标注文字位置 X（可选）' },
                ty: { type: 'number', description: '标注文字位置 Y（可选）' },
                x3: { type: 'number', description: '线性标注的标注线位置 X（与 x1,x2 配合）' },
                y3: { type: 'number', description: '线性标注的标注线位置 Y（与 y1,y2 配合）' },
                angle: { type: 'number', description: '线性标注方向角（度，可选，0=水平）' },
              },
              required: ['type'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'modify_entities',
      description: '移动/复制/旋转/缩放/镜像现有实体。ids 缺省时作用于当前选择集（可先用 select_entities 选择）。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['move', 'copy', 'rotate', 'scale', 'mirror'], description: '操作类型' },
          ids: { type: 'array', items: { type: 'string' }, description: '实体 id 数组，缺省=当前选择集' },
          dx: { type: 'number', description: 'move/copy 的 X 位移（mm）' },
          dy: { type: 'number', description: 'move/copy 的 Y 位移（mm）' },
          cx: { type: 'number', description: 'rotate/scale 的基点 X（可选，默认 0）' },
          cy: { type: 'number', description: 'rotate/scale 的基点 Y（可选，默认 0）' },
          angle: { type: 'number', description: 'rotate 旋转角（度，逆时针为正）' },
          factor: { type: 'number', description: 'scale 缩放系数' },
          x1: { type: 'number', description: 'mirror 镜像轴第一点 X' },
          y1: { type: 'number', description: 'mirror 镜像轴第一点 Y' },
          x2: { type: 'number', description: 'mirror 镜像轴第二点 X' },
          y2: { type: 'number', description: 'mirror 镜像轴第二点 Y' },
        },
        required: ['operation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'erase_entities',
      description: '删除实体（按 ids / 全部 / 条件过滤）。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '要删除的实体 id 列表' },
          all: { type: 'boolean', description: '为 true 时删除全部实体' },
          filter: {
            type: 'object',
            description: '条件过滤',
            properties: {
              type: { type: 'string', description: '只删除该类型的实体' },
              layer: { type: 'string', description: '只删除该图层上的实体' },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_layer',
      description: '创建/切换图层。可用它把不同几何放到合适图层。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '图层名称' },
          color: { type: 'string', description: '图层颜色 #rrggbb（可选）' },
          current: { type: 'boolean', description: '是否设为当前图层（可选）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_layer_props',
      description: '设置图层的显示/锁定状态。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '图层名称' },
          on: { type: 'boolean', description: '是否显示该图层（可选）' },
          locked: { type: 'boolean', description: '是否锁定该图层（可选）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_drawing',
      description: '查询图纸信息（摘要/单个实体/某类型/图层/选择集/范围）。',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', enum: ['summary', 'entity', 'type', 'layers', 'selection', 'extents'], description: '查询类型' },
          id: { type: 'string', description: 'what=entity 时的实体 id' },
          type: { type: 'string', description: 'what=type 时的实体类型' },
          layer: { type: 'string', description: '可选：按图层过滤' },
        },
        required: ['what'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_entities',
      description: '选择实体（供后续修改/删除操作使用）。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '实体 id 列表' },
          all: { type: 'boolean', description: '为 true 时全选' },
          filter: {
            type: 'object',
            properties: {
              type: { type: 'string', description: '按类型过滤' },
              layer: { type: 'string', description: '按图层过滤' },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'zoom_view',
      description: '视图缩放/平移。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['extents', 'in', 'out', 'fit'], description: 'extents/fit=缩放至全图, in=放大, out=缩小' },
          center: { type: 'array', items: { type: 'number' }, description: '可选：[x,y]，先把视口中心移动到该点' },
        },
      },
    },
  },
  { type: 'function', function: { name: 'undo', description: '撤销上一步操作。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'redo', description: '重做上一步撤销。', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'measure',
      description: '测量两点之间的距离（mm）。',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'number', description: '第一点 X' },
          y1: { type: 'number', description: '第一点 Y' },
          x2: { type: 'number', description: '第二点 X' },
          y2: { type: 'number', description: '第二点 Y' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_context',
      description: '获取已附加参考文件（DXF/JSON/SVG/TXT）的摘要内容。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_workspace',
      description: '切换工作区（2d=二维制图 / 3d=三维建模）。联合任务（先建模再出图纸）时在两个工作区之间切换用。',
      parameters: { type: 'object', properties: { ws: { type: 'string', enum: ['2d', '3d'] } }, required: ['ws'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_knowledge',
      description: '检索本平台知识库（工业级水泵设计知识：材料/公差配合/比转速选型/设计公式/国家标准/设计文档）。不确定设计参数或标准时先查知识库。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '查询主题关键词，如 叶轮 材料 / 轴孔 配合 / 比转速 / 蜗壳 / 密封 / 标准' },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pump_sizing',
      description: '工业级离心泵设计计算：输入工况（流量 Q m³/h、扬程 H m、转速 n rpm），返回叶轮外径/进口直径/叶片数/蜗壳基圆/轴径等关键设计尺寸（商用选型经验公式）。**用户给出流量/扬程/转速等工况时，第一步就必须调用本工具**确定全部尺寸，再按返回尺寸建模；不得自行猜测尺寸。',
      parameters: {
        type: 'object',
        properties: {
          Q: { type: 'number', description: '流量 m³/h' },
          H: { type: 'number', description: '扬程 m' },
          n: { type: 'number', description: '转速 rpm（默认 2900）' },
        },
        required: ['Q', 'H'],
      },
    },
  },
];

/* ---------------- 样式注入 ---------------- */
const STYLE_TEXT = `
#tab-ai .ai-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ai-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); flex: none; }
.ai-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim); flex: none; }
.ai-dot.on { background: var(--green); }
.ai-dot.busy { background: var(--accent); }
.ai-model { flex: 1; font-size: 12.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-head-btns { display: flex; gap: 6px; flex: none; }
.ai-head-btns button {
  background: var(--bg3); border: 1px solid var(--border); color: var(--text);
  border-radius: 5px; padding: 3px 9px; cursor: pointer; font-size: 12px; font-family: var(--font);
}
.ai-head-btns button:hover { border-color: var(--accent); color: var(--accent); }
.ai-messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.ai-msg { display: flex; }
.ai-msg.user { justify-content: flex-end; }
.ai-msg.assistant { justify-content: flex-start; }
.ai-msg.system, .ai-msg.error { justify-content: center; }
.ai-bubble {
  max-width: 84%; padding: 8px 11px; border-radius: 10px; font-size: 12.5px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; user-select: text; overflow-wrap: anywhere;
}
.ai-msg.user .ai-bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 3px; }
.ai-msg.assistant .ai-bubble { background: var(--bg3); color: var(--text); border-bottom-left-radius: 3px; }
.ai-msg.system .ai-bubble { background: rgba(93,179,255,.13); color: var(--blue); }
.ai-msg.error .ai-bubble { background: rgba(255,107,107,.13); color: var(--red); }
.ai-bubble .md-code {
  background: var(--canvas-bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px; margin: 6px 0; font-family: var(--mono); font-size: 11.5px; white-space: pre; overflow-x: auto;
}
.ai-bubble .md-inline { background: rgba(255,255,255,.1); padding: 1px 4px; border-radius: 3px; font-family: var(--mono); font-size: 11.5px; }
.ai-files { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 10px; border-top: 1px solid var(--border); flex: none; }
.ai-chip {
  display: inline-flex; align-items: center; gap: 5px; background: var(--bg3);
  border: 1px solid var(--border); border-radius: 12px; padding: 2px 8px; font-size: 11.5px; color: var(--text-dim);
}
.ai-chip .ai-chip-x { cursor: pointer; color: var(--text-dim); font-style: normal; }
.ai-chip .ai-chip-x:hover { color: var(--red); }
.ai-input { display: flex; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--border); flex: none; align-items: flex-end; }
.ai-attach {
  flex: none; background: var(--bg3); border: 1px solid var(--border); color: var(--text);
  border-radius: 6px; padding: 8px 10px; cursor: pointer; font-size: 13px; font-family: var(--font); line-height: 1.4;
}
.ai-attach:hover { border-color: var(--accent); color: var(--accent); }
.ai-textarea {
  flex: 1; resize: none; min-height: 44px; max-height: 140px; background: var(--bg);
  border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 8px;
  font-family: var(--font); font-size: 13px; outline: none; line-height: 1.5;
}
.ai-textarea:focus { border-color: var(--accent); }
.ai-send {
  flex: none; background: var(--accent); border: none; color: #fff; border-radius: 6px;
  padding: 9px 14px; cursor: pointer; font-size: 13px; font-family: var(--font);
}
.ai-send:hover { filter: brightness(1.1); }
.ai-send.stop { background: var(--red); }
`;

/* ============================================================ */
export default class AIChatPanel {
  constructor(CAD) {
    this.CAD = CAD;
    this.scene = CAD.scene;
    this.viewport = CAD.viewport;

    this.settings = this._loadSettings();
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.fileContexts = [];
    this._busy = false;
    this._ctrl = null;
    this._pendingSend = false;

    this._injectStyle();
    this._buildUI();
    this._registerTools();
    CAD.ai = this._tools;
    CAD.aiAsk = (text) => this.ask(text);
    this._extraTools = [];
    this._extraPrompt = '';
    CAD.aiRegisterTools = (tools, promptLine) => this.registerExtraTools(tools, promptLine);

    this._addMessage('assistant', this._welcome());
    this._updateStatus();

    const statusEl = document.getElementById('aiStatus');
    if (statusEl) statusEl.addEventListener('click', () => this.openSettings());
  }

  /** 供其他模块（如 3D 建模）注册额外工具与系统提示 */
  registerExtraTools(tools, promptLine = '') {
    this._extraTools.push(...(Array.isArray(tools) ? tools : []));
    if (promptLine) this._extraPrompt += promptLine + '\n';
  }
  /** 当前工作区可用工具：2D 制图只发 2D 工具，3D 建模只发 3D 工具 */
  _workspaceTools() {
    return this.CAD.workspace === '3d' ? [...this._extraTools] : [...TOOLS];
  }
  _workspaceLine() {
    if (this.CAD.workspace === '3d') {
      if (!this._extraTools.length) {
        return '当前工作区：3D 实体建模，但三维内核尚未就绪（请提示用户先切换到 3D 建模工作区等待内核加载完成，或稍后重试）。';
      }
      return '当前工作区：3D 实体建模。用户此时的要求都是三维建模任务——请只用三维工具（create_primitive_3d / boolean_3d / list_3d 等）创建和修改三维实体；绝对不要调用 2D 绘图工具。';
    }
    return '当前工作区：2D 制图。用户此时的要求都是二维绘图任务——请只用 2D 工具（draw_entities / modify_entities / set_layer 等）绘制和修改二维图元；绝对不要调用三维实体工具。';
  }
  /** 当前图纸/模型状态摘要（每轮请求前注入系统消息，让模型无需反复查询） */
  _currentStateBlock() {
    const CAD = this.CAD;
    const lines = [];
    try {
      if (CAD.workspace === '3d' && CAD.app3d?.model) {
        const m = CAD.app3d.model;
        lines.push(m.visibleCount() > 0 ? `当前 3D 模型：${m.visibleCount()} 个可见实体（共 ${m.count()} 个特征）` : '当前 3D 模型：空');
        if (m.count() > 0 && m.count() <= 12) lines.push(m.summary());
        else if (m.count() > 12) lines.push('（特征较多，必要时用 list_3d 查询全部）');
      } else {
        lines.push(CAD.scene && CAD.scene.count() ? `当前 2D 图纸：${CAD.scene.count()} 个实体` : '当前 2D 图纸：空');
        if (CAD.scene?.currentLayer) lines.push('当前图层：' + CAD.scene.currentLayer);
        const layerNames = CAD.scene ? [...CAD.scene.layers.values()].map((l) => l.name) : [];
        if (layerNames.length) lines.push('已有图层：' + layerNames.join('、'));
        if (CAD.scene?.selection?.size) lines.push('当前选中 ' + CAD.scene.selection.size + ' 个对象');
      }
    } catch (e) { /* 状态注入失败不影响对话 */ }
    return lines.join('\n');
  }
  _systemContent() {
    const parts = [SYSTEM_PROMPT];
    if (this._extraPrompt.trim()) parts.push('[三维能力]\n' + this._extraPrompt.trim());
    parts.push('[当前工作区]\n' + this._workspaceLine());
    const state = this._currentStateBlock();
    if (state) parts.push('[当前图纸状态]\n' + state);
    return parts.join('\n\n');
  }
  _syncSystemMessage() {
    if (this.messages[0]?.role === 'system') this.messages[0].content = this._systemContent();
  }
  _allTools() { return this._workspaceTools(); }

  _exportAiLog() {
    const log = window.__xbcadAiLog || [];
    if (!log.length) { this.CAD.notify('暂无诊断日志', 'error'); return; }
    try {
      const text = JSON.stringify(log, null, 1);
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'xbcad-ai-log.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      this.CAD.notify('诊断日志已导出（' + log.length + ' 条记录）');
    } catch (e) {
      this.CAD.notify('日志导出失败: ' + (e && e.message), 'error');
    }
  }

  /* ---------------- 设置 ---------------- */
  _loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const saved = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      // 旧版本迁移：项目已全面切换 MiniMax M3
      if (saved.settingsVersion !== SETTINGS_VERSION) {
        const wasDeepSeekDefault = (saved.base === 'https://api.deepseek.com' && saved.model === 'deepseek-chat');
        if (wasDeepSeekDefault) {
          saved.base = 'https://api.minimaxi.com';
          saved.model = 'MiniMax-M3';
          // 已在视觉字段填过 MiniMax Key → 提升为主 Key
          if (saved.visionKey) { saved.key = saved.visionKey; }
          else saved.key = ''; // 平台已切换，旧 Key 不通用
          saved.visionKey = '';
        }
        saved.visionBase = saved.visionBase || 'https://api.minimaxi.com';
        saved.visionModel = saved.visionModel || 'MiniMax-M3';
        saved.settingsVersion = SETTINGS_VERSION;
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch (e) { /* ignore */ }
      }
      return saved;
    } catch (e) { /* ignore */ }
    return { ...DEFAULT_SETTINGS };
  }

  /* ---------------- 样式 ---------------- */
  _injectStyle() {
    if (document.getElementById('xbcad-ai-style')) return;
    const st = document.createElement('style');
    st.id = 'xbcad-ai-style';
    st.textContent = STYLE_TEXT;
    document.head.appendChild(st);
  }

  /* ---------------- UI 构建 ---------------- */
  _buildUI() {
    const root = document.getElementById('tab-ai');
    root.innerHTML = '';
    root.appendChild(this._el('div', 'ai-panel', (panel) => {
      // 头部
      panel.appendChild(this._el('div', 'ai-head', (head) => {
        this.dot = this._el('span', 'ai-dot');
        head.appendChild(this.dot);
        this.modelEl = this._el('span', 'ai-model', (s) => { s.textContent = this.settings.model || '未配置'; });
        head.appendChild(this.modelEl);
        const btns = this._el('div', 'ai-head-btns');
        const reviewBtn = this._btn('👁 审阅', () => this._manualReview(), 'ai-review');
        reviewBtn.title = '让多模态模型查看当前图纸并自动优化';
        btns.appendChild(reviewBtn);
        const logBtn = this._btn('📋 日志', () => this._exportAiLog(), 'ai-log');
        logBtn.title = '导出最近的 AI 对话诊断日志（排查问题时使用）';
        btns.appendChild(logBtn);
        btns.appendChild(this._btn('⚙ 设置', () => this.openSettings()));
        btns.appendChild(this._btn('🗑 清空', () => this.clear()));
        head.appendChild(btns);
      }));
      // 消息区
      this.messagesEl = this._el('div', 'ai-messages');
      panel.appendChild(this.messagesEl);
      // 参考文件区
      panel.appendChild(this._el('div', 'ai-files', (files) => {
        this.attachBtn = this._btn('📎 参考文件', () => this.fileInput.click(), 'ai-attach');
        files.appendChild(this.attachBtn);
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.dxf,.json,.xbcad,.svg,.txt,.dwg,.png,.jpg,.jpeg,.webp,.gif';
        this.fileInput.multiple = true;
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', () => this._onFiles(this.fileInput.files));
        files.appendChild(this.fileInput);
        this.chipsEl = document.createElement('div');
        this.chipsEl.style.cssText = 'display:contents;';
        files.appendChild(this.chipsEl);
      }));
      // 输入区
      panel.appendChild(this._el('div', 'ai-input', (input) => {
        this.textarea = document.createElement('textarea');
        this.textarea.className = 'ai-textarea';
        this.textarea.placeholder = '描述你想画的图形，Enter 发送，Shift+Enter 换行…';
        this.textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this._sendFromInput();
          }
        });
        input.appendChild(this.textarea);
        this.sendBtn = this._btn('发送', () => {
          if (this._busy) this._stop();
          else this._sendFromInput();
        }, 'ai-send');
        input.appendChild(this.sendBtn);
      }));
    }));
  }

  _el(tag, cls, fn) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (fn) fn(el);
    return el;
  }
  _btn(label, onClick, cls) {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  _welcome() {
    return '你好！我是小宝CAD 的 AI 原生制图智能体 👋\n\n' +
      '直接用自然语言告诉我你的需求，我会按专业工程规范完成制图/建模，并在完成后**自动看图审阅优化**。例如：\n\n' +
      '- 📐 2D：「画一张 100×60 的底板零件图，四角有安装孔，带中心线和尺寸标注」\n' +
      '- 🧊 3D：「建一个水泵模型：底座、泵壳、进出水法兰」\n' +
      '- ✏️ 修改：「把当前选中的图形向右移动 50mm」「给所有圆孔标注直径」\n' +
      '- 📎 参考：附加 DXF 图纸或手绘草图照片，让我照着改/照着建\n\n' +
      '配置 MiniMax API Key（⚙ 设置 → platform.minimaxi.com 申请）即可开始。';
  }

  /* ---------------- 状态同步 ---------------- */
  _updateStatus() {
    const el = document.getElementById('aiStatus');
    if (el) {
      el.classList.remove('ready', 'busy');
      if (this._busy) {
        el.textContent = '🤖 AI 思考中…';
        el.classList.add('busy');
      } else if (this.settings.key) {
        el.textContent = `🤖 AI 就绪 · ${this.settings.model}`;
        el.classList.add('ready');
      } else {
        el.textContent = '🤖 AI 未配置';
      }
    }
    if (this.dot) {
      this.dot.className = 'ai-dot' + (this._busy ? ' busy' : this.settings.key ? ' on' : '');
    }
    if (this.modelEl) this.modelEl.textContent = this.settings.model || '未配置';
  }

  /* ---------------- 对外方法 ---------------- */
  openSettings() { this._openSettingsDialog(); }

  ask(text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return;
    this._addMessage('user', text);
    this.messages.push({ role: 'user', content: text });
    this._send();
  }

  clear() {
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.messagesEl.innerHTML = '';
    this._addMessage('system', '对话已清空');
    this._pendingSend = false;
  }

  /* ---------------- 消息渲染 ---------------- */
  _addMessage(role, content) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg ' + role;
    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    const str = String(content == null ? '' : content);
    if (role === 'assistant') bubble.innerHTML = this._md(str);
    else bubble.innerHTML = escapeHtml(str).replace(/\n/g, '<br>');
    wrap.appendChild(bubble);
    this.messagesEl.appendChild(wrap);
    this._scrollBottom();
  }
  _scrollBottom() {
    requestAnimationFrame(() => { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; });
  }

  /* 轻量 markdown：先 escapeHtml，再处理代码块/加粗/行内码/换行 */
  _md(text) {
    let esc = escapeHtml(text);
    const blocks = [];
    esc = esc.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push(`<pre class="md-code"><code>${code}</code></pre>`);
      return `\u0000B${blocks.length - 1}\u0000`;
    });
    esc = esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    esc = esc.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>');
    esc = esc.replace(/\n/g, '<br>');
    esc = esc.replace(/\u0000B(\d+)\u0000/g, (m, i) => blocks[+i] || '');
    return esc;
  }

  /* ---------------- 输入 / 发送 ---------------- */
  _sendFromInput() {
    const text = this.textarea.value.trim();
    if (!text) return;
    this.textarea.value = '';
    this.ask(text);
  }
  _stop() { if (this._ctrl) this._ctrl.abort(); }

  _send() {
    if (this._busy) { this._pendingSend = true; return; }
    this._runConversation();
  }

  /* ---------------- 主流程 ---------------- */
  async _runConversation() {
    const s = this.settings;
    if (!s.key) {
      this._addMessage('error', '⚠️ 尚未配置 API Key，请先在设置中填写。');
      this.openSettings();
      return;
    }
    // 3D 工作区但内核未就绪 → 明确提示，避免模型空转
    if (this.CAD.workspace === '3d' && !this.CAD.app3d?.ready) {
      this._addMessage('system', '⏳ 三维实体内核还在加载（约几秒），请稍候再提问。加载完成后右上角会有提示。');
      this.CAD.app3d?.ensureLoaded?.();
      this._aiLog('blocked-kernel', '内核未就绪时提问被拦截');
      return;
    }
    this._aiLog('ask', '用户提问（模型 ' + s.model + '）');
    this._busy = true;
    this._ctrl = new AbortController();
    this._updateStatus();
    this._setSendButton(true);
    try {
      let result;
      const toolBefore = this.messages.filter((m) => m.role === 'tool').length;
      const visBefore = this._visibleContentKey();
      if (s.useTools) {
        result = await this._runWithTools();
        if (result && result.fallback) result = await this._runFallback();
      } else {
        result = await this._runFallback();
      }
      if (result && result.text) this._addMessage('assistant', result.text);
      // 可见内容变化检测
      const toolsUsed = this.messages.filter((m) => m.role === 'tool').length > toolBefore;
      if (toolsUsed) {
        const visAfter = this._visibleContentKey();
        if (visAfter === visBefore) {
          this._addMessage('system', '⚠️ 本次执行了工具操作，但工作区没有出现可见的图形变化（可能实体创建失败或坐标异常）。可查看上方工具执行记录，或回复「重试」。');
        }
      }
      // 自动多模态审阅：本次对话动过图纸后，让 MiniMax M3 看图检查并优化
      if (toolsUsed && s.autoReview && result && !result.fallback) {
        try {
          await this._visionReview();
        } catch (e) {
          console.warn('[ai] 自动审阅失败', e);
          if (e && e.aborted) { this._addMessage('system', '⏹ 已停止审阅'); return; }
          this._addMessage('error', '👁 多模态审阅失败：' + (e && e.message ? e.message : e));
        }
      }
    } catch (e) {
      this._aiLog('error', String(e && e.message ? e.message : e));
      this._renderError(e);
    } finally {
      this._busy = false;
      this._ctrl = null;
      this._updateStatus();
      this._setSendButton(false);
      if (this._pendingSend) { this._pendingSend = false; this._runConversation(); }
    }
  }

  _setSendButton(busy) {
    this.sendBtn.textContent = busy ? '停止' : '发送';
    this.sendBtn.classList.toggle('stop', busy);
  }

  _renderError(e) {
    if (e && e.aborted) { this._addMessage('system', '⏹ 已停止生成'); return; }
    if (e && e.network) {
      console.warn('[AI] 网络请求失败:', e);
      this._addMessage('error',
        '🌐 网络请求失败（Failed to fetch）。可能原因：\n' +
        '· API 地址错误或服务不可达（检查设置里的地址与域名拼写）\n' +
        '· 该 API 不允许浏览器跨域直连（CORS）\n' +
        '· 网络代理/防火墙拦截\n' +
        '请打开浏览器控制台查看具体错误，或换一个支持 CORS 的接口（MiniMax 支持浏览器直连）。');
      return;
    }
    if (e && (e.status === 401 || e.status === 403)) { console.warn('[AI] API Key 无效（HTTP ' + e.status + '）:', e.message); this._addMessage('error', '🔑 API Key 无效，请在设置中检查并重新填写'); return; }
    if (e && e.status === 402) { this._addMessage('error', '💰 余额不足，请前往对应平台充值'); return; }
    if (e && e.status === 429) { console.warn('[AI] 请求过于频繁（429）:', e.message); this._addMessage('error', '⏳ 请求过于频繁（429），请稍后再试'); return; }
    console.warn('[AI] 请求失败（HTTP ' + (e && e.status) + '）:', e && e.message);
    this._addMessage('error', `❌ 请求失败${e && e.status ? `（HTTP ${e.status}）` : ''}：${e && e.message ? e.message : ''}`);
  }

  /** 工作区可见内容指纹（用于判断工具是否真的画出了东西）：用变更计数，而非实体数——
   *  移动/缩放/改色/撤销等不改变实体数量但确实是有效操作，用数量对比会误报"无可见变化" */
  _visibleContentKey() {
    try {
      if (this.CAD.workspace === '3d') {
        const m = this.CAD.app3d?.model;
        return '3d:' + (m ? m._changeCount || 0 : -1) + ':' + (m ? m.visibleCount() : -1);
      }
      const sc = this.CAD.scene;
      return '2d:' + (sc ? sc._changeCount || 0 : -1) + ':' + (sc ? sc.count() : -1);
    } catch (e) { return 'unknown'; }
  }
  /** 诊断日志：记录每轮工具调用，供排查「突然停止/没画出来」类问题 */
  _aiLog(kind, detail) {
    try {
      if (!window.__xbcadAiLog) window.__xbcadAiLog = [];
      window.__xbcadAiLog.push({
        t: new Date().toISOString(), ws: this.CAD.workspace, kind,
        d: typeof detail === 'string' ? detail.slice(0, 500) : detail,
      });
      if (window.__xbcadAiLog.length > 300) window.__xbcadAiLog.splice(0, 100);
    } catch (e) { /* 日志失败不影响功能 */ }
  }

  /* ---------------- 多模态审阅（MiniMax M3 看图优化闭环） ---------------- */
  _manualReview() {
    if (this._busy) { this.CAD.notify('AI 正在工作中，请先等待或点「停止」', 'error'); return; }
    this._busy = true;
    this._ctrl = new AbortController();
    this._updateStatus();
    this._setSendButton(true);
    (async () => {
      try {
        await this._visionReview();
      } catch (e) {
        if (e && e.aborted) { this._addMessage('system', '⏹ 已停止审阅'); return; }
        if (e && e.network) {
          this._addMessage('error',
            '👁 多模态审阅失败：网络请求不通（Failed to fetch）。\n' +
            '请检查设置中的「视觉 API 地址」（MiniMax 应为 https://api.minimaxi.com，会自动补全 /v1 路径）、视觉 Key 是否正确，以及网络/防火墙是否放行。');
        } else {
          this._addMessage('error', '👁 多模态审阅失败：' + (e && e.message ? e.message : e));
        }
      } finally {
        this._busy = false;
        this._ctrl = null;
        this._updateStatus();
        this._setSendButton(false);
        // 审阅期间用户回车发送的消息不能丢（与 _runConversation 的 finally 保持一致）
        if (this._pendingSend) { this._pendingSend = false; this._runConversation(); }
      }
    })();
  }
  /** 截图 → 多模态模型看图 → 工具修改 → 再截图…… 直到模型回复满意 */
  async _visionReview() {
    const s = this.settings;
    const captureFn = this.CAD.captureForAI;
    if (typeof captureFn !== 'function') throw new Error('当前版本不支持截图审阅');
    let image = captureFn();
    if (!image) throw new Error('当前图纸/模型为空，没有可审阅的内容');
    const endpointCfg = {
      base: s.visionBase || 'https://api.minimaxi.com',
      model: s.visionModel || 'MiniMax-M3',
      key: s.visionKey || s.key,
    };
    try {
      return await this._visionReviewLoop(captureFn, endpointCfg, s);
    } finally {
      this._stripReviewImages(); // 无论成功/失败/停止都清理审阅截图
    }
  }
  async _visionReviewLoop(captureFn, endpointCfg, s) {
    let image = captureFn();
    const roundLimit = Number(s.reviewRounds) > 0 ? Number(s.reviewRounds) : Infinity;
    this._addMessage('system', `👁 多模态审阅中（${endpointCfg.model}，正在查看图纸…）`);
    let rounds = 0;
    let lastText = '';
    let lastFixSig = null;
    let fixRepeat = 0;
    while (rounds < roundLimit) {
      rounds++;
      const idxBefore = this.messages.length;
      this.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: REVIEW_PROMPT },
          { type: 'image_url', image_url: { url: image } },
        ],
      });
      const r = await this._runWithTools(endpointCfg);
      const text = (r && r.text) ? r.text : '';
      lastText = text;
      if (text) this._addMessage('assistant', text);
      // 本轮执行的修改（本轮新增的助手工具调用签名）
      const fixSig = this.messages.slice(idxBefore)
        .filter((m) => m.role === 'assistant' && m.tool_calls?.length)
        .map((m) => m.tool_calls.map((tc) => `${tc.function?.name}(${tc.function?.arguments || ''})`).join('|'))
        .join('||');
      if (!fixSig) break; // 模型未修改 = 认为满意
      // 跨轮重复修改防护：连续多轮做完全相同的修改 → 停止（防无限循环，非上限）
      if (fixSig === lastFixSig) {
        fixRepeat++;
        if (fixRepeat >= 2) {
          this._addMessage('system', '👁 模型连续多轮做了相同修改（可能陷入循环），已停止审阅。');
          break;
        }
      } else {
        lastFixSig = fixSig;
        fixRepeat = 0;
      }
      image = captureFn();
      if (!image) break;
      this._addMessage('system', '👁 已按审阅意见修改，再次检查…');
    }
    if (rounds >= roundLimit && Number(s.reviewRounds) > 0) {
      this._addMessage('system', `👁 审阅轮数已达设置上限（${s.reviewRounds}），已停止。`);
    }
    return lastText;
  }
  /** 审阅轮的大截图若留在对话历史，后续每次请求都会重发全部截图（token/带宽暴涨）——
   *  审阅结束后把图片剥离，只保留文字结论 */
  _stripReviewImages() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c && c.type === 'image_url')) {
        const txt = m.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
        if (txt) this.messages[i] = { role: 'user', content: txt };
        else this.messages.splice(i, 1);
      }
    }
  }

  async _runWithTools(endpointCfg = {}) {
    const s = this.settings;
    const roundLimit = Number(s.toolRoundLimit) > 0 ? Number(s.toolRoundLimit) : Infinity;
    const callLimit = Number(s.toolCallLimit) > 0 ? Number(s.toolCallLimit) : Infinity;
    let toolCallCount = 0;
    let lastSig = null;
    let repeatCount = 0;
    let noChange = 0;
    let noTextOnly = 0;
    let keyBefore = this._visibleContentKey();
    for (let round = 0; round < roundLimit; round++) {
      this._syncSystemMessage();
      const body = {
        model: endpointCfg.model || s.model,
        messages: this.messages,
        temperature: s.temperature,
        max_tokens: s.maxTokens,
        stream: false,
        tools: this._allTools(),
        tool_choice: 'auto',
      };
      if ((endpointCfg.model || s.model).toLowerCase().includes('m3') && s.deepThink) {
        body.thinking = { type: 'adaptive' };
      }
      let data;
      try {
        data = await this._post(body, this._ctrl.signal, endpointCfg);
      } catch (e) {
        if (e.aborted || e.network) throw e;
        if (e.status === 400 || e.status === 404) return { fallback: true };
        throw e;
      }
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('响应格式异常');
      if (msg.tool_calls && msg.tool_calls.length) {
        // 死循环检测：连续多轮发出完全相同的工具调用 → 中断
        const sig = msg.tool_calls.map((tc) => `${tc.function?.name}(${tc.function?.arguments || ''})`).join('|');
        if (sig === lastSig) {
          repeatCount++;
          if (repeatCount >= REPEAT_LIMIT) {
            this._addMessage('system', '🛡 检测到模型连续重复相同操作，已自动停止（防死循环）。下方是它的总结，可回复「继续」或换个说法重试。');
            return { fallback: false, text: await this._finalSummary(toolCallCount, '检测到模型在重复执行相同的操作，已自动停止以避免死循环', endpointCfg) };
          }
        } else {
          lastSig = sig;
          repeatCount = 0;
        }
        const names = [];
        this.messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls) {
          let result;
          try {
            result = this._callTool(tc.function?.name, this._parseArgs(tc.function?.arguments));
          } catch (err) {
            result = '工具执行错误: ' + (err && err.message ? err.message : err);
          }
          names.push(tc.function?.name || 'unknown');
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        toolCallCount += msg.tool_calls.length;
        this._aiLog('tools', names.join(','));
        this._addMessage('system', `🔧 已执行工具：${names.join('、')}`);
        // 进展熔断：连续多轮执行工具但工作区毫无变化 → 停止（防参数漂移式空转烧额度）
        const keyAfter = this._visibleContentKey();
        if (keyAfter === keyBefore) {
          noChange++;
          if (noChange >= 3) {
            this._addMessage('system', '🛡 连续多轮工具操作没有让工作区产生任何变化（可能参数无效或模型在空转），已自动停止。可回复「继续」或换个说法重试。');
            return { fallback: false, text: await this._finalSummary(toolCallCount, '连续多轮工具操作没有产生任何可见变化，已自动停止', endpointCfg) };
          }
        } else noChange = 0;
        keyBefore = keyAfter;
        if (toolCallCount >= callLimit) {
          return { fallback: false, text: await this._finalSummary(toolCallCount, '已达到设置的工具调用总次数上限') };
        }
        continue;
      }
      // 模型没有调用工具：先尝试解析内容里的 CAD JSON 代码块（工具调用粘性差的模型兜底，如 MiniMax M3 偶发只输出文字计划）
      if (msg.content) {
        const execResult = await this._executeCodeBlocks(msg.content);
        if (execResult) {
          this.messages.push({ role: 'assistant', content: msg.content });
          this.messages.push({ role: 'user', content: '[执行结果反馈]\n' + execResult });
          this._addMessage('system', '🔧 模型未调用工具，已按其输出的 CAD 指令执行');
          noTextOnly = 0;
          continue;
        }
        noTextOnly++;
        this.messages.push({ role: 'assistant', content: msg.content });
        if (noTextOnly >= 3) {
          return { fallback: false, text: msg.content };
        }
        // 再给机会：明确要求模型立即调用工具创建实体（针对只输出 think 计划不调工具的失败模式）
        this.messages.push({
          role: 'user',
          content: '[系统提示] 你刚才只输出了文字/思考，没有调用任何工具，工作区没有任何产出。'
            + '现在必须立即调用创建工具（3D 用 create_primitive_3d，2D 用 draw_entities）实际创建第一批实体——'
            + '不要继续解释计划，直接执行。',
        });
        continue;
      }
      const text = msg.content || '';
      this.messages.push({ role: 'assistant', content: text });
      return { fallback: false, text };
    }
    // 仅在用户显式设置了上限时才会走到这里
    return { fallback: false, text: await this._finalSummary(toolCallCount, '已达到设置的工具调用轮数上限') };
  }
  _capMessage(count, reason) {
    return `⚠️ ${reason}。\n本次共执行了 ${count} 次工具操作，已完成的图形都保留在图纸中（可按 Ctrl+Z 或输入命令 U 撤销）。\n💡 建议：把任务拆分成更小的步骤再让我继续，或直接回复「继续完成剩余部分」。`;
  }
  /** 达到上限时：请求模型做一次不带工具的最终总结，替代生硬的警告 */
  async _finalSummary(count, reason, endpointCfg = {}) {
    const s = this.settings;
    try {
      this.messages.push({
        role: 'user',
        content: `[系统提示] 工具调用已达到安全上限（${reason}，本轮共执行 ${count} 次操作）。请停止调用工具，直接总结：已完成哪些建模步骤、当前模型状态、以及用户可以让你继续完成什么。`,
      });
      const body = {
        model: endpointCfg.model || s.model, messages: this.messages, temperature: s.temperature,
        max_tokens: s.maxTokens, stream: false,
      };
      const data = await this._post(body, this._ctrl.signal, endpointCfg);
      const text = data.choices?.[0]?.message?.content || '';
      this.messages.push({ role: 'assistant', content: text });
      if (text) return text;
    } catch (e) {
      console.warn('[ai] 最终总结请求失败', e);
    }
    return this._capMessage(count, reason);
  }

  async _runFallback() {
    const s = this.settings;
    this._appendFallbackInstruction();
    // 清理历史中的工具调用痕迹，避免无工具请求报错
    this.messages = this.messages
      .filter((m) => m.role !== 'tool')
      .map((m) => (m.role === 'assistant' ? { role: m.role, content: m.content } : m));
    this._syncSystemMessage();

    const body = {
      model: s.model,
      messages: this.messages,
      temperature: s.temperature,
      max_tokens: s.maxTokens,
      stream: false,
    };
    const data = await this._post(body, this._ctrl.signal);
    const msg = data.choices?.[0]?.message;
    const text = msg?.content || '';
    this.messages.push({ role: 'assistant', content: text });

    const execResult = await this._executeCodeBlocks(text);
    if (execResult) {
      this._addMessage('system', execResult);
      this.messages.push({ role: 'user', content: '[执行结果反馈]\n' + execResult });
      const data2 = await this._post(body, this._ctrl.signal);
      const msg2 = data2.choices?.[0]?.message;
      const text2 = msg2?.content || '';
      this.messages.push({ role: 'assistant', content: text2 });
      return { text: text2 };
    }
    return { text };
  }

  _appendFallbackInstruction() {
    const is3d = this.CAD.workspace === '3d';
    const instr = is3d
      ? '\n\n当前是 3D 建模工作区，无法用文本命令绘制 2D 图形。如果无法调用函数工具，请用如下 JSON 代码块输出三维创建指令（一次可多条）：\n' +
        '```json\n' +
        '{"create3d":[{"kind":"box","dx":60,"dy":40,"dz":30,"x":0,"y":0,"z":0},{"kind":"cylinder","r":10,"h":50}],"query":"list3d"}\n' +
        '```\n' +
        'create3d 每项支持 kind: box(dx,dy,dz)/cylinder(r,h)/sphere(r)/cone(r1,r2,h)/torus(r1,r2)，坐标 x,y,z；query 支持 "list3d"。'
      : FALLBACK_INSTRUCTION;
    const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => (c && c.type === 'text' ? c.text : '')).join(''));
    const isRef = (t) => /^\[(参考文件|图片参考)/.test(t);
    // 找到最后一条非参考文件的 user 消息（图片参考是数组 content，不能直接 String()，否则图片被毁）
    const last = [...this.messages].reverse().find((m) => m.role === 'user' && !isRef(textOf(m)));
    if (last) {
      if (typeof last.content === 'string') last.content = last.content + instr;
      else {
        const txt = (last.content || []).find((c) => c && c.type === 'text');
        if (txt) txt.text = (txt.text || '') + instr;
        else last.content.push({ type: 'text', text: instr.trim() });
      }
    } else this.messages.push({ role: 'user', content: instr.trim() });
  }

  /* ---------------- 网络请求 ---------------- */
  async _post(body, signal, endpointCfg = {}) {
    const s = this.settings;
    const cfg = {
      base: endpointCfg.base !== undefined ? endpointCfg.base : s.base,
      key: endpointCfg.key !== undefined ? endpointCfg.key : s.key,
    };
    let base = (cfg.base || '').trim() || 'https://api.minimaxi.com';
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    base = base.replace(/\/+$/, '');
    // 智能路径：已含完整端点 → 直接用；以 /v1 结尾 → 补 /chat/completions；
    // 否则优先 /v1/chat/completions（MiniMax 等），404 时回退 /chat/completions（DeepSeek 等）
    let candidates;
    if (/\/chat\/completions$/i.test(base)) candidates = [base];
    else if (/\/v1$/i.test(base)) candidates = [base + '/chat/completions'];
    else candidates = [base + '/v1/chat/completions', base + '/chat/completions'];
    let resp;
    let lastNetworkErr = null;
    // 瞬时故障重试：网络层错误 / 401 / 429 / 5xx 在服务端可能是限流或抖动，重试 3 次（指数退避）
    const RETRYABLE = [401, 429, 500, 502, 503, 504];
    for (let attempt = 0; attempt < 3 && !resp; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
      for (let i = 0; i < candidates.length; i++) {
        const url = candidates[i];
        try {
          resp = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.key || ''}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          });
          // 404 = 路径不存在，尝试下一个候选；其余状态直接使用
          if (resp.status === 404 && i < candidates.length - 1) continue;
          break;
        } catch (e) {
          if (e && e.name === 'AbortError') { const err = new Error('aborted'); err.aborted = true; throw err; }
          lastNetworkErr = e;
          // 网络层失败（CORS/断网）不会因路径不同而改变，直接跳出路径循环
          break;
        }
      }
      if (resp && RETRYABLE.includes(resp.status) && attempt < 2) {
        console.warn(`[AI] API 瞬时故障 HTTP ${resp.status}，第 ${attempt + 1} 次重试`);
        resp = null;
      }
    }
    if (!resp) {
      const err = new Error((lastNetworkErr && lastNetworkErr.message) || '网络错误');
      err.network = true;
      throw err;
    }
    let text = '';
    try { text = await resp.text(); } catch (e) { text = ''; }
    if (!resp.ok) {
      const err = new Error(this._apiErrorMessage(resp.status, text));
      err.status = resp.status;
      throw err;
    }
    try { return JSON.parse(text); }
    catch (e) { throw new Error('响应解析失败'); }
  }
  _apiErrorMessage(status, text) {
    let msg = '';
    try { const j = JSON.parse(text); msg = j?.error?.message || ''; } catch (e) { /* ignore */ }
    return msg ? `HTTP ${status}: ${msg}` : `HTTP ${status}: ${(text || '').slice(0, 200)}`;
  }

  /* ---------------- 工具调度 ---------------- */
  _registerTools() {
    this._tools = {
      draw_entities: (a) => this._toolDrawEntities(a),
      modify_entities: (a) => this._toolModifyEntities(a),
      erase_entities: (a) => this._toolEraseEntities(a),
      set_layer: (a) => this._toolSetLayer(a),
      set_layer_props: (a) => this._toolSetLayerProps(a),
      query_drawing: (a) => this._toolQueryDrawing(a),
      select_entities: (a) => this._toolSelectEntities(a),
      zoom_view: (a) => this._toolZoomView(a),
      undo: () => this._toolUndo(),
      redo: () => this._toolRedo(),
      measure: (a) => this._toolMeasure(a),
      get_file_context: () => this._toolGetFileContext(),
      pump_sizing: (a) => this._toolPumpSizing(a),
      query_knowledge: (a) => kbSearchText(String(a?.topic || ''), { limit: 5 }),
      switch_workspace: (a) => {
        const ws = String(a?.ws || '').toLowerCase();
        if (ws !== '2d' && ws !== '3d') throw new Error('ws 必须是 2d 或 3d');
        this.CAD.app?.showWorkspace?.(ws);
        return '已切换到 ' + (ws === '3d' ? '3D 建模' : '2D 制图') + ' 工作区';
      },
    };
  }
  _parseArgs(str) {
    if (!str) return {};
    try { return JSON.parse(str); } catch (e) { return {}; }
  }
  _callTool(name, args) {
    // 工作区严格隔离：2D 区只允许 2D 工具，3D 区只允许 3D 工具
    const allowed = new Set(this._workspaceTools().map((t) => t.function.name));
    if (!allowed.has(name)) {
      throw new Error(`当前工作区（${this.CAD.workspace === '3d' ? '3D 建模' : '2D 制图'}）不支持工具: ${name}，请改用本工作区的工具`);
    }
    const fn = this._tools[name] || (this.CAD.ai3d && this.CAD.ai3d[name]);
    if (!fn) throw new Error('未知工具: ' + name);
    return fn(args || {});
  }

  /* ---------------- 工具实现 ---------------- */
  _toolDrawEntities(args) {
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) throw new Error('items 不能为空');
    const scene = this.scene;
    const out = [];
    for (const it of items) {
      const layer = it.layer || scene.currentLayer;
      const opts = { layer };
      if (it.color) opts.color = it.color;
      let e;
      switch (it.type) {
        case 'line': e = make.line({ x: num(it.x1), y: num(it.y1) }, { x: num(it.x2), y: num(it.y2) }, opts); break;
        case 'circle': e = make.circle({ x: num(it.cx), y: num(it.cy) }, num(it.r), opts); break;
        case 'arc': e = make.arc({ x: num(it.cx), y: num(it.cy) }, num(it.r), num(it.startAngle) * D2R, num(it.endAngle) * D2R, opts); break;
        case 'ellipse': e = make.ellipse({ x: num(it.cx), y: num(it.cy) }, num(it.rx), num(it.ry), num(it.rotation) * D2R, opts); break;
        case 'polyline': {
          const pts = (Array.isArray(it.points) ? it.points : []).map((p) => {
            if (Array.isArray(p)) return { x: num(p[0]), y: num(p[1]) };
            return { x: num(p.x), y: num(p.y) };
          });
          e = make.polyline(pts, { ...opts, closed: !!it.closed });
          break;
        }
        case 'rectangle': e = make.rectangle({ x: num(it.x1), y: num(it.y1) }, { x: num(it.x2), y: num(it.y2) }, opts); break;
        case 'point': e = make.point({ x: num(it.x), y: num(it.y) }, opts); break;
        case 'text': {
          const o = { ...opts };
          if (it.halign) o.halign = it.halign;
          e = make.text({ x: num(it.x), y: num(it.y) }, String(it.text ?? ''), num(it.height, 4), num(it.rotation) * D2R, o);
          break;
        }
        case 'dimension': {
          // AI 尺寸标注（商用图纸必备）：linear/aligned/radial/diametric
          if (it.subtype === 'linear' || it.subtype === 'aligned') {
            e = newEntity('dimension', {
              subtype: 'linear', layer,
              x1: num(it.x1), y1: num(it.y1), x2: num(it.x2), y2: num(it.y2),
              x3: num(it.x3, it.x1), y3: num(it.y3, it.y1),
              angle: num(it.angle) * D2R,
            });
          } else if (it.subtype === 'radial' || it.subtype === 'diametric') {
            e = newEntity('dimension', {
              subtype: it.subtype, layer,
              cx: num(it.cx), cy: num(it.cy), px: num(it.px), py: num(it.py),
              tx: num(it.tx, it.cx), ty: num(it.ty, it.cy),
            });
          } else throw new Error('dimension 的 subtype 须为 linear/aligned/radial/diametric');
          break;
        }
        default: throw new Error('未知图元类型: ' + it.type);
      }
      out.push(e);
    }
    scene.beginUndoGroup('AI 绘图');
    scene.addEntities(out);
    scene.endUndoGroup();
    this.viewport.requestRender();
    let msg = `已创建 ${out.length} 个实体: [${out.map((e) => e.id).join(', ')}]`;
    if (this.CAD.workspace === '3d') {
      msg += '\n⚠️ 注意：这些是 2D 实体，已画在 2D 图纸上，当前处于 3D 建模工作区看不到它们。若用户想要三维模型，请改用 create_primitive_3d / boolean_3d 等三维工具。';
    }
    return msg;
  }

  _toolModifyEntities(args) {
    const op = args.operation;
    if (!['move', 'copy', 'rotate', 'scale', 'mirror'].includes(op)) throw new Error('未知操作: ' + op);
    let ids = Array.isArray(args.ids) && args.ids.length ? args.ids : [...this.scene.selection];
    ids = ids.filter((id) => this.scene.get(id));
    if (!ids.length) throw new Error('未指定 ids 且当前没有选择集');
    let matrix; let copy = false; let desc;
    if (op === 'move') { matrix = translationM(num(args.dx), num(args.dy)); desc = '移动'; }
    else if (op === 'copy') { matrix = translationM(num(args.dx), num(args.dy)); copy = true; desc = '复制'; }
    else if (op === 'rotate') { matrix = rotationM(num(args.angle) * D2R, num(args.cx), num(args.cy)); desc = '旋转'; }
    else if (op === 'scale') { matrix = scaleM(num(args.factor, 1), num(args.factor, 1), num(args.cx), num(args.cy)); desc = '缩放'; }
    else { matrix = mirrorM({ x: num(args.x1), y: num(args.y1) }, { x: num(args.x2), y: num(args.y2) }); copy = true; desc = '镜像'; }
    this.scene.transformEntities(matrix, ids, { copy, group: 'AI 修改' });
    this.viewport.requestRender();
    return `已${desc} ${ids.length} 个实体${copy ? '（保留原件）' : ''}`;
  }

  _toolEraseEntities(args) {
    const scene = this.scene;
    let ids = [];
    if (args.all) ids = scene.all().map((e) => e.id);
    else if (Array.isArray(args.ids)) ids = args.ids;
    else if (args.filter) {
      ids = scene.all()
        .filter((e) => (!args.filter.type || e.type === args.filter.type) && (!args.filter.layer || e.layer === args.filter.layer))
        .map((e) => e.id);
    }
    ids = ids.filter((id) => scene.get(id));
    if (!ids.length) return '未删除任何实体（无匹配对象）';
    const removed = [];
    scene.beginUndoGroup('AI 删除');
    removed.push(...scene.removeEntities(ids));
    scene.endUndoGroup();
    this.viewport.requestRender();
    return `已删除 ${removed.length} 个实体`;
  }

  _toolSetLayer(args) {
    const scene = this.scene;
    if (!args.name) throw new Error('缺少图层名称');
    const name = String(args.name);
    const color = args.color;
    const current = !!args.current;
    if (scene.layers.has(name)) {
      if (color) { const l = scene.layer(name); if (l) l.color = color; }
    } else {
      scene.ensureLayer(name, color ? { color } : {});
    }
    if (current) scene.setCurrentLayer(name);
    scene.emit('layers');
    this.viewport.requestRender();
    return `图层「${name}」已就绪${current ? '，并设为当前图层' : ''}`;
  }

  _toolSetLayerProps(args) {
    const scene = this.scene;
    if (!args.name) throw new Error('缺少图层名称');
    const l = scene.layer(String(args.name));
    if (!l) throw new Error(`图层「${args.name}」不存在`);
    if (args.on !== undefined) l.on = !!args.on;
    if (args.locked !== undefined) l.locked = !!args.locked;
    scene.emit('layers');
    this.viewport.requestRender();
    return `图层「${args.name}」：${l.on ? '显示' : '隐藏'}，${l.locked ? '锁定' : '解锁'}`;
  }

  _toolQueryDrawing(args) {
    const scene = this.scene;
    const what = args.what || 'summary';
    switch (what) {
      case 'summary': return buildSceneSummary(scene, { maxEntities: 60 });
      case 'entity': {
        if (!args.id) throw new Error('entity 查询需要 id');
        const e = scene.get(args.id);
        if (!e) return `实体 ${args.id} 不存在`;
        return `实体 ${args.id}: ${JSON.stringify(e)}`;
      }
      case 'type': {
        if (!args.type) throw new Error('type 查询需要 type');
        const list = scene.byType(args.type);
        return `类型 ${args.type} 共 ${list.length} 个:\n` + list.map((e) => `[${e.id}] ${this._brief(e)}`).join('\n');
      }
      case 'layers': {
        const rows = [...scene.layers.values()].map((l) =>
          `${l.name}: 颜色=${l.color}, ${l.on ? '显示' : '隐藏'}, ${l.locked ? '锁定' : '解锁'}${l.name === scene.currentLayer ? '（当前）' : ''}`);
        return '图层清单:\n' + rows.join('\n');
      }
      case 'selection': {
        const sel = scene.selected();
        return `当前选择 ${sel.length} 个实体:\n` + sel.map((e) => `[${e.id}] ${e.type} ${this._brief(e)}`).join('\n');
      }
      case 'extents': {
        const bb = scene.extents();
        if (!bb) return '图纸为空';
        return `包围盒: X ${Math.round(bb[0] * 100) / 100} ~ ${Math.round(bb[2] * 100) / 100}, Y ${Math.round(bb[1] * 100) / 100} ~ ${Math.round(bb[3] * 100) / 100}（可用 zoom_view mode=extents 查看全图）`;
      }
      default: throw new Error('未知查询类型: ' + what);
    }
  }

  _toolSelectEntities(args) {
    const scene = this.scene;
    let ids = [];
    if (args.all) ids = scene.all().map((e) => e.id);
    else if (Array.isArray(args.ids)) ids = args.ids;
    else if (args.filter) {
      ids = scene.all()
        .filter((e) => (!args.filter.type || e.type === args.filter.type) && (!args.filter.layer || e.layer === args.filter.layer))
        .map((e) => e.id);
    }
    ids = ids.filter((id) => scene.get(id));
    scene.select(ids, 'set');
    this.viewport.requestRender();
    return `已选择 ${ids.length} 个实体`;
  }

  _toolZoomView(args) {
    const vp = this.viewport;
    const mode = args.mode || 'extents';
    if (Array.isArray(args.center) && args.center.length >= 2) {
      vp.centerOn(num(args.center[0]), num(args.center[1]));
    }
    if (mode === 'extents' || mode === 'fit') vp.zoomExtents();
    else if (mode === 'in') vp.zoomBy(1.25);
    else if (mode === 'out') vp.zoomBy(0.8);
    else throw new Error('未知缩放模式: ' + mode);
    this.viewport.requestRender();
    return `已执行视图缩放（${mode}）`;
  }

  _toolUndo() { return this.scene.undo() ? '已撤销上一步操作' : '没有可撤销的操作'; }
  _toolRedo() { return this.scene.redo() ? '已重做' : '没有可重做的操作'; }

  _toolMeasure(args) {
    const d = dist({ x: num(args.x1), y: num(args.y1) }, { x: num(args.x2), y: num(args.y2) });
    return `两点距离 = ${Math.round(d * 1000) / 1000} mm`;
  }

  _toolPumpSizing(args) {
    const Q = Number(args?.Q), H = Number(args?.H), n = Number(args?.n) > 0 ? Number(args.n) : 2900;
    if (!(Q > 0) || !(H > 0)) throw new Error('pump_sizing 需要正数的 Q（流量 m³/h）与 H（扬程 m）');
    const p = sizingFromDuty({ Q, H, n });
    return sizingText(p);
  }

  _toolGetFileContext() {
    if (!this.fileContexts.length) return '（当前无参考文件）';
    return this.fileContexts
      .map((c) => `[${c.name}] ${c.count} 个实体\n${c.summary}`)
      .join('\n\n');
  }

  /* 实体简要描述（供工具返回精简文本） */
  _brief(e) {
    const f = (v) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '');
    switch (e.type) {
      case 'line': return `(${f(e.x1)},${f(e.y1)})-(${f(e.x2)},${f(e.y2)})`;
      case 'circle': return `圆心(${f(e.cx)},${f(e.cy)}) r=${f(e.r)}`;
      case 'arc': return `圆心(${f(e.cx)},${f(e.cy)}) r=${f(e.r)}`;
      case 'ellipse': return `中心(${f(e.cx)},${f(e.cy)}) ${f(e.rx)}×${f(e.ry)}`;
      case 'polyline': return `${e.points?.length || 0}点${e.closed ? '闭合' : ''}`;
      case 'text': return `"${String(e.text || '').slice(0, 20)}" @(${f(e.x)},${f(e.y)})`;
      case 'point': return `(${f(e.x)},${f(e.y)})`;
      case 'insert': return `块[${e.block}] @(${f(e.x)},${f(e.y)})`;
      case 'dimension': return '标注';
      case 'hatch': return '填充';
      default: return '';
    }
  }

  /* ---------------- 文件参考 ---------------- */
  _onFiles(fileList) {
    for (const f of fileList) this._attachFile(f);
    this.fileInput.value = '';
  }

  /* ---------------- DWG 文本信息提取（专有二进制，尽力提取明文信息） ---------------- */
  _dwgVersion(bytes) {
    let head = '';
    for (let i = 0; i < Math.min(bytes.length, 64); i++) head += String.fromCharCode(bytes[i]);
    const m = head.match(/AC(\d{4})/);
    if (!m) return '未知版本';
    const map = { '1009': 'R12', '1012': 'R13', '1014': 'R14', '1015': '2000', '1018': '2004', '1021': '2007', '1024': '2010', '1027': '2013', '1032': '2018' };
    return map[m[1]] || ('AC' + m[1]);
  }
  _extractASCII(bytes) {
    const out = [];
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b >= 0x20 && b <= 0x7e) cur += String.fromCharCode(b);
      else { if (cur.length >= 4) out.push(cur); cur = ''; }
    }
    if (cur.length >= 4) out.push(cur);
    const seen = new Set();
    const res = [];
    for (const s of out) {
      if (seen.has(s)) continue;
      seen.add(s);
      // 过滤纯十六进制/噪声，保留疑似名称
      if (!/^[A-Fa-f0-9]{8,}$/.test(s) && /[A-Za-z\u4e00-\u9fff]/.test(s) && !/^[\d.]+$/.test(s)) res.push(s);
    }
    return res;
  }
  _extractUTF16Text(bytes) {
    const found = new Set();
    for (const offset of [0, 1]) {
      try {
        const dec = new TextDecoder('utf-16le', { fatal: false }).decode(bytes.slice(offset));
        const re = /[\u4e00-\u9fff][\u4e00-\u9fff\u3000-\u303fA-Za-z0-9 ，。、；：（）()\-+×xXΦφ°%./]{1,60}/g;
        let m;
        while ((m = re.exec(dec))) {
          const t = m[0].trim();
          if (t.length >= 2) found.add(t);
        }
      } catch (e) { /* 忽略 */ }
    }
    return [...found];
  }
  _summarizeDWG(bytes) {
    const ver = this._dwgVersion(bytes);
    const ascii = this._extractASCII(bytes);
    const utf16 = this._extractUTF16Text(bytes);
    const lines = [
      `DWG 文件（版本 ${ver}，Autodesk 专有二进制格式）`,
      '浏览器无法完整解析其几何实体；以下是从文件中提取的文本信息，仅供参考：',
      '',
    ];
    if (ascii.length) lines.push(`疑似图层/块/路径等名称（${ascii.length} 个）: ` + ascii.slice(0, 40).join(', '));
    if (utf16.length) lines.push(`疑似图纸文字（${utf16.length} 条）: ` + utf16.slice(0, 40).join(' | '));
    lines.push('');
    lines.push('⚠️ 如需完整几何：请先用 ODA File Converter 或 LibreDWG（dwg2dxf）转换为 DXF 后重新附加，即可完整读取并参考。');
    return lines.join('\n').slice(0, 3000);
  }

  async _attachFile(file) {
    const name = file.name || '未命名';
    const ext = (name.split('.').pop() || '').toLowerCase();
    // 统一大小保护：超大附件会卡死主线程/撑爆上下文
    const sizeMB = (file.size || 0) / 1024 / 1024;
    const LIMITS = { dwg: 80, dxf: 30, json: 20, svg: 20, txt: 5 };
    if (LIMITS[ext] && sizeMB > LIMITS[ext]) {
      const msg = `📎 附件过大（${sizeMB.toFixed(1)}MB，${ext.toUpperCase()} 上限 ${LIMITS[ext]}MB），请精简后重试`;
      try { this.CAD.notify(msg, 'error'); } catch (_) { /* ignore */ }
      this._addMessage('error', msg);
      return;
    }
    // 图片参考：直接以多模态内容注入对话（原生多模态能力）
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
      if (sizeMB > 8) {
        const msg = `🖼 图片过大（${sizeMB.toFixed(1)}MB，上限 8MB）`;
        try { this.CAD.notify(msg, 'error'); } catch (_) { /* ignore */ }
        this._addMessage('error', msg);
        return;
      }
      try {
        const dataURL = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error('读取图片失败'));
          r.readAsDataURL(file);
        });
        if (dataURL.length > 8 * 1024 * 1024) throw new Error('图片过大（>8MB）');
        this.messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `[图片参考] ${name}\n请结合这张图片进行创作（照着图片中的内容建模/绘图）。` },
            { type: 'image_url', image_url: { url: dataURL } },
          ],
        });
        this._addMessage('system', `🖼 已附加图片参考：${name}（模型将直接看懂这张图）`);
      } catch (e) {
        const msg = '🖼 图片参考失败: ' + (e && e.message ? e.message : e);
        try { this.CAD.notify(msg, 'error'); } catch (_) { /* ignore */ }
        this._addMessage('error', msg);
      }
      return;
    }
    // DWG：本软件直接解析（LibreDWG WASM），把实体/图层信息交给模型
    if (ext === 'dwg') {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let summary; let count = 0; let parsed = false;
        try {
          const { parseDWG } = await import('./dwg.js');
          const data = await parseDWG(bytes);
          count = data.entities.length;
          summary = buildDataSummary(data, { maxEntities: 80 });
          parsed = true;
        } catch (parseErr) {
          // 解析失败 → 退化为文本信息提取
          summary = this._summarizeDWG(bytes);
        }
        const entry = { name, count: parsed ? count : null, summary, ext };
        this.fileContexts.push(entry);
        this._addChip(entry);
        this.messages.push({
          role: 'user',
          content: parsed
            ? `[参考文件] ${name}\n本软件已解析该 DWG 文件，以下内容可直接使用（无需也无法查看原文件）：\n${summary}`
            : `[参考文件] ${name}（DWG 专有二进制格式，完整解析失败）\n${summary}`,
        });
        this._addMessage('system', parsed
          ? `📎 已解析 ${name}：${count} 个实体、${(summary.split('图层: ')[1] || '').split('\n')[0] || '图层信息'} 已提供给模型`
          : `📎 已附加 ${name}：仅提取到文本信息（完整解析失败）`);
      } catch (e) {
        const msg = '📎 读取 DWG 失败: ' + (e && e.message ? e.message : e);
        try { this.CAD.notify(msg, 'error'); } catch (_) { /* ignore */ }
        this._addMessage('error', msg);
      }
      return;
    }
    try {
      const text = await fileToText(file);
      let summary; let count = 0; let isText = false;
      if (ext === 'dxf') {
        if (!this.CAD.dxf) throw new Error('DXF 模块未加载');
        const data = this.CAD.dxf.parseDXF(text);
        count = (data && data.entities ? data.entities : []).length;
        summary = buildDataSummary(data, { maxEntities: 60 });
      } else if (ext === 'json' || ext === 'xbcad') {
        const json = JSON.parse(text);
        const s = Scene.load(json);
        count = s.count();
        summary = buildSceneSummary(s, { maxEntities: 60 });
      } else if (ext === 'svg') {
        const entities = svgToEntities(text);
        count = entities.length;
        summary = buildDataSummary({ layers: [], entities, units: 'mm' }, { maxEntities: 60 });
      } else if (ext === 'txt') {
        summary = text.slice(0, MAX_SUMMARY_LEN);
        if (text.length > MAX_SUMMARY_LEN) summary += '\n…（已截断）';
        isText = true;
      } else {
        throw new Error('不支持的文件格式: .' + ext);
      }

      let finalSummary = summary;
      if (!isText && finalSummary.length > MAX_SUMMARY_LEN) {
        finalSummary = finalSummary.slice(0, MAX_SUMMARY_LEN) + '\n…（摘要已截断）';
      }

      const entry = { name, count, summary: finalSummary, ext };
      this.fileContexts.push(entry);
      this._addChip(entry);

      const ctxMsg = `[参考文件] ${name}（${count} 个实体）\n摘要:\n${finalSummary}`;
      this.messages.push({ role: 'user', content: ctxMsg });

      const note = isText
        ? `已读取文件 ${name}（文本参考）`
        : `已读取文件 ${name}，共 ${count} 个实体`;
      this._addMessage('system', note);
    } catch (e) {
      const msg = '📎 读取参考文件失败: ' + (e && e.message ? e.message : e);
      try { this.CAD.notify(msg, 'error'); } catch (_) { /* ignore */ }
      this._addMessage('error', msg);
    }
  }

  _addChip(entry) {
    const chip = document.createElement('span');
    chip.className = 'ai-chip';
    chip.title = entry.name;
    const label = document.createElement('span');
    label.textContent = `📎 ${entry.name}${entry.count != null ? `（${entry.count}）` : ''}`;
    const x = document.createElement('i');
    x.className = 'ai-chip-x';
    x.textContent = '×';
    x.title = '移除该参考文件';
    x.addEventListener('click', () => {
      const i = this.fileContexts.indexOf(entry);
      if (i >= 0) this.fileContexts.splice(i, 1);
      chip.remove();
    });
    chip.appendChild(label);
    chip.appendChild(x);
    this.chipsEl.appendChild(chip);
  }

  /* ---------------- 降级模式：解析并执行代码块 ---------------- */
  async _executeCodeBlocks(text) {
    const blocks = [];
    const re = /```(?:json|cad)\s*\n?([\s\S]*?)```/gi;
    let m;
    while ((m = re.exec(text))) blocks.push(m[1]);
    if (!blocks.length) return null;
    const results = [];
    for (const code of blocks) {
      try {
        const obj = JSON.parse(code.trim());
        results.push(...this._applyCadJSON(obj));
      } catch (e) {
        results.push('JSON 解析失败: ' + (e && e.message ? e.message : e));
      }
    }
    return results.length ? '📐 已解析并执行 CAD 指令：\n' + results.join('\n') : null;
  }

  _applyCadJSON(obj) {
    const is3d = this.CAD.workspace === '3d';
    const results = [];
    if (obj && Array.isArray(obj.commands)) {
      if (is3d) {
        results.push('当前为 3D 建模工作区，已忽略 2D 命令（commands）——请用 create3d 指令建模');
      } else {
        for (const cmd of obj.commands) {
          try {
            this.CAD.commander.execAndEnd(String(cmd));
            results.push('已执行命令: ' + cmd);
          } catch (e) {
            results.push('命令执行失败: ' + cmd + ' → ' + (e && e.message ? e.message : e));
          }
        }
      }
    }
    if (obj && Array.isArray(obj.draw)) {
      if (is3d) results.push('当前为 3D 建模工作区，已忽略 2D 绘图（draw）——请用 create3d 指令建模');
      else {
        try { results.push(this._toolDrawEntities({ items: obj.draw })); }
        catch (e) { results.push('draw 执行失败: ' + (e && e.message ? e.message : e)); }
      }
    }
    if (obj && Array.isArray(obj.create3d)) {
      if (!is3d) results.push('当前为 2D 制图工作区，已忽略 3D 建模（create3d）——请用 draw/commands 指令绘图');
      else {
        try {
          const a3d = this.CAD.ai3d;
          if (!a3d) throw new Error('三维内核未就绪');
          const done = [];
          for (const it of obj.create3d) done.push(a3d.create_primitive_3d(it));
          results.push(done.join(' | '));
        } catch (e) { results.push('create3d 执行失败: ' + (e && e.message ? e.message : e)); }
      }
    }
    if (obj && obj.query) {
      const q = String(obj.query);
      if (q === 'list3d' && this.CAD.ai3d) {
        try { results.push(this.CAD.ai3d.list_3d({})); }
        catch (e) { results.push('list3d 执行失败: ' + (e && e.message ? e.message : e)); }
      } else {
        try { results.push(this._toolQueryDrawing({ what: q })); }
        catch (e) { results.push('query 执行失败: ' + (e && e.message ? e.message : e)); }
      }
    }
    return results;
  }

  /* ---------------- 设置对话框 ---------------- */
  _openSettingsDialog() {
    const s = this.settings;
    const box = document.createElement('div');
    const row = (label, control) => {
      const r = document.createElement('div');
      r.className = 'form-row';
      const l = document.createElement('label');
      l.textContent = label;
      r.appendChild(l);
      r.appendChild(control);
      box.appendChild(r);
      return control;
    };
    const mkInput = (type, value, ph) => {
      const inp = document.createElement('input');
      inp.type = type;
      inp.value = value;
      if (ph) inp.placeholder = ph;
      return inp;
    };

    const baseInp = mkInput('text', s.base, 'https://api.minimaxi.com');
    row('API 地址(主模型)', baseInp);
    const modelInp = mkInput('text', s.model, 'MiniMax-M3');
    row('模型', modelInp);
    const keyInp = mkInput('password', s.key, 'MiniMax 平台 platform.minimaxi.com 申请');
    row('API Key', keyInp);

    const tempInp = mkInput('number', String(s.temperature));
    tempInp.min = '0'; tempInp.max = '1'; tempInp.step = '0.1';
    row('温度', tempInp);

    const maxInp = mkInput('number', String(s.maxTokens));
    maxInp.min = '1'; maxInp.step = '100';
    row('最大 token', maxInp);

    const roundLimitInp = mkInput('number', String(s.toolRoundLimit ?? 0), '0 = 不限制');
    roundLimitInp.min = '0'; roundLimitInp.step = '1';
    row('工具轮数上限', roundLimitInp);
    const callLimitInp = mkInput('number', String(s.toolCallLimit ?? 0), '0 = 不限制');
    callLimitInp.min = '0'; callLimitInp.step = '10';
    row('工具次数上限', callLimitInp);

    // ---- 多模态审阅（MiniMax M3 原生多模态） ----
    const sep = document.createElement('div');
    sep.style.cssText = 'margin:10px 0 6px;border-top:1px solid var(--border);padding-top:8px;color:var(--text-dim);font-size:12px;';
    sep.textContent = '👁 多模态审阅（创作完成后自动看图检查并优化）';
    box.appendChild(sep);

    const vBaseInp = mkInput('text', String(s.visionBase ?? 'https://api.minimaxi.com'), 'https://api.minimaxi.com');
    row('视觉 API 地址', vBaseInp);
    const vModelInp = mkInput('text', String(s.visionModel ?? 'MiniMax-M3'), 'MiniMax-M3');
    row('视觉模型', vModelInp);
    const vKeyInp = mkInput('password', String(s.visionKey ?? ''), '留空 = 沿用主模型 Key');
    row('视觉 Key(可选)', vKeyInp);

    const autoRow = document.createElement('div');
    autoRow.className = 'form-row';
    const autoLabel = document.createElement('label');
    autoLabel.textContent = '自动审阅';
    const autoChk = document.createElement('input');
    autoChk.type = 'checkbox';
    autoChk.checked = !!s.autoReview;
    autoChk.style.cssText = 'flex:none;width:16px;height:16px;accent-color:var(--accent);';
    const autoText = document.createElement('span');
    autoText.textContent = '每次创作后自动让多模态模型看图优化（也可点 👁 审阅 手动触发）';
    autoText.style.cssText = 'color:var(--text-dim);font-size:12px;';
    autoRow.appendChild(autoLabel);
    autoRow.appendChild(autoChk);
    autoRow.appendChild(autoText);
    box.appendChild(autoRow);

    const rRoundInp = mkInput('number', String(s.reviewRounds ?? 0), '0 = 不限制');
    rRoundInp.min = '0'; rRoundInp.step = '1';
    row('审阅轮数上限', rRoundInp);

    const thinkRow = document.createElement('div');
    thinkRow.className = 'form-row';
    const thinkLabel = document.createElement('label');
    thinkLabel.textContent = '深度思考';
    const thinkChk = document.createElement('input');
    thinkChk.type = 'checkbox';
    thinkChk.checked = !!s.deepThink;
    thinkChk.style.cssText = 'flex:none;width:16px;height:16px;accent-color:var(--accent);';
    const thinkText = document.createElement('span');
    thinkText.textContent = 'MiniMax M3 thinking 模式（审阅质量更高，响应稍慢）';
    thinkText.style.cssText = 'color:var(--text-dim);font-size:12px;';
    thinkRow.appendChild(thinkLabel);
    thinkRow.appendChild(thinkChk);
    thinkRow.appendChild(thinkText);
    box.appendChild(thinkRow);

    const toolsRow = document.createElement('div');
    toolsRow.className = 'form-row';
    const toolsLabel = document.createElement('label');
    toolsLabel.textContent = '函数调用';
    const toolsChk = document.createElement('input');
    toolsChk.type = 'checkbox';
    toolsChk.checked = !!s.useTools;
    toolsChk.style.cssText = 'flex:none;width:16px;height:16px;accent-color:var(--accent);';
    const toolsText = document.createElement('span');
    toolsText.textContent = '启用函数调用(工具)';
    toolsText.style.cssText = 'color:var(--text-dim);font-size:12px;';
    toolsRow.appendChild(toolsLabel);
    toolsRow.appendChild(toolsChk);
    toolsRow.appendChild(toolsText);
    box.appendChild(toolsRow);

    const help = document.createElement('div');
    help.className = 'form-help';
    help.textContent = 'Key 仅保存在本浏览器 localStorage，不会上传到任何第三方。工具轮数/次数上限默认 0（不限制）；无论是否设上限，模型连续重复相同操作时都会自动停下防死循环，也可随时点「停止」手动打断。';
    box.appendChild(help);

    this.CAD.ui.dialog({
      title: 'AI 助手设置',
      body: box,
      buttons: [
        { label: '取消' },
        {
          label: '保存',
          primary: true,
          onClick: () => {
            const base = baseInp.value.trim();
            const model = modelInp.value.trim();
            const key = keyInp.value.trim();
            if (!base || !model) { this.CAD.notify('请填写 API 地址与模型', 'error'); return false; }
            const temp = parseFloat(tempInp.value);
            const maxTokens = parseInt(maxInp.value, 10);
            const roundLimit = parseInt(roundLimitInp.value, 10);
            const callLimit = parseInt(callLimitInp.value, 10);
            const reviewRounds = parseInt(rRoundInp.value, 10);
            this.settings = {
              base,
              model,
              key,
              temperature: Number.isFinite(temp) ? Math.min(1, Math.max(0, temp)) : DEFAULT_SETTINGS.temperature,
              maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_SETTINGS.maxTokens,
              useTools: toolsChk.checked,
              toolRoundLimit: Number.isFinite(roundLimit) && roundLimit >= 0 ? roundLimit : 0,
              toolCallLimit: Number.isFinite(callLimit) && callLimit >= 0 ? callLimit : 0,
              visionBase: vBaseInp.value.trim() || DEFAULT_SETTINGS.visionBase,
              visionModel: vModelInp.value.trim() || DEFAULT_SETTINGS.visionModel,
              visionKey: vKeyInp.value.trim(),
              autoReview: autoChk.checked,
              reviewRounds: Number.isFinite(reviewRounds) && reviewRounds >= 0 ? reviewRounds : 0,
              deepThink: thinkChk.checked,
              settingsVersion: SETTINGS_VERSION,
            };
            try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
            this._updateStatus();
            this.CAD.notify('AI 设置已保存');
          },
        },
      ],
    });
  }
}
