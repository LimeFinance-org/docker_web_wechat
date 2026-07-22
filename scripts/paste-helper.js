/**
 * paste-helper.js - 支持 Ctrl+V 粘贴文件/图片到微信对话框
 *
 * 原理：
 *   1. 监听浏览器的 paste 事件，提取剪贴板中的图片/文件
 *   2. 图片：通过 Xpra 的 send_clipboard_token 写入 X11 剪贴板，
 *      微信检测到剪贴板有图片后会自动粘贴到对话框
 *   3. 文件：通过 Xpra 的 send_file 上传到服务器，由 --open-files 自动打开
 */
(function () {
    'use strict';

    if (window.__pasteHelperLoaded) return;
    window.__pasteHelperLoaded = true;

    /**
     * 等待 Xpra client 就绪
     */
    function getClient() {
        // Xpra HTML5 客户端的 client 是全局变量
        if (window.client && window.client.connected) {
            return window.client;
        }
        return null;
    }

    /**
     * 将 Blob 转为 Uint8Array
     */
    function blobToUint8(blob) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () {
                resolve(new Uint8Array(reader.result));
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(blob);
        });
    }

    /**
     * 发送图片到 Xpra 剪贴板
     * Xpra 的 send_clipboard_token(data, [format]) 会通知服务器剪贴板有新内容
     */
    function sendImageToClipboard(uint8data, mimeType) {
        var client = getClient();
        if (!client) {
            console.warn('[paste-helper] Xpra client 未就绪，无法发送图片');
            return false;
        }

        try {
            // 设置剪贴板缓冲区，这样当服务器请求剪贴板内容时能返回正确数据
            client.clipboard_buffer = uint8data;
            client.clipboard_datatype = mimeType;

            // 发送 clipboard-token 通知服务器
            // 参数: (data, [format_array])
            // format_array 告诉服务器剪贴板内容的可用格式
            client.send_clipboard_token(uint8data, [mimeType]);
            console.log('[paste-helper] 已发送图片到剪贴板:', mimeType, uint8data.length, 'bytes');

            // 延迟模拟 Ctrl+V 让微信粘贴
            // 因为微信需要检测到剪贴板变化才会启用粘贴
            setTimeout(function () {
                try {
                    // 发送 Ctrl+V 按键到 Xpra 服务器
                    // key codes: Control_L=37, V=55 (keysym)
                    client.send(['key-action', 0, 'Control_L', true, 1, ['control'], 0, '']);
                    client.send(['key-action', 0, 'v', true, 1, ['control'], 0, '']);
                    client.send(['key-action', 0, 'v', false, 1, ['control'], 0, '']);
                    client.send(['key-action', 0, 'Control_L', false, 1, [], 0, '']);
                    console.log('[paste-helper] 已模拟 Ctrl+V 粘贴');
                } catch (e) {
                    console.error('[paste-helper] 模拟 Ctrl+V 失败:', e);
                }
            }, 200);

            return true;
        } catch (e) {
            console.error('[paste-helper] 发送图片到剪贴板失败:', e);
            return false;
        }
    }

    /**
     * 通过 Xpra 文件传输上传文件
     * client.send_file(file) 接受 File 对象
     */
    function uploadFile(file) {
        var client = getClient();
        if (!client) {
            console.warn('[paste-helper] Xpra client 未就绪，无法上传文件');
            return false;
        }

        try {
            // Xpra 的 send_file 方法接受 File 对象
            client.send_file(file);
            console.log('[paste-helper] 已上传文件:', file.name, file.size, 'bytes');
            return true;
        } catch (e) {
            console.error('[paste-helper] 上传文件失败:', e);
            return false;
        }
    }

    /**
     * 处理 paste 事件
     */
    document.addEventListener('paste', function (event) {
        var items = event.clipboardData && event.clipboardData.items;
        if (!items) return;

        var handled = false;

        for (var i = 0; i < items.length; i++) {
            var item = items[i];

            // 处理图片
            if (item.type && item.type.indexOf('image/') === 0) {
                var blob = item.getAsFile();
                if (!blob) continue;

                handled = true;
                event.preventDefault();

                console.log('[paste-helper] 检测到粘贴图片:', item.type, blob.size, 'bytes');

                blobToUint8(blob).then(function (uint8) {
                    sendImageToClipboard(uint8, item.type || 'image/png');
                }).catch(function (err) {
                    console.error('[paste-helper] 读取图片数据失败:', err);
                });
            }

            // 处理文件（非图片）
            else if (item.kind === 'file' && (!item.type || item.type.indexOf('image/') !== 0)) {
                var file = item.getAsFile();
                if (!file) continue;

                handled = true;
                event.preventDefault();

                console.log('[paste-helper] 检测到粘贴文件:', file.name, file.size, 'bytes');
                uploadFile(file);
            }
        }

        if (handled) {
            console.log('[paste-helper] 粘贴事件已处理');
        }
    });

    console.log('[paste-helper] 文件粘贴助手已加载 (等待 Xpra client 就绪)');
})();
