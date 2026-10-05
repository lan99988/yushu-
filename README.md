# 听悟网页转写插件

这是供本机 AI agent 调用的视频转写 JSON CLI 插件。它在本机解析或下载媒体，验证后使用听悟网页端转写，并按确切的远端任务 ID 保存原稿。AI agent 可另存文字校正稿、摘要和可选知识卡片；原稿保留、不带时间戳，知识库写入交给其他插件。

**当前版本是 0.3.0-rc.2 候选版。** B站和抖音各有3个不同视频实际取得原稿；小红书3条分享短链已通过插件渠道实机验收（媒体下载+验证，2026-10-05）。600秒长视频的媒体已通过[本地免费方案](references/local-free-pipeline/README.md)取得并完成本地转写（免登录、无额度），但插件渠道的长视频验收仍卡登录墙。距正式版还差：小红书长视频经插件渠道取稿 + 听悟真实原稿比对。样例成功不代表整个平台的所有视频都能解析。

## 交给 AI 安装

克隆仓库后，在根目录打开 PowerShell 7：

```powershell
git clone https://github.com/lan99988/yushu-.git
Set-Location yushu-
pwsh -NoProfile -File './scripts/install-candidate.ps1'
```

安装器将独立候选技能安装至当前用户的 `~/.agents/skills/video-transcript-candidate`，在其中安装锁定的 npm 依赖并运行完整回归，然后检查媒体工具。Codex 用户可指定项目技能目录：

```powershell
pwsh -NoProfile -File './scripts/install-candidate.ps1' -Destination (Join-Path $HOME '.codex/skills/video-transcript-candidate')
```

安装器会拒绝覆盖已有目标目录。升级时可指定新的 `video-transcript-candidate-rc3` 目录。`-Offline` 只适用于缓存已包含所有依赖时。需要 PowerShell 7（命令`pwsh`），不支持 Windows PowerShell 5。

### 依赖

| 依赖 | 用途 |
|---|---|
| Node.js >=20，建议22+、npm | 运行插件和安装锁定的playwright-core |
| PowerShell 7 | 运行安装器与候选JSON CLI启动器 |
| Chrome、Edge或Chromium | 听悟网页与平台适配；未自动发现时设置VTRANS_CHROME为浏览器完整路径 |
| ffmpeg、ffprobe | 验证音轨/时长/容器与音频提取；需在PATH中 |
| yt-dlp | 可选下载兜底，建议安装并加入PATH |
| 听悟与来源网站账号 | 按需人工登录，处理扫码、验证码与平台额度 |

插件不会自动安装浏览器、ffmpeg或系统运行库，也不会复制别处的Cookie。npm安装需要访问锁文件指定的公开源；若所在网络不能访问，先配置适合自己的npm镜像/代理再重试，不要把依赖失败当安装成功。

安装后检查：

```powershell
$skill = Join-Path $HOME '.agents/skills/video-transcript-candidate'
$vtrans = Join-Path $skill 'scripts/vtrans-candidate.ps1'
& $vtrans doctor
& $vtrans catalog
```

`installed=true`仅表示文件已安装并通过回归；doctor输出仍会指明缺失依赖。`login_verified=false`、`online_verified=false`是预期值，需人工登录后核验：

```powershell
& $vtrans login --wait 600
& $vtrans doctor --check-login true
```

需要来源账号时，为各来源站点分别登录，不复用听悟Cookie：

```powershell
& $vtrans media-login --platform bilibili --wait 600
& $vtrans media-login --platform douyin --wait 600
& $vtrans media-login --platform xiaohongshu --wait 600
```

验证码、扫码或滑块须由用户在浏览器窗口手动完成。自定义媒体私有目录设`VTRANS_CANDIDATE_HOME`或使用`--state-root`；候选数据默认位于`~/.agent-apps/video-transcript-candidate/private`，不会进仓库。浏览器自定义位置用`VTRANS_CHROME`指定绝对路径。

## 调用转写

JSON请求示例：

```json
{
  "request_id": "my-video-20261003-001",
  "capability": "submit",
  "fields": {
    "source": "https://www.bilibili.com/video/BV...",
    "title": "视频标题"
  },
  "target": {}
}
```

把请求存到本机私有路径后调用：

```powershell
& $vtrans invoke --file 'C:/private/request.json'
```

保存CLI返回的`job_id`，恢复同一任务：

```powershell
& $vtrans status --job-id '<job_id>'
& $vtrans resume --job-id '<job_id>'
```

成功响应不一定代表转写完成；AI需检查JSON的`ok`、`state`和`ready`。提交未知时用同一个job继续核对，禁止改request_id重复上传。完整字段和JSON调用见[CLI契约](references/cli.md)。

## 处理流程

1. 本机文件先验证，再上传听悟。
2. 公网媒体直链优先交给听悟；明确解析失败或已确认尚未提交的解析超时，可本机下载后上传。
3. B站、抖音、小红书网页先经平台适配器精确辨认内容，再试yt-dlp，ParseVideo最后兜底。
4. 本机下载的文件验证音轨、时长、容器和摘要，再上传听悟并精确关联远端任务。
5. 原稿保存在本机私有状态目录；插件不写入IMA、飞书等知识库。

一份请求只能包含一个视频链接，不自动展开合集、播放列表和直播。HTTP代理读取`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`。遇到登录、验证码、限流或地域限制应按真实错误停下，等待人工处理。未知提交状态禁止换渠道重提。

## 原稿、校正和知识卡片

原稿是引用资料。另存的校正版只修错字、标点和分段，保留意思、语气、人物和完整顺序，不补充事实；不确定的人名或术语保留原稿并单独列出待核实项。摘要只基于完整原稿。调用agent必须按段落处理长文并核对覆盖情况，不能读首尾就声称校正全文。

按用户偏好生成可选本地知识卡片。`finalize`接收AI agent另存的校正稿、摘要与可选卡片文件路径，登记产物版本，不覆盖原稿、不执行模型调用、也不负责知识库入库；用户要求写入知识库时交由相应插件处理。

## 诊断和恢复

| 状态 | 后续操作 |
|---|---|
| doctor缺浏览器/ffmpeg/ffprobe | 安装并加入PATH，重新运行doctor；浏览器可设VTRANS_CHROME |
| MEDIA_LOGIN_REQUIRED | 人工登录相应来源，再恢复同一job |
| 验证码、IP风险、限流 | 停止自动尝试，记录真实错误并等待环境变化 |
| submission_unknown或远端身份未明 | 不再次提交；恢复原job并人工核对听悟记录 |
| 5分钟无转写正文 | 稍后恢复同一job，不杀掉未知提交、不新建任务 |
| 下载中断、失效或无音轨 | 按错误分类重新取得并验证媒体 |
| 小红书error_code=300012 | 机房IP被风控（登录不豁免），需住宅网络重测，见[诊断记录](references/xhs-ip-risk-300012.md) |

详见[便携安装](references/portable-install.md)和[恢复规则](references/reliability.md)。doctor只检查工具依赖；真实登录和完整取稿需要在线逐项验收。

## 当前验收范围

| 平台 | 真实取稿 | 样例说明 |
|---|---:|---|
| B站 | 3/3 | 分享短链、普通页和11分钟视频 |
| 抖音 | 3/3 | 人工登录后的分享短链、普通页和37分钟视频 |
| 小红书 | 3/3 | 分享短链×3（媒体下载+验证通过）；600秒长视频经本地免费方案完成转写，插件渠道仍卡登录墙 |

正式0.3.0需每个平台各取得三个不同有口播视频原稿，覆盖短链、普通网页及至少600秒长视频。目前9/9短链+长视频本地方案，保持0.3.0-rc.2候选版。其他七个平台、元宝、X和YouTube记录属于历史，不表示本轮验收通过。Windows环境完成本机验收；macOS/Linux完整安装还未验收。仓库未声明开源许可证。

## 本地免费转写方案（小红书兜底，无登录无额度）

当插件渠道被平台风控/登录墙挡住时，可用本地免费管线兜底：XHS-Downloader 免登录解析出 CDN 直链 → 带 Referer 重试下载 → 本地 sherpa-onnx + Paraformer-zh 转写。全程免费、无听悟额度、数据不出本机。实测 612 秒长视频全链路约 2 分钟完成。附脚本与踩坑记录见[本地免费方案文档](references/local-free-pipeline/README.md)。局限：无标点、无说话人分离、专有名词易错（无热词机制），正式稿件仍建议走听悟渠道并人工校对。
