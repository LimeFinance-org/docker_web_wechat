#!/bin/bash
# 微信启动包装脚本
#
# 问题：微信启动时 Xvfb 屏幕是 8192x4096（默认最大值），
#       微信计算"居中"位置得到 (3885, 1763)。
#       当浏览器连接后 --resize-display 把屏幕缩小到浏览器窗口大小，
#       这个位置就超出可视区，导致微信窗口（含登录按钮）显示在屏幕外。
#
# 解决：在启动微信前，用 xrandr 添加并切换到合理的小尺寸模式（1280x720），
#       这样微信计算的"居中"位置为 ((1280-420)/2, (720-570)/2) = (430, 75)，
#       在浏览器连接后屏幕缩小时仍在可视区内。

DISPLAY="${DISPLAY:-:100}"

# 等待 X server 就绪
for i in $(seq 1 10); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

# 添加 1280x720 模式（Xvfb 默认只有 8192x4096，需要先添加新模式）
# 使用标准 VESA CVT 模型ine
xrandr --display "$DISPLAY" --newmode "1280x720_60.00" 74.50 1280 1344 1472 1664 720 723 728 748 -hsync +vsync 2>/dev/null
xrandr --display "$DISPLAY" --addmode screen "1280x720_60.00" 2>/dev/null
# 切换到 1280x720
xrandr --display "$DISPLAY" --output screen --mode "1280x720_60.00" 2>/dev/null

# 等待分辨率生效
sleep 1

# 启动微信
exec /usr/bin/wechat
