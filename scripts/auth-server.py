#!/usr/bin/env python3
"""
xwechat-xpra 登录认证服务

职责：
  1. POST /_auth        —— 接收登录表单（username/password），校验通过后下发签名 cookie
  2. GET  /_check       —— 供 Nginx auth_request 子请求校验当前请求的 cookie 是否有效
  3. POST /_logout      —— 清除登录 cookie

设计：
  - 仅监听 127.0.0.1:19893，不对外暴露，由 Nginx 反代
  - cookie 使用 HMAC-SHA256 签名，密钥由 start.sh 启动时随机生成并写入环境变量
  - cookie 内容：过期时间戳 + HMAC 签名，服务端无状态
  - 仅依赖 Python 标准库，无第三方依赖
"""

import http.server
import http.cookies
import json
import os
import sys
import time
import hmac
import hashlib
import base64
import urllib.parse
import subprocess
import uuid
from http import HTTPStatus

# ============== 配置 ==============
PORT = int(os.environ.get("AUTH_PORT", "19893"))
HOST = os.environ.get("AUTH_HOST", "127.0.0.1")

# 账号密码（由 start.sh 注入）
USERNAME = os.environ.get("WEB_AUTH_USER", "baby")
PASSWORD = os.environ.get("WEB_AUTH_PASSWORD", "caijing...")

# HMAC 密钥（由 start.sh 启动时随机生成）
SECRET = os.environ.get("AUTH_SECRET", "")
if not SECRET:
    SECRET = hashlib.sha256(os.urandom(32)).hexdigest()
    os.environ["AUTH_SECRET"] = SECRET

COOKIE_NAME = "xwechat_session"
COOKIE_MAX_AGE = 7 * 24 * 3600  # 7 天

# ============== Cookie 签名工具 ==============


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def sign_token(expire_ts: int) -> str:
    """生成签名 token：expire.b64(expire).hmac"""
    payload = str(expire_ts).encode()
    sig = hmac.new(SECRET.encode(), payload, hashlib.sha256).digest()
    return f"{expire_ts}.{_b64(sig)}"


def verify_token(token: str) -> bool:
    """校验 token 签名 + 过期时间"""
    try:
        expire_str, sig_b64 = token.rsplit(".", 1)
        expire_ts = int(expire_str)
        if expire_ts < time.time():
            return False
        expected_sig = hmac.new(SECRET.encode(), expire_str.encode(), hashlib.sha256).digest()
        return hmac.compare_digest(_b64(expected_sig), sig_b64)
    except (ValueError, AttributeError):
        return False


def parse_cookie(cookie_header: str):
    """从 Cookie 头解析出 session token"""
    if not cookie_header:
        return None
    c = http.cookies.SimpleCookie()
    try:
        c.load(cookie_header)
    except Exception:
        return None
    morsel = c.get(COOKIE_NAME)
    return morsel.value if morsel else None


def build_set_cookie(token: str) -> str:
    """构造 Set-Cookie 头（HttpOnly + SameSite=Lax）"""
    return (
        f"{COOKIE_NAME}={token}; Path=/; Max-Age={COOKIE_MAX_AGE}; "
        f"HttpOnly; SameSite=Lax"
    )


def build_clear_cookie() -> str:
    return f"{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"


# ============== HTTP 处理器 ==============


class AuthHandler(http.server.BaseHTTPRequestHandler):
    server_version = "xwechat-auth/1.0"

    def _json(self, code: int, payload: dict, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for k, v in extra_headers:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str):
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        # Nginx auth_request 子请求：校验 cookie
        if self.path == "/_check":
            token = parse_cookie(self.headers.get("Cookie", ""))
            if token and verify_token(token):
                # 通知 Nginx 放行
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                # 通知 Nginx 拦截（Nginx 会把 401 转给 error_page 处理）
                self.send_response(HTTPStatus.UNAUTHORIZED)
                self.send_header("Content-Length", "0")
                self.end_headers()
            return

        # 登出（清除 cookie 并跳转登录页）
        if self.path == "/_logout":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/login?loggedout=1")
            self.send_header("Set-Cookie", build_clear_cookie())
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        # 剪贴板同步（浏览器读取 X11 剪贴板）
        if self.path == "/_clipboard-text":
            self._handle_clipboard_text()
            return

        # 文件下载列表
        if self.path == "/_list-downloads":
            self._handle_list_downloads()
            return

        # 文件下载
        if self.path.startswith("/_download-file"):
            self._handle_download_file()
            return

        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    # ══════════ 剪贴板同步（GET）══════════
    def _handle_clipboard_text(self):
        """读取 X11 剪贴板文本，供浏览器同步到系统剪贴板"""
        token = parse_cookie(self.headers.get("Cookie", ""))
        if not (token and verify_token(token)):
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "未登录"})
            return
        try:
            result = subprocess.run(
                ["xclip", "-o", "-selection", "clipboard"],
                capture_output=True, text=True, timeout=2,
                env={"DISPLAY": ":10"},
            )
            text = result.stdout if result.returncode == 0 else ""
            self._json(HTTPStatus.OK, {"ok": True, "text": text})
        except Exception as e:
            self._json(HTTPStatus.OK, {"ok": True, "text": ""})

    # ══════════ 文件下载列表（GET）══════════
    def _handle_list_downloads(self):
        """列出下载目录中的最近文件"""
        token = parse_cookie(self.headers.get("Cookie", ""))
        if not (token and verify_token(token)):
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "未登录"})
            return
        dirs = ["/root/downloads", "/root/xwechat_files", "/tmp/wechat-paste"]
        files = []
        for d in dirs:
            if not os.path.isdir(d):
                continue
            for dirpath, dirnames, filenames in os.walk(d):
                for fn in filenames:
                    fp = os.path.join(dirpath, fn)
                    try:
                        st = os.stat(fp)
                        files.append({
                            "name": fn,
                            "path": fp,
                            "size": st.st_size,
                            "mtime": int(st.st_mtime),
                        })
                    except OSError:
                        continue
        files.sort(key=lambda f: f["mtime"], reverse=True)
        self._json(HTTPStatus.OK, {"ok": True, "files": files[:30]})

    # ══════════ 文件下载服务（GET）══════════
    def _handle_download_file(self):
        """提供文件下载"""
        token = parse_cookie(self.headers.get("Cookie", ""))
        if not (token and verify_token(token)):
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "未登录"})
            return
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        filepath = query.get("path", [None])[0]
        if not filepath or not os.path.isfile(filepath):
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "文件不存在"})
            return
        allowed = ["/root/downloads", "/root/xwechat_files", "/tmp/wechat-paste"]
        real = os.path.realpath(filepath)
        if not any(real.startswith(os.path.realpath(d)) for d in allowed):
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "无权访问"})
            return
        filename = os.path.basename(filepath)
        fsize = os.path.getsize(filepath)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition",
                         f'attachment; filename="{urllib.parse.quote(filename)}"')
        self.send_header("Content-Length", str(fsize))
        self.end_headers()
        with open(filepath, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def do_POST(self):
        # 登录表单提交
        if self.path == "/_auth":
            self._handle_login()
            return
        if self.path == "/_logout":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/login?loggedout=1")
            self.send_header("Set-Cookie", build_clear_cookie())
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # 文件上传（用于 Ctrl+V 粘贴文件到微信）
        if self.path == "/_upload-file":
            self._handle_upload_file()
            return
        # 输入法文本输入（用于 IME 中文输入到微信对话框）
        if self.path == "/_type-text":
            self._handle_type_text()
            return
        # 文件删除（下载后清理临时文件）
        if self.path == "/_delete-file":
            self._handle_delete_file()
            return
        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    # ══════════ 文件删除（POST）══════════
    def _handle_delete_file(self):
        """删除下载目录中的临时文件"""
        token = parse_cookie(self.headers.get("Cookie", ""))
        if not (token and verify_token(token)):
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "未登录"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length)) if length > 0 else {}
        except:
            body = {}
        filepath = body.get("path", "")
        if not filepath or not os.path.isfile(filepath):
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "文件不存在"})
            return
        # 安全：只允许删除 download 和 temp 目录中的文件，不允许删除 xwechat_files
        allowed = ["/root/downloads", "/tmp/wechat-paste"]
        real = os.path.realpath(filepath)
        if not any(real.startswith(os.path.realpath(d)) for d in allowed):
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "无权删除"})
            return
        try:
            os.remove(filepath)
            self._json(HTTPStatus.OK, {"ok": True})
        except OSError as e:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(e)})

    def _handle_type_text(self):
        """接收输入法组合完成的文本，用 xdotool type 输入到微信对话框"""
        token = parse_cookie(self.headers.get("Cookie", ""))
        if not (token and verify_token(token)):
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "未登录"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 1024 * 1024:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "文本长度不合法"})
            return

        raw = self.rfile.read(length)
        try:
            data = json.loads(raw)
            text = data.get("text", "")
        except (json.JSONDecodeError, AttributeError):
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "JSON 解析失败"})
            return

        if not text or not isinstance(text, str):
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "文本为空"})
            return

        if len(text) > 500:
            text = text[:500]

        display = os.environ.get("DISPLAY", ":100")
        env = {**os.environ, "DISPLAY": display}

        # 使用 xdotool type（XKB 修复后应能正确处理中文）
        # 先确保键盘焦点在微信窗口上
        try:
            subprocess.run(
                ["xdotool", "type", "--clearmodifiers", "--delay", "10", text],
                capture_output=True,
                timeout=10,
                env=env
            )
            sys.stdout.write(f"[auth-server] xdotool type: {text[:50]}...\n")
            sys.stdout.flush()
        except FileNotFoundError:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "xdotool 未安装"})
            return
        except subprocess.TimeoutExpired:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "超时"})
            return
        except Exception as e:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(e)})
            return

        self._json(HTTPStatus.OK, {"ok": True, "length": len(text)})

    def _handle_upload_file(self):
        """接收文件上传，保存到临时目录，设置 X11 剪贴板为 text/uri-list"""
        # 校验登录状态
        token = parse_cookie(self.headers.get("Cookie", ""))
        if not (token and verify_token(token)):
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "未登录"})
            return

        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "需要 multipart/form-data"})
            return

        # 解析 multipart 数据
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        if length <= 0 or length > 100 * 1024 * 1024:  # 限制 100MB
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "文件大小不合法"})
            return

        # 读取 body
        body = self.rfile.read(length)

        # 从 Content-Type 提取 boundary
        boundary = None
        for part in content_type.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary = part[len("boundary="):].strip('"')
                break

        if not boundary:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "缺少 boundary"})
            return

        # 解析 multipart（简化版，只提取文件名和文件数据）
        boundary_bytes = ("--" + boundary).encode()
        parts = body.split(boundary_bytes)

        upload_dir = "/tmp/wechat-paste"
        os.makedirs(upload_dir, exist_ok=True)

        saved_files = []
        for part in parts:
            if b"Content-Disposition" not in part:
                continue
            # 分离 header 和 body
            header_end = part.find(b"\r\n\r\n")
            if header_end < 0:
                continue
            header_str = part[2:header_end].decode("utf-8", errors="replace")
            file_data = part[header_end + 4:]

            # 去掉末尾的 \r\n
            if file_data.endswith(b"\r\n"):
                file_data = file_data[:-2]

            # 提取文件名
            filename = None
            for line in header_str.split("\r\n"):
                if "Content-Disposition" in line:
                    for seg in line.split(";"):
                        seg = seg.strip()
                        if seg.startswith("filename="):
                            filename = seg[len("filename="):].strip('"')
                            break

            if not filename or not file_data:
                continue

            # 安全化文件名
            filename = os.path.basename(filename)
            if not filename:
                continue

            # 生成唯一文件名避免冲突
            unique_name = f"{uuid.uuid4().hex[:8]}_{filename}"
            file_path = os.path.join(upload_dir, unique_name)

            with open(file_path, "wb") as f:
                f.write(file_data)

            saved_files.append(file_path)
            sys.stdout.write(f"[auth-server] 文件已保存: {file_path} ({len(file_data)} bytes)\n")
            sys.stdout.flush()

        if not saved_files:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "未找到文件"})
            return

        # 用 xclip 设置 text/uri-list 格式的 X11 剪贴板
        # xclip 设置后需要保持运行以持有剪贴板所有权，所以用 Popen + 非阻塞写入
        uris = [f"file://{f}" for f in saved_files]
        uri_list = "\r\n".join(uris) + "\r\n"

        try:
            # 先杀掉之前的 xclip 进程
            subprocess.run(["pkill", "-f", "xclip"], capture_output=True, timeout=2)
        except Exception:
            pass

        try:
            # 用 Popen 启动 xclip，写入数据后关闭 stdin，但不等待退出
            proc = subprocess.Popen(
                ["xclip", "-selection", "clipboard", "-t", "text/uri-list"],
                stdin=subprocess.PIPE,
                env={**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":100")}
            )
            proc.stdin.write(uri_list.encode("utf-8"))
            proc.stdin.close()
            # 不等待 proc 退出（xclip 需要保持运行持有剪贴板所有权）
            sys.stdout.write(f"[auth-server] xclip 已设置剪贴板: {uris}\n")
            sys.stdout.flush()
        except FileNotFoundError:
            sys.stderr.write("[auth-server] xclip 未安装\n")
        except Exception as e:
            sys.stderr.write(f"[auth-server] xclip 异常: {e}\n")

        # 模拟 Ctrl+V 让微信粘贴文件
        try:
            subprocess.run(
                ["xdotool", "key", "ctrl+v"],
                capture_output=True,
                timeout=5,
                env={**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":100")}
            )
            sys.stdout.write("[auth-server] 已模拟 Ctrl+V 粘贴文件\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f"[auth-server] xdotool 异常: {e}\n")

        self._json(HTTPStatus.OK, {
            "ok": True,
            "files": saved_files,
            "count": len(saved_files),
        })

    def _handle_login(self):
        # 读取并解析表单
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        form = urllib.parse.parse_qs(raw.decode("utf-8"), keep_blank_values=True)

        username = (form.get("username", [""])[0] or "").strip()
        password = form.get("password", [""])[0] or ""
        next_url = form.get("next", ["/"])[0] or "/"

        # 仅允许站内跳转，防开放重定向
        if not next_url.startswith("/") or next_url.startswith("//"):
            next_url = "/"

        ok = (hmac.compare_digest(username, USERNAME)
              and hmac.compare_digest(password, PASSWORD))

        if not ok:
            self._json(HTTPStatus.UNAUTHORIZED, {
                "ok": False,
                "error": "账号或密码错误",
            })
            return

        # 签发 cookie
        expire_ts = int(time.time()) + COOKIE_MAX_AGE
        token = sign_token(expire_ts)
        self._json(HTTPStatus.OK, {
            "ok": True,
            "next": next_url,
        }, extra_headers=[("Set-Cookie", build_set_cookie(token))])

    def do_OPTIONS(self):
        # CORS 预检（登录表单用 fetch 提交）
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "same-origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, *args):
        pass  # 静默


def main():
    if not SECRET:
        sys.stderr.write("[auth-server] AUTH_SECRET 未设置，已自动生成（重启后失效）\n")
    server = http.server.HTTPServer((HOST, PORT), AuthHandler)
    sys.stdout.write(f"[auth-server] 监听 {HOST}:{PORT} (用户: {USERNAME})\n")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
