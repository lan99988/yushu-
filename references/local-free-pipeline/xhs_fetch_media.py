#!/usr/bin/env python3
"""小红书视频免登录下载（XHS-Downloader 解析 + CDN 直链重试）

用法:
    python xhs_fetch_media.py <小红书分享链接或网页链接> <输出.mp4>

依赖:
    pip install curl_cffi
    另需 XHS-Downloader 仓库（仅用其 source 模块解析，不跑其 GUI/CLI）:
        git clone https://github.com/JoeanAmier/XHS-Downloader.git
    通过环境变量 XHS_DOWNLOADER_HOME 指定其路径（默认 ../XHS-Downloader）。

原理:
    1. 用 XHS-Downloader 的 source.XHS().extract(url, download=False) 解析作品，
       无需任何登录态，返回 JSON 含 "下载地址"（sns-*.xhscdn.com CDN 直链）。
    2. 直链带 Referer: https://www.xiaohongshu.com/ 用 curl_cffi（chrome 指纹）下载。
    3. 小红书 CDN 与 API 一样按请求随机 403（IP 风控概率放行），
       所以用重试循环（默认 8 轮、间隔 12 秒），实测 1-2 轮内必过。
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

XHS_HOME = Path(os.environ.get("XHS_DOWNLOADER_HOME", "../XHS-Downloader")).resolve()
sys.path.insert(0, str(XHS_HOME))

MAX_RETRY = int(os.environ.get("XHS_FETCH_RETRY", "8"))
RETRY_INTERVAL = int(os.environ.get("XHS_FETCH_INTERVAL", "12"))

REFERER_HEADERS = {
    "Referer": "https://www.xiaohongshu.com/",
    "Origin": "https://www.xiaohongshu.com",
}


def extract_download_urls(page_url: str) -> dict:
    """解析作品页，返回作品信息 dict（含 下载地址 列表）。无登录态。"""
    from source import XHS

    async def _run():
        async with XHS(download_record=False, video_download=False,
                       image_download=False, record_data=False, note_format="") as xhs:
            return await xhs.extract(page_url, download=False)

    data = asyncio.run(_run())
    if not data:
        raise SystemExit("解析失败：extract 返回空（链接失效、需要 xsec_token 或风控全拒）")
    return data[0]


def download(url: str, dest: Path) -> None:
    """带 Referer 下载直链，随机 403 时重试。"""
    from curl_cffi import requests

    for attempt in range(1, MAX_RETRY + 1):
        resp = requests.get(url, headers=REFERER_HEADERS, impersonate="chrome131", timeout=120)
        if resp.status_code == 200:
            dest.write_bytes(resp.content)
            print(f"下载成功: {dest} ({len(resp.content) / 1048576:.1f} MB, 第 {attempt} 次尝试)")
            return
        print(f"[{attempt}/{MAX_RETRY}] {resp.status_code}，{RETRY_INTERVAL}s 后重试…")
        time.sleep(RETRY_INTERVAL)
    raise SystemExit(f"下载失败：{MAX_RETRY} 轮重试均被拒绝（IP 风控），稍后或换网络再试")


def retention_cleanup() -> None:
    """保留期自动清理（每次下载结束后执行，最佳努力，失败不影响下载结果）。

    策略（2026-10-05 用户定稿）：媒体 3 天、转写文本 30 天、.download-* 临时目录 3 天。
    """
    media_ext = {".m4a", ".mp4", ".wav", ".mp3", ".aac", ".webm", ".flv", ".part", ".m4s"}
    text_ext = {".txt", ".md"}
    media_days, text_days, temp_days = 3, 30, 3
    now = time.time()

    def age(p: Path) -> float:
        return (now - p.stat().st_mtime) / 86400

    def rm(p: Path) -> None:
        try:
            shutil.rmtree(p) if p.is_dir() else p.unlink()
        except OSError:
            pass

    state_root = Path(os.environ.get(
        "VTRANS_STATE_ROOT", Path.home() / ".agent-apps/video-transcript-candidate/private"))
    jobs_dir = state_root / "jobs"
    if jobs_dir.exists():
        for job in jobs_dir.iterdir():
            media_root = job / "media"
            if not media_root.exists():
                continue
            for item in media_root.iterdir():
                try:
                    d = age(item)
                except OSError:
                    continue
                if item.name.startswith(".download-"):
                    if d > temp_days:
                        rm(item)
                elif item.suffix.lower() in media_ext and d > media_days:
                    rm(item)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    page_url, dest = sys.argv[1], Path(sys.argv[2])

    info = extract_download_urls(page_url)
    print(json.dumps({k: info.get(k) for k in ("作品标题", "作品类型", "发布时间", "作者昵称")},
                     ensure_ascii=False, indent=2))
    urls = [u for u in (info.get("下载地址") or []) if u]
    if not urls:
        raise SystemExit("解析成功但没有下载地址（可能是图文作品）")

    # 多个地址时取第一个（视频作品通常只有一个）；也可以逐个下载
    download(urls[0], dest)

    # 完整性校验：mp4 的 ftyp box 应在文件头
    head = dest.read_bytes()[:12]
    if b"ftyp" not in head:
        raise SystemExit("警告：文件头不含 ftyp，可能下载到的是网页而非视频")

    retention_cleanup()


if __name__ == "__main__":
    main()
