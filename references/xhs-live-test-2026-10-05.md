# 小红书真实链接测试报告

日期：2026-10-05 01:45-01:47（北京时间） · 插件：video-transcript 0.3.0-rc.2 候选版 · 机器：腾讯云上海（机房 IP）

## 结果：3/3 通过 ✅

| # | 视频 | 时长 | 容器/音轨 | 大小 | 渠道链 | 尝试次数 |
|---|---|---|---|---|---|---|
| 1 | 世界上最好的洗衣液成本居然只要5毛钱1斤 | 344.6s | mp4 / aac | 2.7MB | xiaohongshu_page → download | 2 |
| 2 | 教你用最低成本健脾 | 158.5s | mp4 / aac | 2.4MB | xiaohongshu_page → download | 1 |
| 3 | 健身邪修补剂（十二）——痰 | 179.2s | mp4 / aac | 1.4MB | xiaohongshu_page → download | 1 |

三例均为：分享短链（xhslink.cn）→ 平台适配器展开（保留服务端 xsec_token）→ 解析出真实媒体流 → 下载 → ffprobe 验证（音轨/时长/容器/SHA256）→ stage `media_ready`。

job_id：`vt-edd56b1a094a…`、`vt-f86c75255f239…`、`vt-0b33aa8319e9e…`（证据存于私有状态目录 jobs/）。

## 过程中解决的问题

1. **`executableOnPath` spawnSync EBUSY**（插件缺陷·已修复）：`media.js` 用 `spawnSync(where.exe)` 探测工具，在本机宿主环境必挂，导致 doctor 检测不到已装依赖、媒体验证报 DEPENDENCY_MISSING。改为纯 JS 扫描 PATH，不创建子进程。已推送上游（`5ef247e`）。
2. **补齐本地依赖**：ffmpeg/ffprobe 6.1.1（npmmirror 二进制镜像）+ yt-dlp 2026.08.19（阿里云 pip 源）。GitHub 直连下载仅 ~25KB/s，国内镜像秒下。
3. **风控规律确认**：IP 层风控按请求随机放行/拒绝（300012、登录墙、INTERNAL_ERROR 混合出现）。登录态 + 短链服务端 token 后，重试 1-6 次内必过。yt-dlp 渠道对小红书报 LOGIN_REQUIRED（需 cookies，属预期降级）。

## 距正式版 0.3.0 还差什么

- 本轮 3 例均 <600 秒；发布门槛要求含 **≥600 秒长视频**样例
- `submit` 提交听悟取**真实原稿**（需在候选入口 `login` 登录听悟）+ 人工确认口播
- 上述完成后运行 `acceptance-report` 生成验收清单（request_id 需以 `qa-v030-` 开头，本轮已符合）
