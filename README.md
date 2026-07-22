# docker_web_wechat

> 基于 [Xpra](https://xpra.org/) 的 Web 微信方案：在浏览器中运行 Linux 版微信，支持图片剪贴板、文件传输、消息通知、自定义登录页。

## 为什么用这个项目

**核心目标：隐私保护 & 数据安全。**

微信是闭源商业软件，运行时会扫描本机磁盘数据、遍历文件目录、读取进程和 CPU 信息，存在严重的数据泄露风险。本项目将微信完全隔离在 Docker 沙箱中：

- **文件系统隔离** —— 容器内微信只能看到自己的虚拟文件系统，无法触碰本机上的任何文件
- **网络隔离** —— 容器拥有独立网络栈，微信无法嗅探或访问本机所在内网的其他服务
- **进程隔离** —— 微信看不到本机上运行的其他进程，杜绝通过进程列表推断本机用途的可能

## 特性

- 🌐 **纯 Web 访问** —— 浏览器打开链接即可使用，无需安装任何客户端
- 🔐 **自定义登录页** —— 绿色主题（`#1cbf61`）玻璃拟态登录页，替换浏览器默认 Basic Auth 弹窗
- 📋 **剪贴板双向同步** —— 支持文本、图片、文件（`text/uri-list`）三种格式
- 🖼️ **Ctrl+V 粘贴图片/文件** —— 直接粘贴到微信对话框，图片无损传输
- 🔔 **桌面消息通知** —— 浏览器 Notification API 弹桌面通知，标签页标题闪烁提醒
- 🎨 **高清显示** —— VP9 编码 + DPI 144 + 质量 100，文字清晰锐利
- 🇨🇳 **完整中文化** —— Xpra HTML5 客户端界面、浮动菜单全部翻译为中文
- 🪟 **窗口自动居中** —— 守护进程每 2 秒把微信窗口移到屏幕中央，避免二维码偏移
- 🚫 **隐藏无关 UI** —— 自动隐藏托盘图标、标题栏、浮动菜单等干扰元素
- 🕐 **上海时区** —— 容器时区预设为 `Asia/Shanghai`
- 📦 **Docker 一键部署** —— `docker compose up -d` 即可

## 一键部署

### 前置要求

- Docker 20.10+
- Docker Compose v2+
- 公网服务器（或局域网服务器）开放 1989 端口

### 部署步骤

```bash
# 1. 克隆仓库
git clone https://github.com/LimeFinance-org/docker_web_wechat.git
cd docker_web_wechat

# 2. （可选）修改账号密码
#    编辑 docker-compose.yml 中的 WEB_AUTH_USER / WEB_AUTH_PASSWORD

# 3. 一键启动（首次会构建镜像，约 5-15 分钟，取决于网络）
docker compose up -d --build

# 4. 查看启动日志
docker compose logs -f
```

启动完成后，浏览器访问：

```
http://<你的服务器IP>:1989/
```

会看到自定义登录页，输入账号密码即可进入微信网页客户端。

### 默认账号密码

| 项目 | 值 |
|------|-----|
| 用户名 | `baby` |
| 密码 | `caijing...` |

> ⚠️ **生产环境务必修改默认密码**：编辑 `docker-compose.yml` 中的 `WEB_AUTH_PASSWORD`，然后 `docker compose up -d` 重启。

## 配置说明

所有配置通过 `docker-compose.yml` 的环境变量注入，**修改后需重启容器生效**：

```bash
docker compose up -d   # 重新创建容器（不需要 --build，除非改了 Dockerfile）
```

### 显示清晰度

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `XPRA_DPI` | `144` | DPI：96 普通 / 144 高清 / 192 4K |
| `XPRA_WIDTH` | `1920` | 初始分辨率宽 |
| `XPRA_HEIGHT` | `1080` | 初始分辨率高 |
| `XPRA_ENCODING` | `vp9` | 编码：`jpeg`/`png`/`webp`/`h264`/`vp8`/`vp9` |
| `XPRA_VIDEO_ENCODING` | `yes` | 启用视频编码（动态画面更清晰） |
| `XPRA_QUALITY` | `100` | 编码质量 0-100，越高越清晰 |
| `XPRA_COMPRESSION` | `0` | 压缩级别 0-9，越低画质越好 |

### Web 访问认证

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `WEB_AUTH_USER` | `baby` | 登录用户名 |
| `WEB_AUTH_PASSWORD` | `caijing...` | 登录密码 |

### 其他

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `TZ` | `Asia/Shanghai` | 容器时区 |
| `LANG` | `zh_CN.UTF-8` | 容器语言 |

## 使用指南

### 登录微信

1. 浏览器访问 `http://<IP>:1989/`
2. 输入账号密码登录
3. 用手机微信扫码登录

### 粘贴图片

在微信对话框焦点状态下，直接按 **Ctrl+V** 粘贴剪贴板中的图片，图片会无损粘贴到对话框。

### 粘贴文件

复制一个文件（如在文件管理器中 Ctrl+C），切到浏览器微信对话框，按 **Ctrl+V**，文件会上传到服务器并粘贴到对话框。

### 消息通知

首次访问时浏览器会请求通知权限，允许后：
- 微信收到新消息时弹出桌面通知
- 标签页标题会闪烁显示未读数（如 `【3条新消息】微信`）

### 登出

访问 `http://<IP>:1989/_logout`，或清除浏览器 Cookie。

## 架构说明

```
浏览器 (:1989)
    │
    ▼
┌─────────────────────────────────────────────────┐
│  Nginx (容器内, :1989)                           │
│  ├─ /login          → 自定义登录页 HTML           │
│  ├─ /_auth   (POST) → auth-server 校验账号密码    │
│  ├─ /_check  (GET)  → auth_request 子请求校验cookie│
│  ├─ /_logout        → 清除 cookie                 │
│  ├─ /_upload-file   → 文件上传端点（粘贴文件用）   │
│  ├─ /notify/        → notify-watcher 消息状态     │
│  └─ /               → Xpra HTML5 客户端           │
└──────┬──────────┬──────────────┬─────────────────┘
       │          │              │
       ▼          ▼              ▼
┌──────────┐ ┌────────────┐ ┌──────────────┐
│ auth-    │ │ notify-    │ │ Xpra (:8080) │
│ server   │ │ watcher    │ │              │
│ (:19893) │ │ (:19892)   │ │  ┌────────┐  │
│          │ │            │ │  │ Xvfb   │  │
│ HMAC     │ │ wmctrl     │ │  │ :100   │  │
│ cookie   │ │ 解析标题   │ │  ├────────┤  │
│ 签发/校验 │ │            │ │  │ openbox│  │
│          │ │            │ │  ├────────┤  │
│          │ │            │ │  │ 微信   │  │
│          │ │            │ │  └────────┘  │
└──────────┘ └────────────┘ └──────────────┘
```

### 组件说明

| 组件 | 端口 | 作用 |
|------|------|------|
| Nginx | 1989（对外） | 反向代理 + Cookie 会话认证 + HTML 注入中文化 |
| auth-server.py | 19893（仅容器内） | HMAC-SHA256 签名 cookie 签发/校验 |
| notify-watcher.py | 19892（仅容器内） | 解析微信窗口标题获取未读消息数 |
| Xpra | 8080（仅容器内） | HTML5 远程桌面服务器，渲染微信界面 |
| Xvfb | :100（仅容器内） | 虚拟 X server |

### 关键文件

| 文件 | 作用 |
|------|------|
| `Dockerfile` | 镜像构建（Xpra + 微信 + 中文字体 + Nginx） |
| `docker-compose.yml` | 容器编排配置 |
| `start.sh` | 容器启动入口，拉起所有服务 |
| `nginx-internal.conf` | 容器内 Nginx 配置（认证 + 反代 + 中文化注入） |
| `nginx.conf` | 可选的外部 Nginx HTTPS 反代配置 |
| `scripts/auth-server.py` | 登录认证服务 |
| `scripts/notify-watcher.py` | 消息通知守护进程 |
| `scripts/notify-inject.js` | 注入到 Xpra 页面的 JS（通知 + 粘贴助手） |
| `scripts/login.html` | 自定义绿色主题登录页 |
| `scripts/start-wechat.sh` | 微信启动包装脚本（预设屏幕分辨率） |
| `scripts/center-window.sh` | 窗口居中守护进程 |
| `scripts/paste-helper.js` | 文件粘贴助手（已合并到 inject.js） |
| `scripts/resolve-wechat-download.sh` | 微信 deb 下载链接解析 |

## HTTPS 部署（可选）

生产环境建议套一层外部 Nginx/Caddy 做 HTTPS 终止。参考配置见 [nginx.conf](nginx.conf)。

用 Let's Encrypt 申请证书：

```bash
# 安装 certbot
apt install -y certbot python3-certbot-nginx

# 申请证书（替换 your-domain.com）
certbot --nginx -d your-domain.com
```

## 数据持久化

微信登录态、聊天文件等数据持久化在 `./data/` 目录（首次启动自动创建）：

```
data/
├── .xwechat/        # 微信配置（账号登录态、设置）
├── xwechat_files/   # 微信文件（聊天文件、图片缓存）
└── downloads/       # 文件传输中转目录
```

> 该目录在 `.gitignore` 中已排除，不会上传到 GitHub。

## 常见问题

### Q: 启动后访问显示 502 Bad Gateway

A: 微信 deb 下载需要联网，构建时如果网络不好会失败。重新构建：

```bash
docker compose build --no-cache
docker compose up -d
```

### Q: 微信窗口位置偏移，二维码看不到

A: `center-window.sh` 守护进程会自动居中。如果仍有问题，检查日志：

```bash
docker compose logs | grep center-window
```

### Q: Ctrl+V 粘贴图片不生效

A: 确保微信对话框已聚焦（点击对话框一下再粘贴）。浏览器需要支持 Clipboard API（Chrome/Edge/Firefox 均可）。

### Q: 消息通知不弹出

A: 浏览器需要允许通知权限。点击地址栏左侧的锁图标 → 网站设置 → 通知 → 允许。

### Q: 修改了配置不生效

A: Nginx 配置在构建时已写入镜像，修改 `nginx-internal.conf` 后需要重新构建：

```bash
docker compose up -d --build --force-recreate
```

仅修改环境变量则只需重启：

```bash
docker compose up -d
```

### Q: Xpra v6 启动失败

A: Xpra v6 起拆分了 X11 支持到独立包 `xpra-x11`，且部分参数名变更：
- `--start-after-ready` → `--start-child-late`
- `--video-encoding` → `--video`
- `--compress-level` → `--compression-level`

本项目已适配 v6，Dockerfile 中已安装 `xpra-x11`。

## 技术栈

- [Xpra](https://xpra.org/) - HTML5 远程桌面
- [Xvfb](https://www.x.org/wiki/) - 虚拟 X server
- [openbox](http://openbox.org/) - 轻量窗口管理器
- [Nginx](https://nginx.org/) - 反向代理 + auth_request 会话认证
- [Docker](https://www.docker.com/) - 容器化部署

