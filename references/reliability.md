# 0.3.0 候选版可靠性接口

当前候选版为 `0.3.0-rc.2`。本轮发布范围为 B站、抖音、小红书，各三个不同的有口播视频。每平台覆盖分享短链、普通页面及至少600秒的较长视频；九例全部实际取得听悟原稿才可正式发布。候选版测试目录不修改正式入口。

## 命令

```powershell
node scripts/cli.js acquire --request-id stable-media-id --source '视频分享文本、URL或本地文件'
node scripts/cli.js resume --job-id vt-xxxxxxxxxxxxxxxxxxxxxxxx --wait 60
node scripts/cli.js media-login --platform yuanbao --wait 180
node scripts/cli.js media-session-import --platform bilibili --source '指定Cookie文件'
node scripts/cli.js doctor --check-login true
```

平台标识：bilibili/douyin/kuaishou/xiaohongshu/weibo/tencent/iqiyi/youku/xigua/wechat/yuanbao/x/youtube。视频号来源登录映射到 yuanbao；元宝 Cookie 只用于元宝同源接口，不随媒体下载传递。

兼容旧 JSON invoke 请求结构、request_id、退出码及旧任务。resolve 与 acquire/submit 分别使用不同稳定请求 ID。acquire 任务保持 prepared、stage=media_ready；resume 会按 acquisition_only 标记继续取得媒体，不擅自转为提交。

## 恢复

读取 stage、attempts、error.category、error.next。有 trans_id/task_id/remote_name 的任务只查询与取稿。submission_unknown/uploading 缺身份时人工关联确切任务；禁止把最新任务当作本次任务。登录、验证码、限流或元宝未知字段均停止自动切换。浏览器进程退出后的遗留锁用 unlock 清理，先确认持锁进程确已退出。

媒体缓存使用 SHA256 核验，冲突不覆盖。下载临时文件验证通过才登记；无声音候选不上传。HLS 分片和重定向逐目的地检查公网地址；yt-dlp 经过仅本机监听的公网边界代理。Node >=22 可作为 YouTube JS 运行时；doctor 报告依赖可用性，不能证明目标视频可下载。

原稿和段落以 raw-commit.json 提交记录恢复；目标文件摘要冲突时停止。AI 产物另存版本，不覆盖原稿。适配 JSON 是主记录，Markdown 可重建，文档失败仅返回 warnings。

## 验收和发布

陌生机器使用独立的 `scripts/install-candidate.ps1`，安装 `video-transcript-candidate` 并隔离私有状态，具体依赖、命令和登录步骤见 [portable-install.md](portable-install.md)。这属于候选安装，不切换正式入口、不满足真实平台验收门槛。

`scripts/install.ps1` 默认只复制到独立 release 目录、安装依赖并测试，默认目录版本为0.3.0-rc.2-20261003。正式发布需显式指定非候选目录、源码版本0.3.0、`-Publish -AcceptanceFile <私有JSON>`，并在测试前及切换入口前两次通过check-release.js；候选目录禁止成为正式入口。

清单 samples 每条通过样例必须有 platform、status=passed、job_id、trans_id、已有task_id、content_id、input_kind、spoken_audio_verified=true、verified_at、raw_sha256、media_sha256。检查器核对非import/attach任务、远端状态0、精确身份、非空段落、原稿与媒体摘要，以及媒体的音轨、容器、时长核验记录。content_id须对应最终页面的平台内容ID，不能用短链或任务ID代替。同内容多个任务不计为多个样例。

每平台至少三例，且input_kind同时覆盖share_short_link和page；至少一例实际媒体duration_seconds>=600。较长样例可以同时是短链或普通页面。人工听音确认有口播后才设置spoken_audio_verified；报告脚本不会自动生成这项确认。

`acceptance-report.js <私有状态目录> <报告路径>`生成私有qa-v030/acceptance-three.json与脱敏Markdown。它保留此前的口播确认和验证日期，对产物重新核验；未确认口播显示awaiting_spoken_verification。旧acceptance.json、其他七个平台、元宝及X/YouTube历史保留，均不作为本轮三平台门槛。文档写失败仅返回warnings，机器验收结果仍保存。

本机下载方式参考 [MeTube](https://github.com/alexta69/metube)；分类与元宝媒体接口事实参考 [video-extract-mcp](https://github.com/yanlingLabs/video-extract-mcp/tree/32d1861aaebcee4ccdfa2a459b2990e3d30d04c0)（MIT）。未引入其本地 ASR、关键帧、队列或 MCP 服务；适配器独立实现，未知接口结构停止。
