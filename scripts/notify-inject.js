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

    // 模拟 Ctrl+V 按键（使用 Xpra 正确的 key-action 包格式）
    // 包格式: ["key-action", wid, keyname, pressed, modifiers, keycode, keystring, keycode, 0]
    function simulateCtrlV(client) {
        var wid = client.focused_wid || 0;
        client.send(["key-action", wid, "Control_L", true, [], 17, "", 17, 0]);
        client.send(["key-action", wid, "v", true, ["control"], 86, "v", 86, 0]);
        client.send(["key-action", wid, "v", false, ["control"], 86, "v", 86, 0]);
        client.send(["key-action", wid, "Control_L", false, [], 17, "", 17, 0]);
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
                    simulateCtrlV(client);
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
        var clipboard = event.clipboardData;
        if (!clipboard) return;

        // ── 优先处理文本粘贴（解决 Ctrl+V 中文粘贴问题）──
        var text = clipboard.getData('text/plain');
        if (text) {
            event.preventDefault();
            event.stopPropagation();
            console.log('[paste] 文本粘贴:', text.substring(0, 50));
            fetch('/_type-text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text }),
                credentials: 'same-origin'
            }).then(function (r) { return r.json(); })
              .then(function (d) {
                  if (d.ok) console.log('[paste] 文本已发送');
                  else console.error('[paste] 文本发送失败:', d.error);
              }).catch(function (err) {
                  console.error('[paste] 异常:', err);
              });
            return;
        }

        // ── 图片/文件粘贴（原有逻辑）──
        var items = clipboard.items;
        if (!items) return;
        var handled = false;
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.type && item.type.indexOf('image/') === 0) {
                var blob = item.getAsFile();
                if (!blob) continue;
                handled = true;
                console.log('[paste] 检测到图片:', item.type, blob.size);
                blobToUint8(blob).then(function (u8) {
                    sendImageToClipboard(u8, item.type || 'image/png');
                });
            } else if (item.kind === 'file' && (!item.type || item.type.indexOf('image/') !== 0)) {
                var f = item.getAsFile();
                if (!f) continue;
                handled = true;
                console.log('[paste] 检测到文件:', f.name, f.size);
                uploadFile(f);
            }
        }
    });

    console.log('[paste] 粘贴助手已就绪');
})();

// ============== IME 输入法支持 + 文本粘贴 ==============
// 双通道方案：
//   1. Ctrl+V 文本粘贴 → paste 事件拦截 → /_type-text → xdotool type（已在上面实现）
//   2. 浏览器 IME 输入 → input 事件（isComposing=false）→ /_type-text → xdotool type
//
// input 事件比 compositionend 更可靠：即使 Xpra 的 preventDefault 影响了 IME，
// input 事件在 DOM 值变更时也会触发，isComposing=false 表示最终文字。
(function () {
    'use strict';
    if (window.__imeHelperLoaded) return;
    window.__imeHelperLoaded = true;

    var isComposing = false;
    var compositionTimer = null;

    function resetComposing() {
        isComposing = false;
        if (compositionTimer) { clearTimeout(compositionTimer); compositionTimer = null; }
    }

    function sendText(text) {
        if (!text) return;
        console.log('[ime] 发送:', text.substring(0, 50));
        fetch('/_type-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text }),
            credentials: 'same-origin'
        }).then(function (r) { return r.json(); })
          .then(function (d) {
              if (d.ok) console.log('[ime] 已输入:', text.substring(0, 30));
              else console.error('[ime] 失败:', d.error);
          }).catch(function (err) {
              console.error('[ime] 异常:', err);
          });
    }

    function initWhenReady() {
        var pb = document.getElementById('pasteboard');
        if (!pb) { setTimeout(initWhenReady, 200); return; }

        if (pb.readOnly) { pb.readOnly = false; }

        // pasteboard 移到可视区域并提权（高 z-index 有助 IME 激活）
        pb.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;' +
            'opacity:0;pointer-events:none;z-index:999999;resize:none;' +
            'border:none;outline:none;padding:0;margin:0';
        console.log('[ime] pasteboard 已就位');

        // ══════ input 事件：最终文本捕获 ══════
        // input 在 DOM value 变更时触发。isComposing=false 时是最终文字。
        pb.addEventListener('input', function (e) {
            if (e.isComposing) return;  // 跳过中间态
            var text = pb.value || '';
            if (!text) return;
            pb.value = '';  // 清空，避免重复发送
            sendText(text);
        });

        // ══════ IME 组合事件（日志用）══════
        pb.addEventListener('compositionstart', function () {
            isComposing = true;
            pb.value = '';  // 清空旧值
            if (compositionTimer) clearTimeout(compositionTimer);
            compositionTimer = setTimeout(function () {
                if (isComposing) {
                    console.warn('[ime] 组合超时');
                    resetComposing();
                }
            }, 10000);
        });

        pb.addEventListener('compositionend', function () {
            resetComposing();
            // input 事件会紧接着触发并处理文本，这里不需要额外操作
        });

        pb.addEventListener('blur', function () {
            resetComposing();
            pb.value = '';
        });

        document.addEventListener('click', function () {
            if (isComposing) { resetComposing(); pb.value = ''; }
        });

        console.log('[ime] IME 就绪（input 事件模式）');
    }

    initWhenReady();
})();

// ============== 剪贴板同步（WeChat → 浏览器系统剪贴板）==============
// 定期读取 X11 剪贴板（xclip -o），同步到浏览器系统剪贴板。
// 用户可以在微信里复制文字，然后在浏览器外 Ctrl+V 粘贴。
// 注意：HTTP 页面不能用 navigator.clipboard API，改用 execCommand。
(function () {
    'use strict';
    if (window.__clipboardSyncLoaded) return;
    window.__clipboardSyncLoaded = true;

    var lastText = '';
    var syncTimer = null;

    function syncClipboard(text) {
        // 用 textarea + execCommand 方式（兼容 HTTP 页面）
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            console.log('[clipboard] 已同步: ' + text.substring(0, 40));
        } catch (e) {
            // execCommand 在某些情况下不可用，静默失败
        }
        document.body.removeChild(ta);
    }

    function startSync() {
        syncTimer = setInterval(function () {
            fetch('/_clipboard-text', { credentials: 'same-origin', cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (!d.ok || !d.text) return;
                    var text = d.text;
                    if (text && text !== lastText) {
                        lastText = text;
                        // 过滤二进制/URI 列表数据
                        if (text.startsWith('file://') || text.startsWith('x-special/')) return;
                        if (text.length > 100000) return; // 跳过超长文本
                        syncClipboard(text);
                    }
                }).catch(function () {});
        }, 2000);
    }

    // 等待 Xpra client 就绪后启动
    function waitForClient() {
        if (window.client && window.client.connected) {
            startSync();
            console.log('[clipboard] 剪贴板同步已启动 (2s)');
        } else {
            setTimeout(waitForClient, 1000);
        }
    }
    waitForClient();
})();

// ============== 文件下载监控（微信保存图片/文件 → 浏览器下载）==============
// 定期扫描微信文件目录，检测新文件后自动触发浏览器下载对话框。
// 首次加载时只记录已有文件，不触发下载；之后出现的新文件才自动下载。
(function () {
    'use strict';
    if (window.__downloadWatcherLoaded) return;
    window.__downloadWatcherLoaded = true;

    var knownKeys = {};
    var firstPoll = true;
    var lastPollSizes = {};  // 防止文件还在写入就下载（等待大小稳定）

    function triggerDownload(file) {
        var url = '/_download-file?path=' + encodeURIComponent(file.path);
        var a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { document.body.removeChild(a); }, 1000);
        var kb = (file.size / 1024).toFixed(1);
        console.log('[download] 下载: ' + file.name + ' (' + kb + ' KB)');
    }

    setInterval(function () {
        fetch('/_list-downloads', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d.ok || !d.files) return;

                d.files.forEach(function (file) {
                    var key = file.path + '|' + file.mtime + '|' + file.size;
                    var sizeKey = file.path + '|' + file.mtime;

                    if (firstPoll) {
                        // 首次轮询：只记录不下载
                        knownKeys[key] = true;
                        return;
                    }

                    if (knownKeys[key]) return;

                    // 检查文件是否还在写入（大小不变才算稳定）
                    if (lastPollSizes[sizeKey] === file.size && file.size > 0) {
                        knownKeys[key] = true;
                        triggerDownload(file);
                    }
                    lastPollSizes[sizeKey] = file.size;
                });

                if (firstPoll) {
                    firstPoll = false;
                    console.log('[download] 文件监控已启动 (3s)，已有 ' +
                        Object.keys(knownKeys).length + ' 个文件');
                }
            }).catch(function () {});
    }, 3000);
})();
