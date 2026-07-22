/*!
 * xwechat-xpra 消息通知注入脚本
 * 由容器内 Nginx 通过 sub_filter 自动注入到 Xpra HTML5 页面
 * 用户无需安装任何浏览器扩展，访问页面即自动启用通知
 *
 * 工作流程：
 *   1. 页面加载后自动执行
 *   2. 请求浏览器通知权限
 *   3. 轮询同源 /notify/status 获取未读消息数
 *   4. 检测到新消息时调用 Notification API 弹桌面通知
 */
(function () {
    'use strict';

    // 避免重复注入（Xpra HTML5 可能用 SPA 路由导致脚本多次执行）
    if (window.__XWECHAT_NOTIFY_LOADED__) return;
    window.__XWECHAT_NOTIFY_LOADED__ = true;

    // ============== 配置区 ==============
    // 通知端点：同源访问 /notify/status
    // 容器内 Nginx 把 /notify/ 反代到 notify-watcher (:19892)
    // 同源请求浏览器会自动带 Basic Auth 凭证
    const STATUS_URL = `${location.origin}/notify/status`;

    const POLL_INTERVAL = 2000;         // 轮询间隔（毫秒）
    const NOTIFY_DEBOUNCE = 8000;       // 同一通知去抖间隔（毫秒）
    const NOTIFY_AUTO_CLOSE = 6000;     // 通知自动关闭时间

    // ============== 状态 ==============
    let lastUnread = 0;
    let lastNotifyTs = 0;
    let originalTitle = 'web_wechat';
    document.title = originalTitle;
    // 强制标题为 web_wechat（防止 Xpra 动态修改标题）
    setInterval(function () {
        if (!flashTimer && document.title !== originalTitle) {
            document.title = originalTitle;
        }
    }, 3000);
    let flashTimer = null;
    let isActiveWindow = true;

    // 监听窗口失焦/聚焦（失焦时才通知，避免打扰正在使用的用户）
    window.addEventListener('blur', () => { isActiveWindow = false; });
    window.addEventListener('focus', () => {
        isActiveWindow = true;
        stopFlashTitle();
        document.title = originalTitle;
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            isActiveWindow = false;
        } else {
            isActiveWindow = true;
            stopFlashTitle();
            document.title = originalTitle;
        }
    });

    // ============== 通知权限 ==============
    function ensurePermission() {
        if (!('Notification' in window)) {
            console.warn('[xwechat-notify] 浏览器不支持 Notification API');
            return false;
        }
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') {
            console.warn('[xwechat-notify] 通知权限被拒绝，请在浏览器设置中允许');
            return false;
        }
        // 异步请求权限（需要用户交互，浏览器才会弹出权限对话框）
        // 首次访问时如果没交互，会在用户第一次点击页面时触发
        Notification.requestPermission().then(p => {
            console.log('[xwechat-notify] 通知权限:', p);
        });
        return false;
    }

    // 用户首次交互时再次请求权限（解决页面加载时无法弹权限框的问题）
    function setupInteractionListener() {
        const handler = () => {
            if (Notification.permission === 'default') {
                Notification.requestPermission();
            }
            // 只触发一次
            document.removeEventListener('click', handler);
            document.removeEventListener('keydown', handler);
        };
        document.addEventListener('click', handler);
        document.addEventListener('keydown', handler);
    }

    // ============== 发送通知 ==============
    function sendNotification(unread) {
        if (!ensurePermission()) return;
        const now = Date.now();
        if (now - lastNotifyTs < NOTIFY_DEBOUNCE) return;
        lastNotifyTs = now;

        try {
            const n = new Notification('微信新消息', {
                body: `你有 ${unread} 条未读消息`,
                tag: 'xwechat-message',
                renotify: true,
                silent: false,
                // 用 SVG emoji 作为图标，无需外部资源
                icon: 'data:image/svg+xml,' + encodeURIComponent(
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
                    '<text x="32" y="50" font-size="48" text-anchor="middle">💬</text>' +
                    '</svg>'
                ),
            });

            // 点击通知聚焦窗口
            n.onclick = () => {
                window.focus();
                n.close();
            };

            // 自动关闭
            setTimeout(() => { try { n.close(); } catch (e) {} }, NOTIFY_AUTO_CLOSE);
        } catch (e) {
            console.warn('[xwechat-notify] 通知发送失败:', e);
        }
    }

    // ============== 标签页标题闪烁 ==============
    function startFlashTitle(unread) {
        if (flashTimer) return;
        const flashMsg = `【${unread}条新消息】微信`;
        flashTimer = setInterval(() => {
            document.title = (document.title === flashMsg) ? originalTitle : flashMsg;
        }, 1000);
    }

    function stopFlashTitle() {
        if (flashTimer) {
            clearInterval(flashTimer);
            flashTimer = null;
        }
        document.title = originalTitle;
    }

    // ============== 轮询监听 ==============
    async function checkStatus() {
        try {
            const res = await fetch(STATUS_URL, {
                method: 'GET',
                cache: 'no-store',
                mode: 'same-origin',
                credentials: 'same-origin',  // 同源自动带 Basic Auth 凭证
            });
            if (!res.ok) return;
            const data = await res.json();

            // 微信未运行时不通知
            if (!data.app_running) {
                lastUnread = 0;
                return;
            }

            const unread = data.unread || 0;

            // 未读数增加时通知
            if (unread > lastUnread && unread > 0) {
                // 窗口未激活时才弹通知，避免打扰当前用户
                if (!isActiveWindow || document.hidden) {
                    sendNotification(unread);
                }
                startFlashTitle(unread);
            }

            // 未读清零时停止闪烁
            if (unread === 0 && lastUnread > 0) {
                stopFlashTitle();
            }

            lastUnread = unread;
        } catch (e) {
            // 网络错误静默处理（守护进程可能还在启动）
        }
    }

    // ============== 启动 ==============
    console.log(`[xwechat-notify] 已注入，监听端点: ${STATUS_URL}`);
    ensurePermission();
    setupInteractionListener();
    setInterval(checkStatus, POLL_INTERVAL);
    // 启动后立即检查一次
    setTimeout(checkStatus, 1500);
})();

// ============== 文件/图片粘贴支持 ==============
// 合并到 notify-inject.js 中，避免单独加载 paste-helper.js 时的网络问题
(function () {
    'use strict';
    if (window.__pasteHelperLoaded) return;
    window.__pasteHelperLoaded = true;

    function getClient() {
        if (window.client && window.client.connected) return window.client;
        return null;
    }

    function blobToUint8(blob) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(new Uint8Array(reader.result)); };
            reader.onerror = reject;
            reader.readAsArrayBuffer(blob);
        });
    }

    function sendImageToClipboard(uint8data, mimeType) {
        var client = getClient();
        if (!client) { console.warn('[paste] Xpra client 未就绪'); return; }
        try {
            client.clipboard_buffer = uint8data;
            client.clipboard_datatype = mimeType;
            client.send_clipboard_token(uint8data, [mimeType]);
            console.log('[paste] 图片已写入剪贴板:', mimeType, uint8data.length, 'bytes');
            // 延迟模拟 Ctrl+V
            setTimeout(function () {
                try {
                    client.send(['key-action', 0, 'Control_L', true, 1, ['control'], 0, '']);
                    client.send(['key-action', 0, 'v', true, 1, ['control'], 0, '']);
                    client.send(['key-action', 0, 'v', false, 1, ['control'], 0, '']);
                    client.send(['key-action', 0, 'Control_L', false, 1, [], 0, '']);
                    console.log('[paste] 已模拟 Ctrl+V');
                } catch (e) { console.error('[paste] Ctrl+V 失败:', e); }
            }, 200);
        } catch (e) { console.error('[paste] 写入剪贴板失败:', e); }
    }

    function uploadFile(file) {
        // 通过 HTTP 上传文件到服务器，服务器设置 text/uri-list 剪贴板并模拟 Ctrl+V
        var formData = new FormData();
        formData.append('file', file);

        fetch('/_upload-file', {
            method: 'POST',
            body: formData,
            credentials: 'same-origin'
        }).then(function (resp) {
            return resp.json();
        }).then(function (data) {
            if (data.ok) {
                console.log('[paste] 文件上传成功:', data.files, '数量:', data.count);
            } else {
                console.error('[paste] 文件上传失败:', data.error);
            }
        }).catch(function (err) {
            console.error('[paste] 文件上传异常:', err);
        });
    }

    document.addEventListener('paste', function (event) {
        var items = event.clipboardData && event.clipboardData.items;
        if (!items) return;
        var handled = false;
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.type && item.type.indexOf('image/') === 0) {
                var blob = item.getAsFile();
                if (!blob) continue;
                handled = true; event.preventDefault();
                console.log('[paste] 检测到图片:', item.type, blob.size);
                blobToUint8(blob).then(function (u8) {
                    sendImageToClipboard(u8, item.type || 'image/png');
                });
            } else if (item.kind === 'file' && (!item.type || item.type.indexOf('image/') !== 0)) {
                var f = item.getAsFile();
                if (!f) continue;
                handled = true; event.preventDefault();
                console.log('[paste] 检测到文件:', f.name, f.size);
                uploadFile(f);
            }
        }
    });

    console.log('[paste] 粘贴助手已就绪');
})();
