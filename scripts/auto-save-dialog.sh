#!/bin/bash
# 微信"另存为"对话框自动保存助手
#
# 原理：每 0.5 秒检测是否有文件保存对话框弹出。
# 如果检测到，自动填入 /root/downloads/ 路径并按回车保存，
# 文件就会被写入 /root/downloads/ 目录。
# 浏览器端的 notify-inject.js 文件监控会检测到新文件并触发下载。
#
# 支持常见的文件对话框窗口标题：
#   - Save As / 另存为 / 保存文件 / Save File
#   - Choose a File / 选择文件

set -e
DISPLAY="${DISPLAY:-:10}"
SAVE_DIR="/root/downloads"

mkdir -p "$SAVE_DIR"

echo "[auto-save] 文件对话框自动保存助手已启动，目标目录: $SAVE_DIR"
echo "[auto-save] DISPLAY=$DISPLAY"

# 记录已处理过的窗口 ID，避免重复处理
declare -A HANDLED_WINDOWS

# 定期清理计数器（每 60 轮 = 30 秒清理一次旧文件）
CLEANUP_COUNTER=0

while true; do
    # ====== 定期清理超过 30 分钟的旧文件 ======
    CLEANUP_COUNTER=$((CLEANUP_COUNTER + 1))
    if [ $CLEANUP_COUNTER -ge 60 ]; then
        CLEANUP_COUNTER=0
        find "$SAVE_DIR" -type f -mmin +30 -delete 2>/dev/null || true
        find /tmp/wechat-paste -type f -mmin +30 -delete 2>/dev/null || true
    fi

    # 获取所有窗口列表
    windows=$(wmctrl -l 2>/dev/null || true)

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue

        # 提取窗口 ID 和标题
        wid=$(echo "$line" | awk '{print $1}')
        title=$(echo "$line" | cut -d' ' -f4-)

        # 检查是否是文件保存对话框（匹配常见关键词）
        is_save_dialog=0
        for kw in "Save As" "Save" "save" "另存为" "保存" "Save File" \
                   "Choose a File" "选择文件" "Select File" "Open File" \
                   "打开文件" "Browse" "浏览"; do
            if [[ "$title" == *"$kw"* ]]; then
                is_save_dialog=1
                break
            fi
        done

        [[ $is_save_dialog -eq 0 ]] && continue

        # 跳过已处理的窗口
        if [[ -n "${HANDLED_WINDOWS[$wid]}" ]]; then
            continue
        fi

        echo "[auto-save] 检测到文件保存对话框: [$wid] $title"

        # 激活对话框窗口
        xdotool windowactivate "$wid" 2>/dev/null || true
        sleep 0.5

        # 生成随机文件名（wechat_save_<时间戳>_<随机>.<ext>）
        # 先用 xprop 获取对话框的 WM_CLASS，判断来源
        # 大部分微信保存的图片是 jpg/png，文件无后缀时浏览器无法识别
        RAND_NAME="wechat_save_$(date +%s)_$RANDOM.jpg"

        # 模拟键盘输入完整路径（目录 + 文件名）
        # 先 Tab 到文件名输入框（大多数 GTK/Qt 对话框的文件名框是第一个可编辑控件）
        # 用 Ctrl+A 全选当前路径再覆盖
        xdotool key ctrl+a 2>/dev/null || true
        sleep 0.1
        # 输入完整路径：目录 + 随机文件名
        xdotool type "$SAVE_DIR/$RAND_NAME" 2>/dev/null || true
        sleep 0.3
        # 确认保存（回车）
        xdotool key Return 2>/dev/null || true
        sleep 0.5

        # 如果存在同名文件确认覆盖对话框，再按一次回车
        xdotool key Return 2>/dev/null || true
        sleep 0.2

        echo "[auto-save] 已自动保存到: $SAVE_DIR/$RAND_NAME"
        HANDLED_WINDOWS[$wid]=1
    done <<< "$windows"

    sleep 0.5
done
