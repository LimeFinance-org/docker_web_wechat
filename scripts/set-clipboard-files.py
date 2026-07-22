#!/usr/bin/env python3
"""
set-clipboard-files.py - 把文件路径写入 X11 剪贴板（text/uri-list 格式）

用法：
    python3 set-clipboard-files.py /path/to/file1 /path/to/file2

原理：
    通过 xclip 把文件 URI 以 text/uri-list 格式写入 CLIPBOARD selection，
    微信 Linux 版检测到剪贴板中有文件 URI 后会自动粘贴文件。
"""
import sys
import os
import subprocess


def main():
    if len(sys.argv) < 2:
        print("用法: set-clipboard-files.py <file1> [file2] ...", file=sys.stderr)
        sys.exit(1)

    files = sys.argv[1:]
    # 构造 text/uri-list 格式（RFC 2483）
    uris = []
    for f in files:
        abs_path = os.path.abspath(f)
        uri = f"file://{abs_path}"
        uris.append(uri)

    uri_list = "\r\n".join(uris) + "\r\n"
    print(f"[set-clip] 设置剪贴板: {uri_list.strip()}", flush=True)

    # 用 xclip 设置 text/uri-list 格式的 CLIPBOARD
    try:
        result = subprocess.run(
            ["xclip", "-selection", "clipboard", "-t", "text/uri-list"],
            input=uri_list.encode("utf-8"),
            capture_output=True,
            timeout=5
        )
        if result.returncode == 0:
            print("[set-clip] xclip 设置成功", flush=True)
            sys.exit(0)
        else:
            print(f"[set-clip] xclip 失败: {result.stderr.decode()}", flush=True, file=sys.stderr)
    except FileNotFoundError:
        print("[set-clip] xclip 未安装", flush=True, file=sys.stderr)

    # 尝试用 xsel 作为备选
    try:
        result = subprocess.run(
            ["xsel", "--clipboard", "--input"],
            input=uri_list.encode("utf-8"),
            capture_output=True,
            timeout=5
        )
        if result.returncode == 0:
            print("[set-clip] xsel 设置成功（text/plain 格式）", flush=True)
            sys.exit(0)
        else:
            print(f"[set-clip] xsel 失败: {result.stderr.decode()}", flush=True, file=sys.stderr)
    except FileNotFoundError:
        pass

    print("[set-clip] 无可用的剪贴板工具（xclip/xsel）", flush=True, file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
