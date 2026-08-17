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

def build_stage(stage, messages, has_tools):
    if not has_tools:
        msg = {"role": "assistant",
               "content": "✅ 任务阶段性总结：已按你的要求完成零件的创建与合并，当前模型保留在图"
                          "纸中。你可以回复「继续」让我完成剩余部分。",
               "tool_calls": None}
        return resp(msg, "stop")
    # 死循环剧本：用户消息含「死循环」时，每轮发出完全相同的工具调用（验证防死循环）
    user_text = "".join(m.get("content", "") for m in messages if m.get("role") == "user")
    if "死循环" in user_text:
        msg = {"role": "assistant", "content": "继续检查模型状态。",
               "tool_calls": [tool_call("c-loop", "list_3d", {})]}
        return resp(msg, "tool_calls")
    ids = extract_ids(messages)
    # 剧本（模拟一个会分步建模的 CAD 助手）
    if stage == 1:
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
    if stage == 2:
        msg = {"role": "assistant", "content": "查询当前模型，获取实体 id。", "tool_calls": [tool_call("c5", "list_3d", {})]}
        return resp(msg, "tool_calls")
    if stage == 3:
        # fuse 泵壳 + 两法兰（ids: [底座, 泵壳, 进水法兰, 出水法兰]）
        if len(ids) < 4:
            msg = {"role": "assistant", "content": "实体尚未创建完成，重试查询。", "tool_calls": [tool_call("c6", "list_3d", {})]}
            return resp(msg, "tool_calls")
        shell, in_f, out_f = ids[1], ids[2], ids[3]
        msg = {"role": "assistant", "content": "把泵壳与两个法兰合并。",
               "tool_calls": [tool_call("c7", "boolean_3d", {"op": "fuse", "a": shell, "b": [in_f, out_f]})]}
        return resp(msg, "tool_calls")
    if stage == 4:
        # fuse 底座 + 泵体组（泵体组 id 是上一轮结果，取最后一个 id）
        if len(ids) < 5:
            msg = {"role": "assistant", "content": "继续查询。", "tool_calls": [tool_call("c8", "list_3d", {})]}
            return resp(msg, "tool_calls")
        base, group = ids[0], ids[-1]
        msg = {"role": "assistant", "content": "把底座并入泵体。",
               "tool_calls": [tool_call("c9", "boolean_3d", {"op": "fuse", "a": base, "b": [group]})]}
        return resp(msg, "tool_calls")
    # 最终总结（无工具调用）
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
