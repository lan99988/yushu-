# 小红书"视频 → 文字"本地免费方案（无登录、无额度）

2026-10-05 实测打通的补充管线：当插件渠道被小红书 IP 风控/登录墙卡住时，这条路径仍能把视频拿下来并完成转写。**全程免费、无听悟额度消耗、数据不出本机。**

实测样例：612.6 秒长视频（10 分 12 秒），解析→下载 24.4 MB→本地转写 3176 字，1 分 40 秒完成。

## 管线总览

```
小红书分享链接
   │  ① XHS-Downloader source.XHS().extract(url, download=False) 解析（免登录）
   ▼
CDN 直链（sns-*.xhscdn.com/...mp4）
   │  ② curl_cffi（chrome 指纹）+ Referer: xiaohongshu.com 下载，随机 403 重试
   ▼
long_video.mp4
   │  ③ ffmpeg → 16k 单声道 wav
   ▼
   │  ④ sherpa-onnx + Paraformer-zh int8，60 秒分块解码
   ▼
转写.txt（全文 + 分钟级分段时间戳）
```

## 关键实测结论（踩坑记录）

1. **解析免登录**：XHS-Downloader 的 `extract(download=False)` 只走页面解析，返回的 JSON 里带 `下载地址`（CDN 直链），不需要 web_session。
2. **CDN 与 API 一样是"按请求随机风控"**：同一个直链首两次 403，带 `Referer: https://www.xiaohongshu.com/` + chrome 指纹后重试 1 轮即 200。所以**重试循环（≥3 轮、间隔 12s）是正解**，单次失败不代表链接失效。
3. **递归找直链时注意**：`下载地址` 是 **list**，遍历返回结构时别只查 dict 的字符串值（首版实现漏了列表内的字符串，误把"作品链接"当直链下载，拿到的是 HTML）。
4. **下载后必须校验文件头**：`ftyp` box 应在文件头 12 字节内，防止把网页当视频存下来。
5. **直链有时效**：解析完立刻下载，直链不能存起来以后用。
6. **本机 spawnSync 一律 EBUSY 的宿主**：转写脚本全用异步 spawn。

## 使用

### ① 下载

```bash
git clone https://github.com/JoeanAmier/XHS-Downloader.git
pip install curl_cffi
export XHS_DOWNLOADER_HOME=/path/to/XHS-Downloader
python references/local-free-pipeline/xhs_fetch_media.py "https://xhslink.cn/o/xxxx" video.mp4
```

环境变量：`XHS_FETCH_RETRY`（重试轮数，默认 8）、`XHS_FETCH_INTERVAL`（间隔秒，默认 12）。

### ② 转写

```bash
pip install sherpa_onnx numpy
# 模型（227MB int8）:
# https://modelscope.cn/models/pengzhendong/sherpa-onnx-paraformer-zh/resolve/master/
#   model.int8.onnx + tokens.txt 放同一目录
export VTRANS_PARAFORMER_MODEL=/path/to/sherpa-paraformer-zh
node references/local-free-pipeline/local_transcribe.js video.mp4
```

可选环境变量：`VTRANS_PYTHON`、`FFMPEG`（默认走 PATH）。

## 局限（与听悟渠道对比）

| 维度 | 本地方案 | 听悟渠道 |
|---|---|---|
| 费用/额度 | 无 | 有额度限制 |
| 登录 | 全程无 | 需听悟登录 |
| 标点/分段 | 无标点，机器分段 | 有 |
| 说话人分离 | 无 | 有 |
| 专有名词 | 易错（无热词机制，实测 Huberman→"cuberman"） | 较准 |
| 时间戳 | 分钟级（60s 分块） | 句级 |
| 稳定性 | 依赖小红书未公开接口，改版可能失效 | 官方接口 |

结论：本地方案定位为**兜底层**——免费、无登录、可离线，但产出需人工校对专有名词；对质量要求高的正式稿件仍走听悟渠道。

## 合规提示

免登录解析依赖小红书网页接口的当前行为，属灰色地带，仅适合个人低频使用；请勿用于批量抓取或商业用途。
