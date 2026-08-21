#!/usr/bin/env python3
"""小宝CAD 测试用 Mock AI 服务器 —— 模拟 DeepSeek API 的工具调用对话流。
按"助手已发出的工具调用轮数"推进剧本，从历史 tool 消息中提取实体 id，
与真实大模型的行为一致（先创建→查询→布尔→总结）。
"""
import json, re, math
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8898

def tool_call(cid, name, args):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}

def resp(message, finish="stop"):
    return {
        "id": "mock", "object": "chat.completion", "model": "mock-water-pump",
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
    }

def extract_ids(messages):
    """从「当前训练任务段」的 tool 结果中提取实体 id（顺序保持、去重：创建顺序即索引）。
    只扫描最近一条 [训练任务:xxx] 用户消息之后的 tool 结果，避免跨任务历史污染。"""
    cut = 0
    for i, m in enumerate(messages):
        c = m.get("content")
        # 任务段起点 = 最近一条「绘图指令」（验收反馈消息虽带任务标识，但不能作为实体 id 起点）
        if m.get("role") == "user" and isinstance(c, str) and "[训练任务:" in c and "[验收反馈]" not in c:
            cut = i
    ids = []
    for m in messages[cut:]:
        if m.get("role") == "tool" and isinstance(m.get("content"), str):
            for x in re.findall(r"id=([A-Za-z0-9]+)", m["content"]):
                if x not in ids:
                    ids.append(x)
    return ids

def review_messages(messages):
    out = []
    for m in messages:
        if m.get("role") != "user" or not isinstance(m.get("content"), list):
            continue
        for c in m["content"]:
            if isinstance(c, dict) and "text" in c and "[多模态审阅]" in str(c["text"]):
                out.append(m)
                break
    return out

def last_user_is_review(messages):
    # 多模态审阅 或 验收反馈 都走同一套修复剧本
    last = last_plain_ask(messages)
    if last and "[验收反馈]" in last:
        return True
    for m in reversed(messages):
        if m.get("role") == "user":
            if isinstance(m.get("content"), list):
                return any(isinstance(c, dict) and "text" in c and "[多模态审阅]" in str(c["text"]) for c in m["content"])
            return False
    return False

def last_plain_ask(messages):
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            if c.startswith("[系统提示]") or c.startswith("[参考文件]"):
                continue
            return c
        if isinstance(c, list):
            texts = [x.get("text", "") for x in c if isinstance(x, dict) and "text" in x]
            if texts and not any("[多模态审阅]" in t for t in texts):
                return texts[0]
    return ""

def history_has(messages, key):
    for m in messages:
        if key in str(m.get("content", "")):
            return True
    return False

def assistant_has(messages, key):
    """只检查 assistant 消息（阶段标记不得被用户提示词误命中）"""
    for m in messages:
        if m.get("role") == "assistant" and key in str(m.get("content", "")):
            return True
    return False

def pump_stage(messages):
    # 只统计三维工具轮次（2D/审阅轮次不推进水泵阶段）
    n = 0
    for m in messages:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            names = [tc["function"]["name"] for tc in m["tool_calls"]]
            if any(nm in ("create_primitive_3d", "boolean_3d", "list_3d") for nm in names):
                n += 1
    return n + 1

def rect_rounds(messages):
    return sum(1 for m in messages if m.get("role") == "assistant" and m.get("tool_calls")
               and any(tc["id"] == "c2d1" for tc in m["tool_calls"]))

def plain_ask_count(messages):
    n = 0
    for m in messages:
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            if "[多模态审阅]" not in c and "[参考文件]" not in c and "[系统提示]" not in c and "[执行结果反馈]" not in c:
                n += 1
        elif isinstance(c, list):
            texts = [x.get("text", "") for x in c if isinstance(x, dict) and "text" in x]
            if texts and not any("[多模态审阅]" in t for t in texts):
                n += 1
    return n

def extra_rounds(messages):
    return sum(1 for m in messages if m.get("role") == "assistant" and m.get("tool_calls")
               and any(tc["id"] == "c10" for tc in m["tool_calls"]))

def training_task(messages):
    m = re.search(r"\[训练任务:([\w-]+)\]", last_plain_ask(messages) or "")
    if m:
        tid = m.group(1)
        # 裸需求任务复用基任务剧本（-bare 与基任务相同几何/尺寸）
        if tid.endswith("-bare") and tid[:-5] in {"pumpduty3d", "pumpboth"}:
            return tid[:-5]
        return tid
    a = last_plain_ask(messages) or ""
    # 自然语言工况需求识别：提到流量+扬程/转速 → 裸对话商用泵任务（可训练）
    if ("流量" in a or re.search(r"Q\s*=", a)) and ("扬程" in a or re.search(r"H\s*=", a) or "rpm" in a or "转速" in a) and "泵" in a:
        return "conversation3d"
    # 图纸请求识别：提到图纸+剖视/三视图/总装 → 图纸集任务
    if "图纸" in a and ("剖视" in a or "三视图" in a or "总装" in a or "出图" in a) and "泵" in a:
        return "drawingchain2d"
    return None

def build_stage(stage, messages, has_tools):
    if not has_tools:
        msg = {"role": "assistant",
               "content": "✅ 任务阶段性总结：已按你的要求完成零件的创建与合并，当前模型保留在图"
                          "纸中。你可以回复「继续」让我完成剩余部分。",
               "tool_calls": None}
        return resp(msg, "stop")
    # 多模态审阅剧本：第一轮发现问题并修改，第二轮表示满意
    if last_user_is_review(messages):
        task = training_task(messages)
        # 训练任务审阅：按任务补上故意漏掉的部分
        if task == "flange2d" and not assistant_has(messages, "补上 6 个孔"):
            holes = []
            for k in range(6):
                a = k * 3.141592653589793 / 3
                holes.append({"type": "circle", "cx": 35 * math.cos(a), "cy": 35 * math.sin(a), "r": 5})
            msg = {"role": "assistant", "content": "截图里发现法兰盘缺少 6 个均布小孔，我补上 6 个孔。",
                   "tool_calls": [tool_call("r-f1", "draw_entities", {"items": holes})]}
            return resp(msg, "tool_calls")
        if task == "bracket2d" and not assistant_has(messages, "补上 2 个孔"):
            msg = {"role": "assistant", "content": "截图里发现支架轮廓缺少 2 个圆孔，我补上 2 个孔。",
                   "tool_calls": [tool_call("r-b1", "draw_entities", {"items": [
                       {"type": "circle", "cx": 20, "cy": 30, "r": 10},
                       {"type": "circle", "cx": 80, "cy": 30, "r": 10},
                   ]})]}
            return resp(msg, "tool_calls")
        if task == "plate3d" and not assistant_has(messages, "补上差集"):
            ids = extract_ids(messages)
            if len(ids) >= 5:
                msg = {"role": "assistant", "content": "截图里发现四孔板还没有挖孔，我用差集把 4 个孔挖出来（补上差集）。",
                       "tool_calls": [tool_call("r-p1", "boolean_3d", {"op": "cut", "a": ids[0], "b": ids[1:5]})]}
                return resp(msg, "tool_calls")
        if task == "sleeve3d" and not assistant_has(messages, "补上差集"):
            ids = extract_ids(messages)
            if len(ids) >= 2:
                msg = {"role": "assistant", "content": "截图里发现轴套还没挖内孔，我用差集挖出同心通孔（补上差集）。",
                       "tool_calls": [tool_call("r-s1", "boolean_3d", {"op": "cut", "a": ids[0], "b": [ids[1]]})]}
                return resp(msg, "tool_calls")
        if task == "impeller3d" and not assistant_has(messages, "补上布尔"):
            ids = extract_ids(messages)
            if len(ids) >= 8:  # 创建顺序：轮盘、中心孔柱、6 叶片
                msg = {"role": "assistant", "content": "截图里发现叶轮还没挖中心孔、叶片也没与轮盘合并，我补上布尔（补上布尔）。",
                       "tool_calls": [
                           tool_call("r-i1", "boolean_3d", {"op": "cut", "a": ids[0], "b": [ids[1]]}),
                           tool_call("r-i2", "boolean_3d", {"op": "fuse", "a": ids[0], "b": ids[2:8]}),
                       ]}
                return resp(msg, "tool_calls")
        if task == "casing3d" and not assistant_has(messages, "补上布尔"):
            ids = extract_ids(messages)
            if len(ids) >= 5:  # 创建顺序：外壳、底座、进水法兰、出水法兰、内腔柱
                msg = {"role": "assistant", "content": "截图里发现泵壳的底座法兰没合并、内腔流道也没挖，我补上布尔（补上布尔）。",
                       "tool_calls": [
                           tool_call("r-c1", "boolean_3d", {"op": "fuse", "a": ids[0], "b": ids[1:4]}),
                           tool_call("r-c2", "boolean_3d", {"op": "cut", "a": ids[0], "b": [ids[4]]}),
                       ]}
                return resp(msg, "tool_calls")
        if task == "shaft3d" and not assistant_has(messages, "补上第 5 段"):
            msg = {"role": "assistant", "content": "截图里发现台阶轴只有 4 段，我补上第 5 段（r10×30）。",
                   "tool_calls": [tool_call("r-sh1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 10, "h": 30, "color": "#8fd3a8"})]}
            return resp(msg, "tool_calls")
        if task in ("pumpduty3d", "conversation3d") and not assistant_has(messages, "补上泵轴"):
            msg = {"role": "assistant", "content": "截图里发现商用泵缺泵轴，我按 pump_sizing 的轴径补上（轴径 31mm，补上泵轴）。",
                   "tool_calls": [tool_call("r-pd1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 15.5, "h": 120, "color": "#b9a3f0"})]}
            return resp(msg, "tool_calls")
        if task == "multistage3d" and not assistant_has(messages, "补上轴系"):
            msg = {"role": "assistant", "content": "截图里发现两级泵缺长轴和两端轴承座，我补上轴系（补上轴系）。",
                   "tool_calls": [
                       tool_call("r-ms1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 30, "h": 200, "color": "#b9a3f0"}),
                       tool_call("r-ms2", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": -20, "r": 32, "h": 20, "color": "#c8c8c8"}),
                       tool_call("r-ms3", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 200, "r": 32, "h": 20, "color": "#c8c8c8"}),
                   ]}
            return resp(msg, "tool_calls")
        if task == "minipump3d" and not assistant_has(messages, "补上泵轴"):
            msg = {"role": "assistant", "content": "截图里发现整机缺泵轴，我补上泵轴（Φ60×120，与叶轮孔 Φ61 间隙配合）。",
                   "tool_calls": [tool_call("r-mp1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 30, "h": 120, "color": "#b9a3f0"})]}
            return resp(msg, "tool_calls")
        if task == "selfprime3d" and not assistant_has(messages, "补上泵轴"):
            ids = extract_ids(messages)
            if len(ids) >= 2:
                msg = {"role": "assistant", "content": "截图里发现自吸泵缺泵轴、储液腔没与泵壳合并，我补上泵轴和并集。",
                       "tool_calls": [
                           tool_call("r-sp1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 15.5, "h": 130, "color": "#b9a3f0"}),
                           tool_call("r-sp2", "boolean_3d", {"op": "fuse", "a": ids[0], "b": [ids[1]]}),
                       ]}
                return resp(msg, "tool_calls")
        if task == "pumpboth" and not assistant_has(messages, "补上图纸"):
            msg = {"role": "assistant", "content": "截图里发现图纸侧缺标注与文字，我补上图纸。",
                   "tool_calls": [tool_call("r-pb1", "draw_entities", {"items": [
                       {"type": "dimension", "subtype": "diametric", "cx": 50, "cy": 175, "px": 95, "py": 175, "tx": 30, "ty": 140},
                       {"type": "dimension", "subtype": "diametric", "cx": 50, "cy": 175, "px": 60, "py": 175, "tx": 70, "ty": 220},
                       {"type": "dimension", "subtype": "linear", "x1": 0, "y1": 260, "x2": 100, "y2": 260, "x3": 50, "y3": 275},
                       {"type": "text", "x": 250, "y": 40, "text": "离心泵总装图", "height": 10},
                       {"type": "text", "x": 250, "y": 28, "text": "比例 1:2", "height": 7},
                       {"type": "text", "x": 330, "y": 8, "text": "图号 XBC-001", "height": 7},
                       {"type": "text", "x": 6, "y": -6, "text": "序号 名称 数量 材料 备注", "height": 6},
                       {"type": "text", "x": 6, "y": -20, "text": "1 泵壳 1 HT200", "height": 5},
                       {"type": "text", "x": 6, "y": -34, "text": "2 叶轮 1 ZG1Cr18Ni9Ti", "height": 5},
                       {"type": "text", "x": 6, "y": -48, "text": "3 泵轴 1 2Cr13", "height": 5},
                       {"type": "text", "x": 6, "y": -62, "text": "4 轴承 2 6206", "height": 5},
                       {"type": "text", "x": 6, "y": -76, "text": "5 机械密封 1 SiC-石墨", "height": 5},
                   ]})]}
            return resp(msg, "tool_calls")
        if task == "axialflow3d" and not assistant_has(messages, "补上泵轴"):
            msg = {"role": "assistant", "content": "截图里发现轴流泵缺泵轴，我补上泵轴（r20×160）。",
                   "tool_calls": [tool_call("r-ax1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 20, "h": 160, "color": "#b9a3f0"})]}
            return resp(msg, "tool_calls")
        if task == "drawingchain2d" and not assistant_has(messages, "补上标注文字"):
            msg = {"role": "assistant", "content": "截图里发现图纸集缺标注与标题栏/BOM 文字，我补上标注文字。",
                   "tool_calls": [tool_call("r-dc1", "draw_entities", {"items": [
                       {"type": "dimension", "subtype": "diametric", "cx": 50, "cy": 175, "px": 95, "py": 175, "tx": 30, "ty": 140},
                       {"type": "dimension", "subtype": "diametric", "cx": 50, "cy": 175, "px": 60, "py": 175, "tx": 70, "ty": 220},
                       {"type": "dimension", "subtype": "diametric", "cx": 50, "cy": 175, "px": 58, "py": 175, "tx": 20, "ty": 230},
                       {"type": "text", "x": 250, "y": 40, "text": "离心泵总装图", "height": 10},
                       {"type": "text", "x": 250, "y": 28, "text": "比例 1:2", "height": 7},
                       {"type": "text", "x": 330, "y": 8, "text": "图号 XBC-001", "height": 7},
                       {"type": "text", "x": 6, "y": -6, "text": "序号 名称 数量 材料 备注", "height": 6},
                       {"type": "text", "x": 6, "y": -20, "text": "1 泵壳 1 HT200", "height": 5},
                       {"type": "text", "x": 6, "y": -34, "text": "2 叶轮 1 ZG1Cr18Ni9Ti", "height": 5},
                       {"type": "text", "x": 6, "y": -48, "text": "3 泵轴 1 2Cr13", "height": 5},
                       {"type": "text", "x": 6, "y": -62, "text": "4 轴承 2 6206", "height": 5},
                       {"type": "text", "x": 6, "y": -76, "text": "5 机械密封 1 SiC-石墨", "height": 5},
                   ]})]}
            return resp(msg, "tool_calls")
        if task == "bom2d" and not assistant_has(messages, "补上明细文字"):
            msg = {"role": "assistant", "content": "截图里发现明细栏缺文字，我补上明细文字。",
                   "tool_calls": [tool_call("r-bm1", "draw_entities", {"items": [
                       {"type": "text", "x": 6, "y": -6, "text": "序号 名称 数量 材料 备注", "height": 6},
                       {"type": "text", "x": 6, "y": -20, "text": "1 泵壳 1 HT200", "height": 5},
                       {"type": "text", "x": 6, "y": -34, "text": "2 叶轮 1 ZG1Cr18Ni9Ti", "height": 5},
                       {"type": "text", "x": 6, "y": -48, "text": "3 泵轴 1 2Cr13", "height": 5},
                       {"type": "text", "x": 6, "y": -62, "text": "4 轴承 2 6206", "height": 5},
                       {"type": "text", "x": 6, "y": -76, "text": "5 机械密封 1 SiC-石墨", "height": 5},
                   ]})]}
            return resp(msg, "tool_calls")
        if task == "doublesuction3d" and not assistant_has(messages, "补上泵轴"):
            msg = {"role": "assistant", "content": "截图里发现双吸泵缺泵轴，我补上泵轴（r16×130）。",
                   "tool_calls": [tool_call("r-ds1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 16, "h": 130, "color": "#b9a3f0"})]}
            return resp(msg, "tool_calls")
        if task == "threeview2d" and not assistant_has(messages, "补上俯侧视图"):
            msg = {"role": "assistant", "content": "截图里发现缺少俯视图轮廓和侧视图叶轮圆，我补上俯侧视图。",
                   "tool_calls": [tool_call("r-tv1", "draw_entities", {"items": [
                       {"type": "rectangle", "x1": 5, "y1": -110, "x2": 95, "y2": -30},
                       {"type": "line", "x1": 50, "y1": -115, "x2": 50, "y2": -25, "layer": "中心线"},
                       {"type": "rectangle", "x1": 130, "y1": 145, "x2": 210, "y2": 225},
                       {"type": "circle", "cx": 170, "cy": 185, "r": 30},
                   ]})]}
            return resp(msg, "tool_calls")
        if task == "drawingframe2d" and not assistant_has(messages, "补上文字"):
            msg = {"role": "assistant", "content": "截图里发现标题栏缺文字，我补上文字。",
                   "tool_calls": [tool_call("r-df1", "draw_entities", {"items": [
                       {"type": "text", "x": 250, "y": 40, "text": "离心泵总装图", "height": 10},
                       {"type": "text", "x": 250, "y": 28, "text": "比例 1:2", "height": 7},
                       {"type": "text", "x": 250, "y": 16, "text": "材料 HT200", "height": 7},
                       {"type": "text", "x": 330, "y": 8, "text": "图号 XBC-001", "height": 7},
                   ]})]}
            return resp(msg, "tool_calls")
        if task == "pumpdrawing2d" and not assistant_has(messages, "补上标注"):
            msg = {"role": "assistant", "content": "截图里发现图纸缺少尺寸标注，我补上标注（补上标注）。",
                   "tool_calls": [tool_call("r-dw1", "draw_entities", {"items": [
                       {"type": "dimension", "subtype": "diametric", "cx": 0, "cy": 0, "px": 70, "py": 0, "tx": 30, "ty": 30},
                       {"type": "dimension", "subtype": "diametric", "cx": 0, "cy": 0, "px": 40, "py": 0, "tx": -30, "ty": -30},
                       {"type": "dimension", "subtype": "diametric", "cx": 0, "cy": 0, "px": 12, "py": 0, "tx": 50, "ty": -40},
                       {"type": "dimension", "subtype": "linear", "x1": -90, "y1": 100, "x2": 90, "y2": 100, "x3": 0, "y3": 115},
                   ]})]}
            return resp(msg, "tool_calls")
        if task == "volute2d" and not assistant_has(messages, "补上后半螺旋"):
            items = []
            for i in range(4, 8):
                a = i * 3.141592653589793 / 4
                d = 50 + i * 5
                items.append({"type": "circle", "cx": d * math.cos(a), "cy": d * math.sin(a), "r": 8})
            msg = {"role": "assistant", "content": "截图里发现蜗壳型线只有前半螺旋，我补上后半螺旋 4 个切圆。",
                   "tool_calls": [tool_call("r-v1", "draw_entities", {"items": items})]}
            return resp(msg, "tool_calls")
        if task == "pump2d" and not assistant_has(messages, "补上 3 个圆"):
            msg = {"role": "assistant", "content": "截图里发现剖视图缺少内腔/叶轮/轮毂 3 个圆，我补上 3 个圆。",
                   "tool_calls": [tool_call("r-p2d1", "draw_entities", {"items": [
                       {"type": "circle", "cx": 18, "cy": 0, "r": 45},
                       {"type": "circle", "cx": 0, "cy": 0, "r": 40},
                       {"type": "circle", "cx": 0, "cy": 0, "r": 12},
                   ]})]}
            return resp(msg, "tool_calls")
        if task:
            msg = {"role": "assistant",
                   "content": "已满意 ✅ 重新检查截图：图纸符合任务要求，无需进一步修改。",
                   "tool_calls": None}
            return resp(msg, "stop")
        if not history_has(messages, "垫圈"):
            msg = {"role": "assistant",
                   "content": "截图里发现泵壳与底座衔接处不够平滑，我加一个过渡垫圈。",
                   "tool_calls": [tool_call("r1", "create_primitive_3d",
                                {"kind": "cylinder", "x": 0, "y": 0, "z": 24, "r": 45, "h": 3, "color": "#f2c76e"})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant",
               "content": "已满意 ✅ 重新检查截图：模型比例协调、零件位置正确，无需进一步修改。",
               "tool_calls": None}
        return resp(msg, "stop")
    # 训练任务绘制剧本（故意留缺陷：2D 漏孔、3D 漏布尔，由多模态审阅补上）
    task = training_task(messages)
    if task == "flange2d":
        if not assistant_has(messages, "外圆和中心线"):
            msg = {"role": "assistant", "content": "我先画外圆和中心线（训练剧本：故意漏画 6 个孔，等审阅补上）。",
                   "tool_calls": [tool_call("t-f1", "draw_entities", {"items": [
                       {"type": "circle", "cx": 0, "cy": 0, "r": 50},
                       {"type": "line", "x1": -60, "y1": 0, "x2": 60, "y2": 0, "layer": "中心线"},
                       {"type": "line", "x1": 0, "y1": -60, "x2": 0, "y2": 60, "layer": "中心线"},
                   ]})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 法兰盘已绘制完成（外圆 + 中心线）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "bracket2d":
        if not assistant_has(messages, "矩形外框"):
            msg = {"role": "assistant", "content": "我先画矩形外框（训练剧本：故意漏画 2 个孔，等审阅补上）。",
                   "tool_calls": [tool_call("t-b1", "draw_entities", {"items": [
                       {"type": "rectangle", "x1": 0, "y1": 0, "x2": 100, "y2": 60},
                   ]})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 支架轮廓已绘制完成（矩形外框）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "plate3d":
        if not assistant_has(messages, "四孔板主体"):
            msg = {"role": "assistant", "content": "我先建底板和 4 个孔柱（四孔板主体，训练剧本：故意漏挖孔，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-p1", "create_primitive_3d", {"kind": "box", "x": 0, "y": 0, "z": 0, "dx": 100, "dy": 80, "dz": 10, "color": "#7fb2e8"}),
                       tool_call("t-p2", "create_primitive_3d", {"kind": "cylinder", "x": 35, "y": 25, "z": 0, "r": 8, "h": 20, "color": "#e8a07f"}),
                       tool_call("t-p3", "create_primitive_3d", {"kind": "cylinder", "x": -35, "y": 25, "z": 0, "r": 8, "h": 20, "color": "#e8a07f"}),
                       tool_call("t-p4", "create_primitive_3d", {"kind": "cylinder", "x": 35, "y": -25, "z": 0, "r": 8, "h": 20, "color": "#e8a07f"}),
                       tool_call("t-p5", "create_primitive_3d", {"kind": "cylinder", "x": -35, "y": -25, "z": 0, "r": 8, "h": 20, "color": "#e8a07f"}),
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-p6", "list_3d", {})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 四孔板已创建（底板 + 4 孔柱）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "sleeve3d":
        if not history_has(messages, "轴套主体"):
            msg = {"role": "assistant", "content": "我先建外圆柱和内孔柱（轴套主体，训练剧本：故意漏差集，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-s1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 40, "h": 60, "color": "#8fd3a8"}),
                       tool_call("t-s2", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 25, "h": 60, "color": "#e8a07f"}),
                   ]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 轴套已创建（外圆柱 + 内孔柱）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "impeller3d":
        if not assistant_has(messages, "叶轮主体"):
            blades = []
            for k in range(6):
                a = k * 3.141592653589793 / 3
                blades.append(tool_call(f"t-i{k+3}", "create_primitive_3d", {"kind": "box", "x": 35 * math.cos(a), "y": 35 * math.sin(a), "z": 0, "dx": 30, "dy": 6, "dz": 10, "color": "#f2c76e"}))
            msg = {"role": "assistant", "content": "我先建轮盘、中心孔柱和 6 片叶片（叶轮主体，训练剧本：故意漏布尔，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-i1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 60, "h": 8, "color": "#7fb2e8"}),
                       tool_call("t-i2", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 10, "h": 8, "color": "#e8a07f"}),
                       *blades,
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-i9", "list_3d", {})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 叶轮已创建（轮盘 + 中心孔柱 + 6 叶片）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "casing3d":
        if not assistant_has(messages, "泵壳主体"):
            msg = {"role": "assistant", "content": "我先建外壳、底座、两法兰和内腔柱（泵壳主体，训练剧本：故意漏内腔差集，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-c1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 70, "h": 50, "color": "#7fb2e8"}),
                       tool_call("t-c2", "create_primitive_3d", {"kind": "box", "x": 0, "y": 0, "z": -32, "dx": 160, "dy": 100, "dz": 15, "color": "#8fd3a8"}),
                       tool_call("t-c3", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": -90, "z": 0, "r": 25, "h": 12, "color": "#e8a07f"}),
                       tool_call("t-c4", "create_primitive_3d", {"kind": "cylinder", "x": 95, "y": 0, "z": 0, "r": 25, "h": 12, "color": "#e8a07f"}),
                       tool_call("t-c5", "create_primitive_3d", {"kind": "cylinder", "x": 18, "y": 0, "z": 0, "r": 45, "h": 50, "color": "#e88b8b"}),
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-c6", "list_3d", {})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 泵壳已创建（外壳 + 底座 + 两法兰 + 内腔柱）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "shaft3d":
        if not assistant_has(messages, "台阶轴主体"):
            msg = {"role": "assistant", "content": "我先建前 4 段台阶轴（台阶轴主体，训练剧本：故意漏第 5 段，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-sh1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 30, "h": 40, "color": "#7fb2e8"}),
                       tool_call("t-sh2", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 25, "h": 60, "color": "#8fd3a8"}),
                       tool_call("t-sh3", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 20, "h": 80, "color": "#f2c76e"}),
                       tool_call("t-sh4", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 15, "h": 50, "color": "#e88b8b"}),
                   ]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 台阶轴已创建（4 段）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "selfprime3d":
        if not assistant_has(messages, "自吸泵主体"):
            blades = []
            for k in range(5):
                a = k * 2 * 3.141592653589793 / 5
                blades.append(tool_call(f"t-sp{k+6}", "create_primitive_3d", {"kind": "box", "x": 50 * math.cos(a), "y": 50 * math.sin(a), "z": 0, "dx": 32, "dy": 6, "dz": 10, "color": "#f2c76e"}))
            msg = {"role": "assistant", "content": "我先建泵壳、储液腔、内腔、叶轮和 5 片叶片（自吸泵主体，训练剧本：故意漏泵轴与储液腔并集，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-sp1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 90, "h": 60, "color": "#7fb2e8"}),
                       tool_call("t-sp2", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 30, "z": 0, "r": 55, "h": 40, "color": "#8fd3a8"}),
                       tool_call("t-sp3", "create_primitive_3d", {"kind": "cylinder", "x": 20, "y": 0, "z": 0, "r": 65, "h": 60, "color": "#e88b8b"}),
                       tool_call("t-sp4", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 70, "h": 8, "color": "#8fd3a8"}),
                       tool_call("t-sp5", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 16, "h": 8, "color": "#e8a07f"}),
                       *blades,
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-sp11", "list_3d", {})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "自吸泵布尔"):
            ids = extract_ids(messages)
            if len(ids) >= 9:
                msg = {"role": "assistant", "content": "我把内腔、轮毂孔、叶片的布尔都补上（自吸泵布尔）。",
                       "tool_calls": [
                           tool_call("t-sp12", "boolean_3d", {"op": "cut", "a": ids[0], "b": [ids[2]]}),
                           tool_call("t-sp13", "boolean_3d", {"op": "cut", "a": ids[3], "b": [ids[4]]}),
                           tool_call("t-sp14", "boolean_3d", {"op": "fuse", "a": ids[3], "b": ids[5:10]}),
                       ]}
                return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 自吸泵已创建（泵壳 + 储液腔 + 叶轮 + 叶片，泵轴与储液腔并集待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "pumpboth":
        if not assistant_has(messages, "联合参数"):
            msg = {"role": "assistant", "content": "先算设计参数（联合参数）。",
                   "tool_calls": [tool_call("t-pb0", "pump_sizing", {"Q": 100, "H": 32, "n": 2900})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "联合模型主体"):
            blades = []
            for k in range(5):
                a = k * 2 * 3.141592653589793 / 5
                blades.append(tool_call(f"t-pb{k+6}", "create_primitive_3d", {"kind": "box", "x": 65 * math.cos(a), "y": 65 * math.sin(a), "z": 0, "dx": 40, "dy": 6, "dz": 12, "color": "#f2c76e"}))
            msg = {"role": "assistant", "content": "按参数建模（联合模型主体）。",
                   "tool_calls": [
                       tool_call("t-pb1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 98, "h": 50, "color": "#7fb2e8"}),
                       tool_call("t-pb2", "create_primitive_3d", {"kind": "cylinder", "x": 18, "y": 0, "z": 0, "r": 60, "h": 50, "color": "#e88b8b"}),
                       tool_call("t-pb3", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 92.5, "h": 8, "color": "#8fd3a8"}),
                       tool_call("t-pb4", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 16, "h": 8, "color": "#e8a07f"}),
                       tool_call("t-pb5", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 15.5, "h": 120, "color": "#b9a3f0"}),
                       *blades,
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-pb11", "list_3d", {})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "联合布尔"):
            ids = extract_ids(messages)
            if len(ids) >= 9:
                msg = {"role": "assistant", "content": "补上布尔（联合布尔）。",
                       "tool_calls": [
                           tool_call("t-pb12", "boolean_3d", {"op": "cut", "a": ids[0], "b": [ids[1]]}),
                           tool_call("t-pb13", "boolean_3d", {"op": "cut", "a": ids[2], "b": [ids[3]]}),
                           tool_call("t-pb14", "boolean_3d", {"op": "fuse", "a": ids[2], "b": ids[4:9]}),
                       ]}
                return resp(msg, "tool_calls")
        if not assistant_has(messages, "切换工作区"):
            msg = {"role": "assistant", "content": "切到 2D 工作区出图纸（切换工作区）。",
                   "tool_calls": [tool_call("t-pb15", "switch_workspace", {"ws": "2d"})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "联合图纸主体"):
            msg = {"role": "assistant", "content": "画主视图、图框、标题栏和明细栏表格（联合图纸主体）。",
                   "tool_calls": [tool_call("t-pb16", "draw_entities", {"items": [
                       {"type": "circle", "cx": 50, "cy": 175, "r": 45},
                       {"type": "circle", "cx": 50, "cy": 175, "r": 10},
                       {"type": "circle", "cx": 50, "cy": 175, "r": 8},
                       {"type": "rectangle", "x1": 0, "y1": 0, "x2": 420, "y2": 297},
                       {"type": "rectangle", "x1": 240, "y1": 0, "x2": 420, "y2": 56},
                       {"type": "rectangle", "x1": 0, "y1": -90, "x2": 180, "y2": -78},
                       {"type": "rectangle", "x1": 0, "y1": -102, "x2": 180, "y2": -90},
                       {"type": "rectangle", "x1": 0, "y1": -114, "x2": 180, "y2": -102},
                       {"type": "rectangle", "x1": 0, "y1": -126, "x2": 180, "y2": -114},
                       {"type": "rectangle", "x1": 0, "y1": -138, "x2": 180, "y2": -126},
                   ]})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 模型与图纸已完成（标注与文字待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "axialflow3d":
        if not assistant_has(messages, "轴流主体"):
            blades = []
            for k in range(6):
                a = k * 3.141592653589793 / 3
                blades.append(tool_call(f"t-ax{k+6}", "create_primitive_3d", {"kind": "box", "x": 85 * math.cos(a), "y": 85 * math.sin(a), "z": 60, "dx": 90, "dy": 8, "dz": 50, "color": "#f2c76e"}))
            guides = []
            for k in range(4):
                a = k * 3.141592653589793 / 2 + 0.3927
                guides.append(tool_call(f"t-axg{k}", "create_primitive_3d", {"kind": "box", "x": 95 * math.cos(a), "y": 95 * math.sin(a), "z": 30, "dx": 40, "dy": 6, "dz": 30, "color": "#8fd3a8"}))
            msg = {"role": "assistant", "content": "我先建泵壳、轮毂、6 片叶片和 4 片导叶（轴流主体，训练剧本：故意漏泵轴，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-ax1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 110, "h": 120, "color": "#7fb2e8"}),
                       tool_call("t-ax2", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 60, "r": 60, "h": 40, "color": "#e8a07f"}),
                       *blades, *guides,
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-ax16", "list_3d", {})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "轴流布尔"):
            ids = extract_ids(messages)
            if len(ids) >= 12:
                msg = {"role": "assistant", "content": "我把叶片、导叶的布尔都补上（轴流布尔）。",
                       "tool_calls": [
                           tool_call("t-ax17", "boolean_3d", {"op": "fuse", "a": ids[1], "b": ids[2:8]}),
                           tool_call("t-ax18", "boolean_3d", {"op": "fuse", "a": ids[0], "b": ids[8:12]}),
                       ]}
                return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 轴流泵已创建（泵壳 + 轮毂 + 6 叶片 + 4 导叶，泵轴待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "drawingchain2d":
        if not assistant_has(messages, "图纸集主体"):
            msg = {"role": "assistant", "content": "我先画图框、标题栏、三视图几何和明细栏表格（图纸集主体，训练剧本：故意漏标注与文字，等审阅补上）。",
                   "tool_calls": [tool_call("t-dc1", "draw_entities", {"items": [
                       {"type": "rectangle", "x1": 0, "y1": 0, "x2": 420, "y2": 297},
                       {"type": "rectangle", "x1": 240, "y1": 0, "x2": 420, "y2": 56},
                       {"type": "circle", "cx": 50, "cy": 175, "r": 45},
                       {"type": "circle", "cx": 50, "cy": 175, "r": 10},
                       {"type": "circle", "cx": 50, "cy": 175, "r": 8},
                       {"type": "rectangle", "x1": 5, "y1": -110, "x2": 95, "y2": -30},
                       {"type": "line", "x1": 50, "y1": -115, "x2": 50, "y2": -25, "layer": "中心线"},
                       {"type": "rectangle", "x1": 130, "y1": 145, "x2": 210, "y2": 225},
                       {"type": "circle", "cx": 170, "cy": 185, "r": 30},
                       {"type": "rectangle", "x1": 0, "y1": -90, "x2": 180, "y2": -78},
                       {"type": "rectangle", "x1": 0, "y1": -102, "x2": 180, "y2": -90},
                       {"type": "rectangle", "x1": 0, "y1": -114, "x2": 180, "y2": -102},
                       {"type": "rectangle", "x1": 0, "y1": -126, "x2": 180, "y2": -114},
                       {"type": "rectangle", "x1": 0, "y1": -138, "x2": 180, "y2": -126},
                   ]})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 图纸集已绘制完成（几何+表格，标注与文字待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "bom2d":
        if not assistant_has(messages, "明细栏主体"):
            rows = []
            for k in range(6):
                y1 = -12 * k
                rows.append({"type": "rectangle", "x1": 0, "y1": y1 - 12, "x2": 180, "y2": y1})
            msg = {"role": "assistant", "content": "我先画明细栏表格 6 行（明细栏主体，训练剧本：故意漏文字，等审阅补上）。",
                   "tool_calls": [tool_call("t-bm1", "draw_entities", {"items": rows})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 明细栏已绘制完成（表格，文字待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "doublesuction3d":
        if not assistant_has(messages, "双吸主体"):
            blades = []
            for k in range(12):
                a = (k % 6) * 3.141592653589793 / 3
                z = -4 if k < 6 else 4
                blades.append(tool_call(f"t-ds{k+7}", "create_primitive_3d", {"kind": "box", "x": 50 * math.cos(a), "y": 50 * math.sin(a), "z": z, "dx": 30, "dy": 6, "dz": 8, "color": "#f2c76e"}))
            msg = {"role": "assistant", "content": "我先建双吸叶轮两轮盘、轮毂、两排叶片、泵壳与两法兰（双吸主体，训练剧本：故意漏泵轴，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-ds1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 90, "h": 80, "color": "#7fb2e8"}),
                       tool_call("t-ds2", "create_primitive_3d", {"kind": "cylinder", "x": 20, "y": 0, "z": 0, "r": 65, "h": 80, "color": "#e88b8b"}),
                       tool_call("t-ds3", "create_primitive_3d", {"kind": "cylinder", "x": -50, "y": 0, "z": 0, "r": 30, "h": 20, "color": "#e8a07f"}),
                       tool_call("t-ds4", "create_primitive_3d", {"kind": "cylinder", "x": 50, "y": 0, "z": 0, "r": 30, "h": 20, "color": "#e8a07f"}),
                       tool_call("t-ds5", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": -4, "r": 70, "h": 8, "color": "#8fd3a8"}),
                       tool_call("t-ds6", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 4, "r": 70, "h": 8, "color": "#8fd3a8"}),
                       tool_call("t-ds7", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 20, "h": 16, "color": "#8fd3a8"}),
                       tool_call("t-ds8", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 16.5, "h": 16, "color": "#e8a07f"}),
                       *blades,
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-ds20", "list_3d", {})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "双吸布尔"):
            ids = extract_ids(messages)
            if len(ids) >= 18:  # 创建顺序：壳、腔、法兰1、法兰2、盘1、盘2、轮毂、孔、12 叶片
                msg = {"role": "assistant", "content": "我把内腔、中心孔、叶片的布尔都补上（双吸布尔）。",
                       "tool_calls": [
                           tool_call("t-ds21", "boolean_3d", {"op": "cut", "a": ids[0], "b": [ids[1]]}),
                           tool_call("t-ds22", "boolean_3d", {"op": "cut", "a": ids[4], "b": [ids[7]]}),
                           tool_call("t-ds23", "boolean_3d", {"op": "cut", "a": ids[5], "b": [ids[7]]}),
                           tool_call("t-ds24", "boolean_3d", {"op": "fuse", "a": ids[4], "b": ids[8:14]}),
                           tool_call("t-ds25", "boolean_3d", {"op": "fuse", "a": ids[5], "b": ids[14:20]}),
                       ]}
                return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 双吸泵已创建（叶轮双盘 + 两排叶片 + 泵壳双法兰，泵轴待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "threeview2d":
        if not assistant_has(messages, "三视图主体"):
            msg = {"role": "assistant", "content": "我先画主视图的三个圆（三视图主体，训练剧本：故意漏俯视图轮廓与侧视图叶轮圆，等审阅补上）。",
                   "tool_calls": [tool_call("t-tv1", "draw_entities", {"items": [
                       {"type": "circle", "cx": 50, "cy": 175, "r": 45},
                       {"type": "circle", "cx": 50, "cy": 175, "r": 10},
                       {"type": "circle", "cx": 50, "cy": 175, "r": 8},
                   ]})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 三视图已绘制完成（主视图，俯侧视图待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "drawingframe2d":
        if not assistant_has(messages, "图框主体"):
            msg = {"role": "assistant", "content": "我先画图框和标题栏（图框主体，训练剧本：故意漏标题栏文字，等审阅补上）。",
                   "tool_calls": [tool_call("t-df1", "draw_entities", {"items": [
                       {"type": "rectangle", "x1": 0, "y1": 0, "x2": 420, "y2": 297},
                       {"type": "rectangle", "x1": 240, "y1": 0, "x2": 420, "y2": 56},
                   ]})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 图框与标题栏已绘制完成（文字待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "pumpdrawing2d":
        if not assistant_has(messages, "剖视图主体"):
            msg = {"role": "assistant", "content": "我先画剖视图的 4 个圆和中心线（剖视图主体，训练剧本：故意漏尺寸标注，等审阅补上）。",
                   "tool_calls": [tool_call("t-dw1", "draw_entities", {"items": [
                       {"type": "circle", "cx": 0, "cy": 0, "r": 70},
                       {"type": "circle", "cx": 18, "cy": 0, "r": 45},
                       {"type": "circle", "cx": 0, "cy": 0, "r": 40},
                       {"type": "circle", "cx": 0, "cy": 0, "r": 12},
                       {"type": "line", "x1": 0, "y1": -90, "x2": 0, "y2": 90, "layer": "中心线"},
                   ]})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 水泵剖视图已绘制完成（几何部分，标注待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "volute2d":
        if not assistant_has(messages, "蜗壳主体"):
            items = [{"type": "circle", "cx": 0, "cy": 0, "r": 40},
                     {"type": "line", "x1": 0, "y1": -100, "x2": 0, "y2": 100, "layer": "中心线"}]
            for i in range(4):
                a = i * 3.141592653589793 / 4
                d = 50 + i * 5
                items.append({"type": "circle", "cx": d * math.cos(a), "cy": d * math.sin(a), "r": 8})
            msg = {"role": "assistant", "content": "我先画基圆、中心线和前半螺旋 4 个切圆（蜗壳主体，训练剧本：故意漏后半螺旋，等审阅补上）。",
                   "tool_calls": [tool_call("t-v1", "draw_entities", {"items": items})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 蜗壳型线已绘制完成（基圆 + 前半螺旋）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "pump2d":
        if not assistant_has(messages, "外轮廓"):
            msg = {"role": "assistant", "content": "我先画泵壳外轮廓圆和中心线（训练剧本：故意漏内腔/叶轮/轮毂 3 个圆，等审阅补上）。",
                   "tool_calls": [tool_call("t-p2d1", "draw_entities", {"items": [
                       {"type": "circle", "cx": 0, "cy": 0, "r": 70},
                       {"type": "line", "x1": 0, "y1": -90, "x2": 0, "y2": 90, "layer": "中心线"},
                   ]})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 水泵剖视图已绘制完成（外轮廓 + 中心线）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "minipump3d":
        if not assistant_has(messages, "整机主体"):
            blades = []
            for k in range(6):
                a = k * 3.141592653589793 / 3
                blades.append(tool_call(f"t-mp{k+5}", "create_primitive_3d", {"kind": "box", "x": 35 * math.cos(a), "y": 35 * math.sin(a), "z": 0, "dx": 30, "dy": 6, "dz": 10, "color": "#f2c76e"}))
            msg = {"role": "assistant", "content": "我先建泵壳、叶轮和 6 片叶片（整机主体，训练剧本：故意漏泵轴与布尔，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-mp1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 70, "h": 50, "color": "#7fb2e8"}),
                       tool_call("t-mp2", "create_primitive_3d", {"kind": "cylinder", "x": 18, "y": 0, "z": 0, "r": 45, "h": 50, "color": "#e88b8b"}),
                       tool_call("t-mp3", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 60, "h": 8, "color": "#8fd3a8"}),
                       tool_call("t-mp4", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 30.5, "h": 8, "color": "#e8a07f"}),
                       *blades,
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-mp11", "list_3d", {})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "整机布尔"):
            ids = extract_ids(messages)
            if len(ids) >= 10:  # 创建顺序：外壳、内腔、轮盘、轮毂孔、6 叶片
                msg = {"role": "assistant", "content": "我把泵壳内腔、叶轮中心孔、叶片合并的布尔都补上（整机布尔）。",
                       "tool_calls": [
                           tool_call("t-mp12", "boolean_3d", {"op": "cut", "a": ids[0], "b": [ids[1]]}),
                           tool_call("t-mp13", "boolean_3d", {"op": "cut", "a": ids[2], "b": [ids[3]]}),
                           tool_call("t-mp14", "boolean_3d", {"op": "fuse", "a": ids[2], "b": ids[4:10]}),
                       ]}
                return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 微型泵已装配完成（泵壳 + 叶轮 + 叶片，泵轴待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task == "multistage3d":
        if not assistant_has(messages, "两级主体"):
            blades = []
            for k in range(12):
                a = (k % 6) * 3.141592653589793 / 3
                blades.append(tool_call(f"t-ms{k+9}", "create_primitive_3d", {"kind": "box", "x": 35 * math.cos(a), "y": 35 * math.sin(a), "z": 0 if k < 6 else 50, "dx": 30, "dy": 6, "dz": 10, "color": "#f2c76e"}))
            msg = {"role": "assistant", "content": "我先建两级泵壳、两级叶轮和 12 片叶片（两级主体，训练剧本：故意漏长轴与轴承座，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-ms1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 70, "h": 50, "color": "#7fb2e8"}),
                       tool_call("t-ms2", "create_primitive_3d", {"kind": "cylinder", "x": 18, "y": 0, "z": 0, "r": 45, "h": 50, "color": "#e88b8b"}),
                       tool_call("t-ms3", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 60, "h": 8, "color": "#8fd3a8"}),
                       tool_call("t-ms4", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 30.5, "h": 8, "color": "#e8a07f"}),
                       *blades[:6],
                       tool_call("t-ms5", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 50, "r": 70, "h": 50, "color": "#7fb2e8"}),
                       tool_call("t-ms6", "create_primitive_3d", {"kind": "cylinder", "x": 18, "y": 0, "z": 50, "r": 45, "h": 50, "color": "#e88b8b"}),
                       tool_call("t-ms7", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 50, "r": 60, "h": 8, "color": "#8fd3a8"}),
                       tool_call("t-ms8", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 50, "r": 30.5, "h": 8, "color": "#e8a07f"}),
                       *blades[6:],
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-ms21", "list_3d", {})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "两级布尔"):
            ids = extract_ids(messages)
            if len(ids) >= 16:  # 创建顺序：壳1、腔1、盘1、孔1、叶1×6、壳2、腔2、盘2、孔2、叶2×6
                msg = {"role": "assistant", "content": "我把两级泵壳内腔、叶轮中心孔、叶片合并的布尔都补上（两级布尔）。",
                       "tool_calls": [
                           tool_call("t-ms22", "boolean_3d", {"op": "cut", "a": ids[0], "b": [ids[1]]}),
                           tool_call("t-ms23", "boolean_3d", {"op": "cut", "a": ids[2], "b": [ids[3]]}),
                           tool_call("t-ms24", "boolean_3d", {"op": "fuse", "a": ids[2], "b": ids[4:10]}),
                           tool_call("t-ms25", "boolean_3d", {"op": "cut", "a": ids[10], "b": [ids[11]]}),
                           tool_call("t-ms26", "boolean_3d", {"op": "cut", "a": ids[12], "b": [ids[13]]}),
                           tool_call("t-ms27", "boolean_3d", {"op": "fuse", "a": ids[12], "b": ids[14:20]}),
                       ]}
                return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 两级泵已装配完成（两级泵壳 + 叶轮 + 叶片，长轴与轴承座待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    if task in ("pumpduty3d", "conversation3d"):
        if not assistant_has(messages, "设计参数"):
            msg = {"role": "assistant", "content": "先用泵设计计算确定尺寸（设计参数）。",
                   "tool_calls": [tool_call("t-pd0", "pump_sizing", {"Q": 100, "H": 32, "n": 2900})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "商用泵主体"):
            blades = []
            for k in range(5):
                a = k * 2 * 3.141592653589793 / 5
                blades.append(tool_call(f"t-pd{k+6}", "create_primitive_3d", {"kind": "box", "x": 65 * math.cos(a), "y": 65 * math.sin(a), "z": 0, "dx": 40, "dy": 6, "dz": 12, "color": "#f2c76e"}))
            msg = {"role": "assistant", "content": "按设计参数建模：泵壳 r98、叶轮盘 r92.5、轮毂孔 r16（商用泵主体，训练剧本：故意漏泵轴与布尔，等审阅补上）。",
                   "tool_calls": [
                       tool_call("t-pd1", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 98, "h": 50, "color": "#7fb2e8"}),
                       tool_call("t-pd2", "create_primitive_3d", {"kind": "cylinder", "x": 18, "y": 0, "z": 0, "r": 60, "h": 50, "color": "#e88b8b"}),
                       tool_call("t-pd3", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 92.5, "h": 8, "color": "#8fd3a8"}),
                       tool_call("t-pd4", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 0, "r": 16, "h": 8, "color": "#e8a07f"}),
                       *blades,
                   ]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "查询实体"):
            msg = {"role": "assistant", "content": "查询实体 id。", "tool_calls": [tool_call("t-pd11", "list_3d", {})]}
            return resp(msg, "tool_calls")
        if not assistant_has(messages, "商用泵布尔"):
            ids = extract_ids(messages)
            if len(ids) >= 9:  # 创建顺序：泵壳、内腔、叶轮盘、轮毂孔、5 叶片
                msg = {"role": "assistant", "content": "我把内腔、轮毂孔、叶片的布尔都补上（商用泵布尔）。",
                       "tool_calls": [
                           tool_call("t-pd12", "boolean_3d", {"op": "cut", "a": ids[0], "b": [ids[1]]}),
                           tool_call("t-pd13", "boolean_3d", {"op": "cut", "a": ids[2], "b": [ids[3]]}),
                           tool_call("t-pd14", "boolean_3d", {"op": "fuse", "a": ids[2], "b": ids[4:9]}),
                       ]}
                return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 商用泵已创建（泵壳 + 叶轮 + 5 叶片 + 轮毂孔，泵轴待审阅补上）。", "tool_calls": None}
        return resp(msg, "stop")
    # 空操作剧本：只查询不画图（验证「无可见变化」提示）
    if "空操作" in last_plain_ask(messages):
        if not history_has(messages, "查询完成"):
            msg = {"role": "assistant", "content": "查询一下图纸状态。",
                   "tool_calls": [tool_call("cq1", "query_drawing", {"what": "summary"})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 查询完成，图纸没有变化。", "tool_calls": None}
        return resp(msg, "stop")
    # 2D 制图剧本（仅看最后一次普通提问）
    if "矩形" in last_plain_ask(messages):
        if rect_rounds(messages) == 0:
            msg = {"role": "assistant", "content": "好的，在 2D 图纸上画一个矩形。",
                   "tool_calls": [tool_call("c2d1", "draw_entities",
                                {"items": [{"type": "rectangle", "x1": 0, "y1": 0, "x2": 100, "y2": 60}]})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 矩形已绘制（100×60）。", "tool_calls": None}
        return resp(msg, "stop")
    # 死循环剧本（仅看最后一次普通提问）
    if "死循环" in last_plain_ask(messages):
        msg = {"role": "assistant", "content": "继续检查模型状态。",
               "tool_calls": [tool_call("c-loop", "list_3d", {})]}
        return resp(msg, "tool_calls")
    ids = extract_ids(messages)
    ps = pump_stage(messages)
    asks = plain_ask_count(messages)
    # 水泵完成后的追加提问：加一个小零件（一轮工具后收尾）
    if asks >= 2 and history_has(messages, "水泵三维模型已完成"):
        if extra_rounds(messages) == 0:
            msg = {"role": "assistant", "content": "好的，给模型加一个小零件。",
                   "tool_calls": [tool_call("c10", "create_primitive_3d",
                                {"kind": "cylinder", "x": 60, "y": 40, "z": 0, "r": 6, "h": 20, "color": "#b9a3f0"})]}
            return resp(msg, "tool_calls")
        msg = {"role": "assistant", "content": "✅ 已添加小零件（Φ12×20 的定位柱）。", "tool_calls": None}
        return resp(msg, "stop")
    # 水泵剧本（1~4 阶段，ps>=5 收尾）
    if ps == 1:
        msg = {
            "role": "assistant",
            "content": "我来分步建模：先建底座、泵壳和两个法兰。",
            "tool_calls": [
                tool_call("c1", "create_primitive_3d", {"kind": "box", "x": 0, "y": 0, "z": 0, "dx": 120, "dy": 90, "dz": 25, "color": "#7fb2e8"}),
                tool_call("c2", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": 0, "z": 25, "r": 40, "h": 70, "color": "#8fd3a8"}),
                tool_call("c3", "create_primitive_3d", {"kind": "cylinder", "x": 0, "y": -85, "z": 25, "r": 20, "h": 14, "color": "#e8a07f"}),
                tool_call("c4", "create_primitive_3d", {"kind": "cylinder", "x": 85, "y": 0, "z": 55, "r": 18, "h": 14, "color": "#e8a07f"}),
            ],
        }
        return resp(msg, "tool_calls")
    if ps == 2:
        msg = {"role": "assistant", "content": "查询当前模型，获取实体 id。", "tool_calls": [tool_call("c5", "list_3d", {})]}
        return resp(msg, "tool_calls")
    if ps == 3:
        if len(ids) < 4:
            msg = {"role": "assistant", "content": "实体尚未创建完成，重试查询。", "tool_calls": [tool_call("c6", "list_3d", {})]}
            return resp(msg, "tool_calls")
        shell, in_f, out_f = ids[1], ids[2], ids[3]
        msg = {"role": "assistant", "content": "把泵壳与两个法兰合并。",
               "tool_calls": [tool_call("c7", "boolean_3d", {"op": "fuse", "a": shell, "b": [in_f, out_f]})]}
        return resp(msg, "tool_calls")
    if ps == 4:
        if len(ids) < 5:
            msg = {"role": "assistant", "content": "继续查询。", "tool_calls": [tool_call("c8", "list_3d", {})]}
            return resp(msg, "tool_calls")
        base, group = ids[0], ids[-1]
        msg = {"role": "assistant", "content": "把底座并入泵体。",
               "tool_calls": [tool_call("c9", "boolean_3d", {"op": "fuse", "a": base, "b": [group]})]}
        return resp(msg, "tool_calls")
    # 水泵收尾
    msg = {
        "role": "assistant",
        "content": "✅ 水泵三维模型已完成！\n"
                   "· 底座（120×90×25）与泵壳（Φ80×70）、进出水法兰已合并为一个整体\n"
                   "· 采用并集布尔运算，共 1 个可见实体\n"
                   "· 可以左键旋转查看、右键平移、滚轮缩放；如需叶轮和轴可继续让我添加",
    }
    return resp(msg, "stop")

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()
    def do_POST(self):
        ln = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(ln) or b"{}")
        except Exception:
            body = {}
        messages = body.get("messages", [])
        try:
            with open("/tmp/mock-debug.log", "a", encoding="utf8") as f:
                f.write("=== 请求 ===\n")
                for m in messages:
                    f.write(f"[{m.get('role')}] {str(m.get('content'))[:200]}\n")
                    for tc in (m.get("tool_calls") or []):
                        f.write(f"   tool_call: {tc['function']['name']} {str(tc['function']['arguments'])[:150]}\n")
                f.write(f"提取 ids: {extract_ids(messages)}\n\n")
        except Exception:
            pass
        # 剧本阶段 = 已发出的工具调用轮数 + 1
        tool_rounds = sum(1 for m in messages if m.get("role") == "assistant" and m.get("tool_calls"))
        stage = tool_rounds + 1
        payload = json.dumps(build_stage(stage, messages, "tools" in body), ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

if __name__ == "__main__":
    print(f"Mock AI 服务器监听 http://localhost:{PORT} ...")
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
