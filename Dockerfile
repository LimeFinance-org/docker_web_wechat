# xwechat-xpra
# 基于 Xpra 的 Web 微信方案，解决传统 VNC 方案的两大痛点：
#   1. VNC 协议不支持图片剪贴板 → Xpra 原生支持 image/png 等二进制剪贴板
#   2. VNC + noVNC 画质模糊     → Xpra 支持 H.264/VP9 视频编码，画质清晰
# 同时支持原生文件传输（上传/下载），完全通过浏览器访问。

FROM ubuntu:22.04

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=zh_CN.UTF-8
ENV LC_ALL=zh_CN.UTF-8
ENV TZ=Asia/Shanghai
ENV DISPLAY=:100

# 替换为清华镜像源（兼容 amd64 的 archive 和 arm64 的 ports）
RUN sed -i 's@//.*archive.ubuntu.com@//mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list \
    && sed -i 's@//.*security.ubuntu.com@//mirrors.tuna.tsinghua.edu.cn/ubuntu@g' /etc/apt/sources.list \
    && sed -i 's@//.*ports.ubuntu.com/ubuntu-ports@//mirrors.tuna.tsinghua.edu.cn/ubuntu-ports@g' /etc/apt/sources.list

# 添加 Xpra 官方仓库（Ubuntu 22.04 jammy）
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl gnupg ca-certificates \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://xpra.org/xpra.asc | gpg --dearmor -o /etc/apt/keyrings/xpra.gpg \
    && echo "deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/xpra.gpg] https://xpra.org/ jammy main" \
        > /etc/apt/sources.list.d/xpra.list

# 安装 Xpra + X11 + 微信运行时依赖 + 中文字体 + 视频编码器
RUN apt-get update && apt-get install -y --no-install-recommends \
        # Xpra 服务器及其 HTML5 客户端
        # 注意：v6 起 X11 支持被拆分到独立包 xpra-x11，seamless 模式（xpra start）必需
        xpra xpra-html5 xpra-x11 \
        # X server 与工具
        xvfb x11-xserver-utils x11-utils \
        # XKB 键盘布局数据（中文/Unicode 输入必需！缺此包会出现 "XKB bindings not available"）
        xkb-data \
        # 音频
        pulseaudio pulseaudio-utils \
        # 视频编码（提升画质的关键）
        ffmpeg libx264-dev libvpx-dev \
        # 微信运行时依赖
        libgtk-3-0 libnss3 libnspr4 libgbm1 \
        libxkbcommon0 libxkbcommon-x11-0 libx11-xcb1 \
        libxcb-icccm4 libxcb-image0 libxcb-keysyms1 \
        libxcb-randr0 libxcb-render-util0 libxcb-shape0 \
        libxcb-shm0 libxcb-sync1 libxcb-util1 libxcb-xfixes0 \
        libxcb-xkb1 libxcb-xinerama0 libxcb-glx0 \
        libxtst6 libxss1 \
        libasound2 libpulse0 libatomic1 \
        # 窗口管理器（让微信窗口能正常渲染标题栏、聚焦等）
        openbox \
        # 中文字体
        fonts-noto-cjk fonts-noto-cjk-extra fonts-noto-color-emoji \
        # 工具
        curl ca-certificates locales tzdata \
        # 消息通知守护进程依赖
        #   wmctrl  - 查询 X11 窗口标题（解析未读消息数）
        #   python3 - 运行 notify-watcher.py
        #   procps  - 提供 pgrep 检测微信进程是否在运行
        #   xdotool - 模拟键盘输入（xdotool type 需配合 XKB 才能输入中文）
        #   xclip   - 设置 X11 剪贴板（文件粘贴时写入 text/uri-list）
        #   xsel    - 更可靠的 X11 剪贴板工具（支持 --keep 保持选择区）
        wmctrl python3 procps xdotool xclip xsel \
        # 容器内 Nginx：反向代理 + auth_request 会话认证
        #   nginx  - Web 服务器（auth_request 模块内置）
        nginx \
    && sed -i 's/# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 复制并安装微信下载链接解析脚本
COPY scripts/resolve-wechat-download.sh /usr/local/bin/resolve-wechat-download
RUN chmod +x /usr/local/bin/resolve-wechat-download

# 复制消息通知守护进程
COPY scripts/notify-watcher.py /usr/local/bin/notify-watcher.py
RUN chmod +x /usr/local/bin/notify-watcher.py

# 复制窗口居中守护脚本（解决微信窗口尺寸固定导致二维码偏移）
COPY scripts/center-window.sh /usr/local/bin/center-window.sh
RUN chmod +x /usr/local/bin/center-window.sh

# 复制微信启动包装脚本（启动前设置合理屏幕分辨率，避免窗口位置偏移）
COPY scripts/start-wechat.sh /usr/local/bin/start-wechat.sh
RUN chmod +x /usr/local/bin/start-wechat.sh

# 配置 openbox：让微信窗口启动时出现在 (0,0)，避免在虚拟大屏幕中偏移到角落
RUN mkdir -p /root/.config/openbox
COPY scripts/openbox-rc.xml /root/.config/openbox/rc.xml

# 复制登录认证服务（账号密码校验 + HMAC cookie 签发/校验）
COPY scripts/auth-server.py /usr/local/bin/auth-server.py
RUN chmod +x /usr/local/bin/auth-server.py

# 复制通知注入脚本 + 登录页 + 文件粘贴助手（由 Nginx sub_filter / root 提供）
RUN install -d /usr/local/share/xwechat
COPY scripts/notify-inject.js /usr/local/share/xwechat/notify-inject.js
COPY scripts/paste-helper.js  /usr/local/share/xwechat/paste-helper.js
COPY scripts/login.html      /usr/local/share/xwechat/login.html

# 复制容器内 Nginx 配置（Cookie 会话认证 + 反代 Xpra/notify-watcher/auth-server）
COPY nginx-internal.conf /etc/nginx/conf.d/xwechat.conf
RUN rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf 2>/dev/null || true

# 从微信 Linux 官网解析当前架构最新 deb 链接并安装
# 腾讯下载源偶尔会断连，curl 显式重试
RUN set -eux; \
    WECHAT_DEB_URL="$(resolve-wechat-download "${TARGETARCH:-}" https://linux.weixin.qq.com/)"; \
    curl --fail --location --retry 5 --retry-delay 10 --retry-all-errors --connect-timeout 30 \
        --output /tmp/WeChatLinux.deb "$WECHAT_DEB_URL"; \
    dpkg -i /tmp/WeChatLinux.deb || apt-get -f install -y; \
    rm -f /tmp/WeChatLinux.deb

# 启动脚本
COPY start.sh /start.sh
RUN chmod +x /start.sh

# 对外暴露的唯一端口（Nginx Basic Auth 入口）
# Xpra (8080) 和 notify-watcher (19892) 仅监听 127.0.0.1，不对外
EXPOSE 1989

# 微信数据持久化目录
VOLUME ["/root/.xwechat", "/root/xwechat_files", "/root/downloads"]

CMD ["/start.sh"]
