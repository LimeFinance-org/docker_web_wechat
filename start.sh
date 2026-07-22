#!/bin/bash
# xwechat-xpra 启动脚本
# 架构：Nginx (Cookie 会话认证, :1989) → Xpra (:8080) + notify-watcher (:19892) + auth-server (:19893)
# 对外只暴露 1989 端口，未登录访问跳转自定义登录页

set -e

# 清理可能的残留锁文件
rm -rf /tmp/.X100-lock /tmp/.X11-unix/X100 2>/dev/null || true
# 清理 Nginx 残留 pid
rm -f /run/nginx.pid /var/run/nginx.pid 2>/dev/null || true

# ============== 环境变量默认值 ==============
export LANG="${LANG:-zh_CN.UTF-8}"
export LC_ALL="${LC_ALL:-zh_CN.UTF-8}"
export DISPLAY="${DISPLAY:-:100}"
export TZ="${TZ:-Asia/Shanghai}"

# Xpra 显示参数（决定清晰度）
XPRA_DPI="${XPRA_DPI:-144}"                        # DPI，高 DPI 屏可设 192
XPRA_ENCODING="${XPRA_ENCODING:-vp9}"              # 编码：jpeg/png/webp/h264/vp8/vp9
XPRA_VIDEO_ENCODING="${XPRA_VIDEO_ENCODING:-yes}"  # 启用视频编码
XPRA_WIDTH="${XPRA_WIDTH:-1920}"                   # 初始分辨率宽
XPRA_HEIGHT="${XPRA_HEIGHT:-1080}"                 # 初始分辨率高
XPRA_QUALITY="${XPRA_QUALITY:-90}"                 # 编码质量 0-100
XPRA_COMPRESSION="${XPRA_COMPRESSION:-1}"          # 压缩级别 0-9（低=画质好）

# 内部端口（仅容器内监听，不对外暴露）
XPRA_PORT="${XPRA_PORT:-8080}"                     # Xpra HTML5 客户端
NOTIFY_PORT="${NOTIFY_PORT:-19892}"                # 通知守护进程

# 对外端口（Nginx Basic Auth 入口）
WEB_PORT="${WEB_PORT:-1989}"

# ============== Web 访问认证（用户名+密码）==============
# 默认值符合用户要求：用户名 baby / 密码 caijing...
# 可通过环境变量覆盖
WEB_AUTH_USER="${WEB_AUTH_USER:-baby}"
WEB_AUTH_PASSWORD="${WEB_AUTH_PASSWORD:-caijing...}"

# auth-server 监听端口（仅容器内）
AUTH_PORT="${AUTH_PORT:-19893}"
AUTH_HOST="${AUTH_HOST:-127.0.0.1}"

# 生成 HMAC 签名密钥（每次启动随机生成，重启后旧 cookie 失效）
# 如需跨重启保持登录态，可通过环境变量 AUTH_SECRET 固定
if [ -z "${AUTH_SECRET:-}" ]; then
    AUTH_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
export AUTH_SECRET

# ============== 启动 PulseAudio（音频支持）==============
mkdir -p /run/pulse /var/run/pulse
pulseaudio --start \
    --system \
    --disallow-exit \
    --disable-shm \
    --exit-idle-time=-1 \
    2>/dev/null || true

# ============== 启动消息通知守护进程 ==============
# 监听微信窗口标题变化，通过 :19892/status 暴露未读消息数
# 仅监听 127.0.0.1，由 Nginx 反代到 /notify/ 路径对外提供
NOTIFY_HOST="${NOTIFY_HOST:-127.0.0.1}"
NOTIFY_PORT="$NOTIFY_PORT" NOTIFY_HOST="$NOTIFY_HOST" \
    python3 /usr/local/bin/notify-watcher.py &

# ============== 启动窗口居中守护进程 ==============
# 微信窗口尺寸固定（约 420×570），无法自适应浏览器窗口。
# Xpra --resize-display 会动态调整虚拟屏幕，导致微信窗口偏移到角落。
# 此守护进程每 2 秒把微信窗口移到屏幕中央，保持视觉居中。
bash /usr/local/bin/center-window.sh &

# ============== 启动登录认证服务 ==============
# 监听 :19893，提供 /_auth（登录）、/_check（cookie 校验）、/_logout（登出）
# 仅监听 127.0.0.1，由 Nginx 反代
WEB_AUTH_USER="$WEB_AUTH_USER" WEB_AUTH_PASSWORD="$WEB_AUTH_PASSWORD" \
    AUTH_SECRET="$AUTH_SECRET" AUTH_PORT="$AUTH_PORT" AUTH_HOST="$AUTH_HOST" \
    python3 /usr/local/bin/auth-server.py &

# ============== 配置 Xvfb 虚拟屏幕分辨率 ==============
export XPRA_INITIAL_RESOLUTION="${XPRA_WIDTH}x${XPRA_HEIGHT}x24"

# ============== 中文化 Xpra HTML5 界面 ==============
# 对 connect.html / index.html 中 sub_filter 无法处理的跨行文本做 sed 预处理
# 每次启动执行，保证 xpra-html5 包升级后仍生效
XPRA_WWW="/usr/share/xpra/www"
if [ -d "$XPRA_WWW" ]; then
    # connect.html：跨行的 "Upload\n file"、"Bug\n Report"、"Native\n decoding"
    sed -i 's|>Upload[[:space:]]*$|>上传|' "$XPRA_WWW/index.html" 2>/dev/null || true
    sed -i 's|^[[:space:]]*file</a>|文件</a>|' "$XPRA_WWW/index.html" 2>/dev/null || true
    sed -i 's|>Bug[[:space:]]*$|>缺陷|' "$XPRA_WWW/index.html" 2>/dev/null || true
    sed -i 's|^[[:space:]]*Report</a>|报告</a>|' "$XPRA_WWW/index.html" 2>/dev/null || true
    sed -i 's|/> Native[[:space:]]*$|/> 原生|' "$XPRA_WWW/connect.html" 2>/dev/null || true
    sed -i 's|^[[:space:]]*decoding</span>|解码</span>|' "$XPRA_WWW/connect.html" 2>/dev/null || true
    # index.html 内嵌 JS 中的提示文本
    sed -i 's|"audio is not available"|"音频不可用"|g' "$XPRA_WWW/index.html" 2>/dev/null || true
    sed -i 's|tooltip = "audio is not available"|tooltip = "音频不可用"|g' "$XPRA_WWW/index.html" 2>/dev/null || true
fi

# ============== 启动 Nginx（Cookie 会话认证入口）==============
# Nginx 配置文件由 Dockerfile 复制到 /etc/nginx/conf.d/xwechat.conf
# 监听 :1989，未登录跳转 /login，反代 / 到 Xpra，反代 /notify/ 到 notify-watcher
nginx -g 'daemon off;' &
NGINX_PID=$!

# ============== 启动日志 ==============
echo "================================================"
echo "  docker_web_wechat 启动中..."
echo "  - 显示:        ${DISPLAY} @ ${XPRA_WIDTH}x${XPRA_HEIGHT}"
echo "  - DPI:         ${XPRA_DPI}"
echo "  - 编码:        ${XPRA_ENCODING} (quality=${XPRA_QUALITY})"
echo "  - 视频编码:    ${XPRA_VIDEO_ENCODING}"
echo "  - 剪贴板:      双向同步（含图片）"
echo "  - 文件传输:    已启用"
echo "  -------- 网络 --------"
echo "  - Web 入口:    :${WEB_PORT} (自定义登录页)"
echo "  - 登录页:      http://<host>:${WEB_PORT}/login"
echo "  - 认证用户:    ${WEB_AUTH_USER}"
echo "  - Xpra 内部:   127.0.0.1:${XPRA_PORT}"
echo "  - 通知内部:    127.0.0.1:${NOTIFY_PORT}"
echo "  - 认证内部:    127.0.0.1:${AUTH_PORT}"
echo "================================================"
echo "  访问地址: http://<host>:${WEB_PORT}/"
echo "  通知端点: http://<host>:${WEB_PORT}/notify/status"
echo "================================================"

# ============== 启动 Xpra 服务器 ==============
# Xpra 仅监听 127.0.0.1，由 Nginx 反代对外
# 关键参数说明：
#   --bind-ws            : WebSocket 监听地址（仅容器内）
#   --html=on            : 启用内置 HTML5 客户端
#   --start-child        : Xpra 启动后立即拉起 openbox 窗口管理器
#   --start-after-ready  : X server 就绪后启动微信
#   --exit-with-children : 子进程退出时容器随之退出
#   --encoding           : 视频编码格式（vp9 画质最好，h264 兼容性最好）
#   --video-encoding     : 启用视频编码（对动态画面大幅提升清晰度）
#   --clipboard          : 启用剪贴板同步（支持 image/png 等二进制 MIME）
#   --clipboard-direction: 双向同步
#   --file-transfer      : 启用文件传输（HTML5 客户端可上传/下载文件）
#   --open-files         : 自动打开上传的文件
#   --dpi                : 字体 DPI（影响清晰度，96=普通，144=高清，192=4K）
#   --resize-display     : 根据浏览器窗口动态调整分辨率
#   --speaker            : 启用音频输出（让浏览器能听到声音）
#   --pulseaudio         : 使用 PulseAudio 作为音频后端
#   --daemon=no          : 前台运行（容器主进程）
exec xpra start "${DISPLAY}" \
    --bind-ws="127.0.0.1:${XPRA_PORT}" \
    --html=on \
    --start-child="openbox" \
    --start-child-late="/usr/local/bin/start-wechat.sh" \
    --exit-with-children=yes \
    --encoding="${XPRA_ENCODING}" \
    --video="${XPRA_VIDEO_ENCODING}" \
    --quality="${XPRA_QUALITY}" \
    --compression-level="${XPRA_COMPRESSION}" \
    --clipboard=yes \
    --clipboard-direction=both \
    --file-transfer=yes \
    --open-files=yes \
    --printing=no \
    --dpi="${XPRA_DPI}" \
    --resize-display=yes \
    --tray=no \
    --microphone=no \
    --speaker=yes \
    --pulseaudio=yes \
    --daemon=no \
    --log-file=- \
    --pidfile=/tmp/xpra.pid
