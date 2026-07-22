#!/bin/bash
# xwechat-xpra 窗口居中守护脚本
#
# 问题：
#   1. 微信窗口有固定尺寸约束，无法自适应浏览器窗口大小。
#      Xpra --resize-display 会动态调整虚拟屏幕尺寸以匹配浏览器，
#      但微信窗口不会跟着移动，导致视觉上"二维码偏了"。
#   2. 微信会创建一个 30×30 的系统托盘图标窗口（tray=True），
#      在 Xpra HTML5 客户端中会渲染为一个不断闪烁的 canvas。
#
# 解决：
#   1. 后台循环检测屏幕尺寸，用 xpra control move 把微信主窗口移到屏幕中央。
#   2. 自动隐藏托盘图标窗口（unmap），避免闪烁。
#   3. 只处理 tray=False 的主窗口，排除托盘图标。

DISPLAY="${DISPLAY:-:100}"

# 获取当前屏幕尺寸（Xpra resize-display 会随浏览器窗口动态变化）
get_screen_size() {
    local line current
    line=$(DISPLAY="$DISPLAY" xrandr 2>/dev/null | grep -m1 "^Screen 0:")
    current=$(echo "$line" | grep -oE 'current [0-9]+ x [0-9]+' | grep -oE '[0-9]+ x [0-9]+')
    if [ -n "$current" ]; then
        echo "$current" | tr -d ' ' | tr 'x' ' '
        return 0
    fi
    return 1
}

# 获取微信主窗口 ID（排除托盘图标窗口）
# 通过查找 class-instance 含 wechat 且 tray=False 的窗口
get_wechat_main_wid() {
    local info wid
    info=$(DISPLAY="$DISPLAY" xpra info "${DISPLAY}" 2>/dev/null)
    if [ -z "$info" ]; then
        return 1
    fi
    # 找出所有 wechat 窗口 ID
    local wids
    wids=$(echo "$info" | grep -oE "^windows\.[0-9]+\.class-instance.*wechat" \
           | grep -oE '^windows\.[0-9]+' | grep -oE '[0-9]+')
    for wid in $wids; do
        # 检查这个窗口是否 tray=False（主窗口）
        local is_tray
        is_tray=$(echo "$info" | grep -E "^windows\.${wid}\.tray=" | cut -d= -f2)
        if [ "$is_tray" = "False" ]; then
            echo "$wid"
            return 0
        fi
    done
    return 1
}

# 获取托盘图标窗口 ID（需要隐藏的）
get_wechat_tray_wids() {
    local info
    info=$(DISPLAY="$DISPLAY" xpra info "${DISPLAY}" 2>/dev/null)
    if [ -z "$info" ]; then
        return 1
    fi
    local wids
    wids=$(echo "$info" | grep -oE "^windows\.[0-9]+\.class-instance.*wechat" \
           | grep -oE '^windows\.[0-9]+' | grep -oE '[0-9]+')
    for wid in $wids; do
        local is_tray
        is_tray=$(echo "$info" | grep -E "^windows\.${wid}\.tray=" | cut -d= -f2)
        if [ "$is_tray" = "True" ]; then
            echo "$wid"
        fi
    done
}

# 获取指定窗口的尺寸
get_window_size() {
    local wid="$1"
    local size
    size=$(DISPLAY="$DISPLAY" xpra info "${DISPLAY}" 2>/dev/null \
           | grep -E "^windows\.${wid}\.size=" | head -1 | cut -d= -f2)
    if [ -n "$size" ]; then
        echo "$size" | tr -d '()' | tr ',' ' '
        return 0
    fi
    return 1
}

# 隐藏托盘图标窗口（避免 30×30 canvas 闪烁）
hide_tray_windows() {
    local tray_wids wid
    tray_wids=$(get_wechat_tray_wids)
    for wid in $tray_wids; do
        # unmap 隐藏窗口（比 close 更温和，不会杀进程）
        DISPLAY="$DISPLAY" xpra control "${DISPLAY}" unmap "$wid" 2>/dev/null
    done
}

# 把微信主窗口移动到屏幕中央
center_wechat() {
    local screen w h wid win_w win_h x y
    screen=$(get_screen_size)
    [ -z "$screen" ] && return 1

    # 解析屏幕尺寸
    w=$(echo "$screen" | awk '{print $1}')
    h=$(echo "$screen" | awk '{print $2}')
    [ -z "$w" ] || [ -z "$h" ] && return 1

    # 没有浏览器客户端连接时，屏幕保持 8192x4096 默认值。
    # 此时把微信窗口移到 (0,0)，避免它停留在屏幕"中央"(3885,1763)
    # ——那个位置在浏览器连接后屏幕缩小时会超出可视区。
    if [ "$w" -ge 4000 ] || [ "$h" -ge 2000 ]; then
        wid=$(get_wechat_main_wid)
        [ -z "$wid" ] && return 1
        DISPLAY="$DISPLAY" xpra control "${DISPLAY}" move "$wid" 0 0 2>/dev/null
        return 0
    fi

    wid=$(get_wechat_main_wid)
    [ -z "$wid" ] && return 1

    # 获取主窗口尺寸
    local size_str
    size_str=$(get_window_size "$wid")
    win_w=$(echo "$size_str" | awk '{print $1}')
    win_h=$(echo "$size_str" | awk '{print $2}')
    win_w="${win_w:-420}"
    win_h="${win_h:-570}"

    # 如果窗口尺寸接近屏幕尺寸（差值<=10），说明窗口已最大化/全屏，
    # 直接放在 (0,0) 即可，不需要居中偏移
    local dw dh
    dw=$(( w - win_w ))
    dh=$(( h - win_h ))
    if [ "$dw" -ge 0 ] && [ "$dw" -le 10 ] && [ "$dh" -ge 0 ] && [ "$dh" -le 10 ]; then
        x=0
        y=0
    else
        # 计算居中坐标
        x=$(( (w - win_w) / 2 ))
        y=$(( (h - win_h) / 2 ))
        [ "$x" -lt 0 ] && x=0
        [ "$y" -lt 0 ] && y=0
    fi

    DISPLAY="$DISPLAY" xpra control "${DISPLAY}" move "$wid" "$x" "$y" 2>/dev/null
    return 0
}

# 主循环
while true; do
    hide_tray_windows 2>/dev/null
    center_wechat 2>/dev/null
    sleep 2
done
