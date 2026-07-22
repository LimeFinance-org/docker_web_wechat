#!/usr/bin/env python3
"""
xwechat-xpra 消息通知守护进程

工作原理：
  1. 每 1.5 秒用 wmctrl 查询所有 X11 窗口标题
  2. 找到微信窗口，解析标题里的未读消息数
     微信 Linux 客户端在收到消息时窗口标题会变成 "微信(3)" 等形式
  3. 通过 HTTP 端点 :8081/status 暴露当前状态（JSON）
  4. 浏览器端油猴脚本轮询此端点，触发 Notification API

设计取舍：
  - 不依赖微信主动调用系统通知（dbus/libnotify），可靠性更高
  - 不依赖容器内的通知守护进程
  - 仅依赖 X11 窗口标题这一稳定的 GUI 行为
"""

import http.server
import json
import re
import subprocess
import threading
import time
import os
import sys

# 全局状态
STATE = {
    "unread": 0,                  # 当前未读消息数
    "title": "",                  # 微信窗口最新标题
    "app_running": False,         # 微信进程是否在运行
    "last_change_ts": time.time(),
    "last_notify_ts": 0,          # 上次通知的时间（避免重复打扰）
}

# 微信窗口标题匹配未读数的多种模式（兼容不同版本）
UNREAD_PATTERNS = [
    re.compile(r'\((\d+)\s*条?未?读?\)'),       # 微信(3) / 微信(3条未读)
    re.compile(r'\((\d+)\)'),                    # (3) 简单形式
    re.compile(r'(\d+)\s*条未读'),               # 3条未读
    re.compile(r'(\d+)\s*条新消息'),             # 3条新消息
    re.compile(r'未读\s*[：:]?\s*(\d+)'),        # 未读: 3
    re.compile(r'\[(\d+)\]'),                    # [3]
]


def get_wechat_window_title():
    """用 wmctrl 查询微信窗口标题，找不到返回空字符串"""
    try:
        result = subprocess.run(
            ["wmctrl", "-l", "-x"],
            capture_output=True, text=True, timeout=2,
            env={**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":100")}
        )
        for line in result.stdout.splitlines():
            # wmctrl -l 辗出格式：
            # 0x01200004  0 wechat.wechat   xwechat  微信
            # 最后一列是窗口标题
            parts = line.split(None, 3)
            if len(parts) < 4:
                continue
            title = parts[3]
            # 同时匹配窗口类名和标题，覆盖中英文环境
            if ("wechat" in parts[2].lower()) or ("微信" in title) or ("WeChat" in title):
                return title.strip()
        return ""
    except FileNotFoundError:
        sys.stderr.write("[notify-watcher] wmctrl 未安装，请检查 Dockerfile\n")
        return ""
    except subprocess.TimeoutExpired:
        return ""
    except Exception as e:
        sys.stderr.write(f"[notify-watcher] 查询窗口失败: {e}\n")
        return ""


def is_wechat_running():
    """检查微信进程是否在运行"""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "/usr/bin/wechat"],
            capture_output=True, timeout=2,
        )
        return result.returncode == 0
    except Exception:
        return True  # 出错时假设在运行，避免误报


def parse_unread_count(title):
    """从微信窗口标题解析未读消息数"""
    if not title:
        return 0
    for pattern in UNREAD_PATTERNS:
        match = pattern.search(title)
        if match:
            try:
                count = int(match.group(1))
                if 0 < count < 9999:  # 合理范围校验
                    return count
            except ValueError:
                continue
    return 0


def watch_loop():
    """监听主循环"""
    sys.stdout.write("[notify-watcher] 监听已启动\n")
    sys.stdout.flush()

    while True:
        try:
            running = is_wechat_running()
            STATE["app_running"] = running

            if not running:
                # 微信未运行，重置状态
                if STATE["unread"] > 0 or STATE["title"]:
                    STATE["unread"] = 0
                    STATE["title"] = ""
                    STATE["last_change_ts"] = time.time()
                time.sleep(3)
                continue

            title = get_wechat_window_title()
            unread = parse_unread_count(title)

            # 状态变化时记录
            if unread != STATE["unread"] or title != STATE["title"]:
                STATE["unread"] = unread
                STATE["title"] = title
                STATE["last_change_ts"] = time.time()
                sys.stdout.write(
                    f"[notify-watcher] 状态更新: unread={unread}, title={title!r}\n"
                )
                sys.stdout.flush()

        except Exception as e:
            sys.stderr.write(f"[notify-watcher] 循环异常: {e}\n")

        time.sleep(1.5)


class StatusHandler(http.server.BaseHTTPRequestHandler):
    """暴露 /status 端点供浏览器轮询"""

    def do_GET(self):
        if self.path == "/status" or self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            # 允许 Xpra HTML5 页面跨域访问（8080 端口）
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            payload = {
                "unread": STATE["unread"],
                "title": STATE["title"],
                "app_running": STATE["app_running"],
                "timestamp": time.time(),
                "last_change": STATE["last_change_ts"],
            }
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        elif self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        # 处理 CORS 预检请求
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, *args):
        pass  # 静默访问日志


def main():
    port = int(os.environ.get("NOTIFY_PORT", "19892"))
    host = os.environ.get("NOTIFY_HOST", "127.0.0.1")  # 仅监听容器内，由 Nginx 反代对外

    # 启动监听线程
    threading.Thread(target=watch_loop, daemon=True).start()

    # 启动 HTTP 服务
    server = http.server.HTTPServer((host, port), StatusHandler)
    sys.stdout.write(f"[notify-watcher] HTTP 服务监听 {host}:{port}/status\n")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stdout.write("[notify-watcher] 退出\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
