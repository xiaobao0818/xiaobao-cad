#!/usr/bin/env python3
"""小宝CAD 测试用 Mock AI 服务器 —— 模拟 DeepSeek API 的工具调用对话流。
按"助手已发出的工具调用轮数"推进剧本，从历史 tool 消息中提取实体 id，
与真实大模型的行为一致（先创建→查询→布尔→总结）。
"""
import json, re
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
    """从已执行的 tool 结果消息中提取实体 id（顺序保持）"""
    ids = []
    for m in messages:
        if m.get("role") == "tool" and isinstance(m.get("content"), str):
            ids.extend(re.findall(r"id=([A-Za-z0-9]+)", m["content"]))
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

def build_stage(stage, messages, has_tools):
    if not has_tools:
        msg = {"role": "assistant",
               "content": "✅ 任务阶段性总结：已按你的要求完成零件的创建与合并，当前模型保留在图"
                          "纸中。你可以回复「继续」让我完成剩余部分。",
               "tool_calls": None}
        return resp(msg, "stop")
    # 多模态审阅剧本：第一轮发现问题并修改，第二轮表示满意
    if last_user_is_review(messages):
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
