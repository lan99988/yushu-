# 新机器安装独立候选版

本模块仍是 `0.3.0-rc.2`。当前 B站与抖音各有三例真实取稿，共 `6/9`；小红书受 `IP300012` 限制，未达到三平台九例验收。公开提供候选源码和安装器不表示正式发布 `0.3.0`，也不保证陌生机器复现已有样例。

## 依赖

| 依赖 | 用途与配置 |
|---|---|
| PowerShell 7 | 运行跨平台候选安装器与启动器；命令为 `pwsh` |
| Node.js >=20、npm | CLI 和安装锁定依赖；建议 Node >=22。安装后重开终端，使 `node`、`npm` 位于 PATH |
| `playwright-core@1.63.0` | 安装器执行 `npm ci --ignore-scripts` 自动安装；不会自动下载浏览器。锁文件当前使用公开 `registry.npmmirror.com` 包地址，需要访问该地址；离线安装需 npm 缓存已有该包 |
| Chrome / Edge / Chromium | 浏览器转写与站点适配；自动发现当前用户常见安装路径和 PATH，也可设置 `VTRANS_CHROME` 为浏览器可执行文件绝对路径 |
| ffmpeg、ffprobe | 本地媒体音轨、时长与容器验证及提取；二者均需位于 PATH。没有它们不能完成自动下载上传流程 |
| yt-dlp（可选，建议） | 专用适配器之后的本机下载兜底；可用 `python -m pip install --upgrade yt-dlp`，其 Scripts/bin 目录需在 PATH |
| Python / Deno（可选） | Python 仅用于 pip 安装 yt-dlp；独立 yt-dlp 可执行文件不需要 Python。YouTube JS 运行时用 Node >=22 或 PATH 中的 Deno；YouTube 保留历史，未完成本轮验收 |
| 网络与人工登录 | 听悟账户、来源站点访问权限与可用转写额度。ParseVideo 为末级兜底，受网站支持范围与额度限制；本插件没有 API key 配置要求 |

安装器不下载系统依赖、不迁移作者账户、不读取或复制作者 Cookie。`doctor` 默认仅检查本机依赖，`doctor --check-login true` 才会联网只读核验听悟登录。

## 从仓库安装

在已克隆仓库的根目录打开 PowerShell 7：

```powershell
pwsh -NoProfile -File './scripts/install-candidate.ps1'
```

默认安装到当前用户 `~/.agents/skills/video-transcript-candidate`，AI 技能名为 `video-transcript-candidate`。安装器按白名单复制源码、重新安装锁定依赖并执行全部离线回归。已有目标目录会拒绝覆盖。希望 Codex 在专属技能目录发现它时，明确指定：

```powershell
pwsh -NoProfile -File './scripts/install-candidate.ps1' -Destination (Join-Path $HOME '.codex/skills/video-transcript-candidate')
```

`-Destination` 的目录名必须为 `video-transcript-candidate` 或带后缀的候选目录名，例如 `video-transcript-candidate-rc2`。此安装器没有 `-Publish`，不能替换正式 `video-transcript`。升级请安装到新的候选目录。npm 缓存齐备时可加 `-Offline`；缓存不齐会明确失败，不会访问实际视频站点。

输出最后一行为安装报告：`installed=true` 仅表示文件安装及回归通过；还要检查 `doctor_ok`、`media_ready`、`missing_dependencies` 与 `doctor_error`。即使缺浏览器或 ffmpeg，离线技能仍可安装，但相应操作尚未就绪。配置错误导致 doctor 无法生成依赖报告时，查看 `doctor_error`，不能以空的 `missing_dependencies` 推断已就绪。安装不核验登录、不产生转写成功证据。

## 配置、登录与使用

```powershell
$candidateCli = Join-Path $HOME '.agents/skills/video-transcript-candidate/scripts/vtrans-candidate.ps1'
# 使用 Codex 专属目录安装时，将上行 .agents 改为 .codex。
& $candidateCli doctor
& $candidateCli catalog
# 下列操作联网并打开可见浏览器：由用户完成登录、验证码或滑块。
& $candidateCli login
& $candidateCli doctor --check-login true
# 来源站点需要登录时，分别登录，不复用听悟会话。
& $candidateCli media-login --platform bilibili
& $candidateCli media-login --platform douyin
& $candidateCli media-login --platform xiaohongshu
# 按 references/cli.md 准备具有稳定 request_id 的 JSON 请求。
& $candidateCli invoke --file '/绝对路径/request.json'
```

浏览器未自动找到时，在当前终端设置 `$env:VTRANS_CHROME = '<浏览器可执行文件的绝对路径>'`。自定义私有目录设置 `$env:VTRANS_CANDIDATE_HOME = '<私有目录绝对路径>'`；单次覆盖使用 `--state-root <私有目录>`。这些变量需在每次运行的进程环境中设置，或由用户在自己的启动配置中持久化，不写回仓库。

候选启动器默认私有目录为 `~/.agent-apps/video-transcript-candidate/private`，忽略正式入口的 `VTRANS_HOME` 和 `VTRANS_SOURCE_BOOK`。适配记录默认也位于候选私有目录；明确指定外部记录文档时使用 `VTRANS_CANDIDATE_SOURCE_BOOK`。Cookie、浏览器 profile、请求、任务、原稿和媒体只保存在所选私有目录，不放入技能目录或 Git。请始终调用 `vtrans-candidate.ps1`；直接调用 `cli.js` 或 npm 的 `vtrans` bin 会使用原有正式状态目录规则。

安装包的启动器通过 PATH 找 Node，以自身目录定位 CLI，没有保存作者用户名、D盘路径或 `runtime.json` 绝对指针。同一平台和架构下可移动整个候选技能目录后继续运行；换平台或架构时，从源码重新执行安装器和 `npm ci`。私有目录位于用户家目录，不随技能包复制；登录在新机器上重新完成。

## 边界与恢复

目前只在 Windows / PowerShell 7 实际执行便携安装回归；macOS 浏览器发现由离线夹具验证，macOS/Linux 整机端到端尚未验收。网络代理可使用现有 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 环境设置；网络、地域、验证码、额度与平台改版仍可能导致失败。

`LOGIN_REQUIRED` 需人工登录；`IP300012`、验证码或地区限制应保留原始错误，不绕过或记为成功。任务提交未知时禁止重提，按 [可靠性与恢复](reliability.md) 核对明确远端身份后恢复。AI 的全文校正、摘要与可选本地知识卡片仍由调用 agent 执行，禁止覆盖原稿。
