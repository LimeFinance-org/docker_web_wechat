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
// 和图片/文件粘贴完全相同的思路：用 paste 事件捕获数据。
//
// 原理：
//   - 浏览器 IME 在 pasteboard textarea 上组合中文
//   - 组合完成时，部分浏览器会触发 paste 事件（data 含最终文本）
//   - 如果没触发 paste，则用 input 事件（isComposing=false）兜底
//   - 文本通过 /_type-text 端点用 xdotool type 输入到微信
(function () {
    'use strict';
    if (window.__imeHelperLoaded) return;
    window.__imeHelperLoaded = true;

    function sendText(text) {
        if (!text || !text.trim()) return;
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

        pb.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;' +
            'opacity:0;pointer-events:none;z-index:999999;resize:none;' +
            'border:none;outline:none;padding:0;margin:0';
        console.log('[ime] pasteboard 已就位');

        var lastSent = '';
        var sendTimer = null;

        // ══════ 唯一触发：input 事件 ══════
        // IME 组合完成（空格/回车/点击候选词）后，pasteboard.value 更新，
        // 浏览器触发 input 事件且 e.isComposing === false。
        // 用防抖合并连续输入（避免漏字），300ms 内的输入合并为一次发送。
        pb.addEventListener('input', function (e) {
            // 组合中不处理
            if (e.isComposing) {
                window.__imeComposing = true;
                return;
            }
            window.__imeComposing = false;

            var text = (pb.value || '').trim();
            if (!text) return;

            // 防抖：300ms 内的连续输入合并
            if (sendTimer) clearTimeout(sendTimer);
            sendTimer = setTimeout(function () {
                var finalText = (pb.value || '').trim();
                if (finalText && finalText !== lastSent) {
                    lastSent = finalText;
                    sendText(finalText);
                    pb.value = '';  // 清空，准备下一次输入
                }
            }, 300);
        });

        // composition 事件仅用于设置状态标志（供剪贴板同步模块检查）
        pb.addEventListener('compositionstart', function () {
            window.__imeComposing = true;
        });
        pb.addEventListener('compositionend', function () {
            window.__imeComposing = false;
            // compositionend 后立即检查 value（某些浏览器 input 不触发）
            setTimeout(function () {
                var text = (pb.value || '').trim();
                if (text && text !== lastSent) {
                    lastSent = text;
                    sendText(text);
                    pb.value = '';
                }
            }, 50);
        });

        pb.addEventListener('blur', function () {
            window.__imeComposing = false;
        });

        console.log('[ime] IME 就绪（input 防抖 + compositionend 兜底）');
    }

    initWhenReady();
})();

// ============== 剪贴板同步（WeChat → 浏览器系统剪贴板）==============
// 原理：定时轮询 X11 剪贴板（xclip -o），缓存最新文本；在用户交互（点击、
// 输入法确认等用户手势事件）中调用 execCommand('copy') 写入系统剪贴板。
//
// 关键：HTTP 页面 execCommand('copy') 需要用户手势才能生效，
// setInterval 中调用会静默失败。所以采用"缓存+手势触发"模式。
(function () {
    'use strict';
    if (window.__clipboardSyncLoaded) return;
    window.__clipboardSyncLoaded = true;

    var cachedText = '';
    var lastApplied = '';

    function tryApplyClipboard() {
        if (!cachedText || cachedText === lastApplied) return;
        // 过滤二进制/URI 列表
        if (cachedText.startsWith('file://') || cachedText.startsWith('x-special/')) return;
        if (cachedText.length > 50000) return;
        // IME 组合期间绝对不能动焦点（会杀死中文输入）
        if (window.__imeComposing) return;

        var ta = document.createElement('textarea');
        ta.value = cachedText;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        document.body.appendChild(ta);
        // 用 Selection API 而非 focus()，减少对 pasteboard 焦点的影响
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(ta);
        sel.removeAllRanges();
        sel.addRange(range);
        try {
            var ok = document.execCommand('copy');
            if (ok) {
                lastApplied = cachedText;
                console.log('[clipboard] 同步: ' + cachedText.substring(0, 40));
            }
        } catch (e) {}
        sel.removeAllRanges();
        document.body.removeChild(ta);
    }

    // 后台轮询 X11 剪贴板（不需要用户手势，仅读取和缓存）
    setInterval(function () {
        fetch('/_clipboard-text', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.ok && d.text && d.text.trim()) {
                    cachedText = d.text;
                }
            }).catch(function () {});
    }, 1500);

    // 只在 click 时尝试同步（用户主动点击，不会干扰 IME）
    // 注意：不再在 compositionend/keydown 时触发，避免抢焦点
    document.addEventListener('click', tryApplyClipboard, true);

    console.log('[clipboard] 剪贴板同步就绪（缓存+手势触发）');
})();

// ============== 文件下载监控（微信保存图片/文件 → 浏览器下载）==============
// 定期扫描微信文件目录，检测新文件后自动触发浏览器下载。
// 微信"另存为"会弹出容器内文件对话框（无法阻止），但文件保存后会自动触发浏览器下载。
(function () {
    'use strict';
    if (window.__downloadWatcherLoaded) return;
    window.__downloadWatcherLoaded = true;

    var knownKeys = {};
    var firstPoll = true;
    var pendingFiles = {};  // 等待大小稳定的文件: key -> {file, lastSize}

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

        // 下载后 3 分钟删除临时文件（仅在 /root/downloads 和 /tmp 中）
        if (file.path.indexOf('/root/downloads') === 0 ||
            file.path.indexOf('/tmp/wechat-paste') === 0) {
            setTimeout(function () {
                fetch('/_delete-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: file.path }),
                    credentials: 'same-origin'
                }).then(function (r) { return r.json(); })
                  .then(function (d) {
                      if (d.ok) console.log('[download] 已清理: ' + file.name);
                  }).catch(function () {});
            }, 180000);  // 3 分钟
        }
    }

    setInterval(function () {
        fetch('/_list-downloads', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d.ok || !d.files) return;

                d.files.forEach(function (file) {
                    var key = file.path + '|' + file.mtime + '|' + file.size;
                    var sizeKey = file.path + '|' + file.name;

                    if (firstPoll) {
                        knownKeys[key] = true;
                        return;
                    }
                    if (knownKeys[key]) return;

                    // 文件大小稳定（写入完成）才触发下载
                    var prev = pendingFiles[sizeKey];
                    if (prev && prev.lastSize === file.size && file.size > 0) {
                        knownKeys[key] = true;
                        delete pendingFiles[sizeKey];
                        triggerDownload(file);
                    } else {
                        pendingFiles[sizeKey] = { file: file, lastSize: file.size, seen: Date.now() };
                    }
                });

                // 清理超时未稳定的待定文件（30 秒）
                var now = Date.now();
                Object.keys(pendingFiles).forEach(function (k) {
                    if (now - pendingFiles[k].seen > 30000) {
                        delete pendingFiles[k];
                    }
                });

                if (firstPoll) {
                    firstPoll = false;
                    console.log('[download] 文件监控启动 (1.5s)，已有 ' +
                        Object.keys(knownKeys).length + ' 个文件');
                }
            }).catch(function () {});
    }, 1500);
})();
