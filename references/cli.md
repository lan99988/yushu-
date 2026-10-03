# JSON CLI 调用契约

所有正常输出为一行 JSON：成功 `{"ok":true,"data":...}`，失败 `{"ok":false,"error":{"code","message","details"}}` 且非零退出。`data` 不表示转写已完成，必须检查任务 state 或 ready。

调用全局 skill 下的 `scripts/vtrans.ps1`；也可直接 `node <发布目录>/scripts/cli.js`。`VTRANS_HOME` 可设置私有状态目录，`VTRANS_CHROME` 可指定 Chrome。默认私有目录 `~/.agent-apps/video-transcript/private`。一次浏览器操作只允许一个进程，多个 agent 的任务按 job_id 隔离。

独立候选安装必须调用 `scripts/vtrans-candidate.ps1`：默认私有目录为 `~/.agent-apps/video-transcript-candidate/private`，优先使用显式 `--state-root`，其次 `VTRANS_CANDIDATE_HOME`，忽略正式入口的 `VTRANS_HOME` 与 `VTRANS_SOURCE_BOOK`；候选适配文档可用 `VTRANS_CANDIDATE_SOURCE_BOOK` 明确指定。不要以直接调用 `cli.js` 或 npm bin 替代候选启动器。依赖安装与人工登录见 [portable-install.md](portable-install.md)。

## 请求文件

```json
{
  "request_id": "保持稳定的用户请求标识",
  "capability": "submit",
  "fields": {
    "source": "https://www.bilibili.com/video/BV...",
    "title": "视频标题"
  },
  "target": {}
}
```

用 `invoke --file <绝对路径>` 执行。fields 与 target 合并，target 仅用于 job_id；不要在文件中传密码、Cookie 或 API key。

| capability | fields / target | 行为 |
|---|---|---|
| doctor | check_login 可选 true | 依赖检查；true 时只读验证登录 |
| catalog | 空 fields | 返回可用命令 |
| route | source | 离线识别类型、平台及近7天逐链接证据；不访问网页 |
| probe | source；language 可选 | 只验证听悟解析，不点击开始转写；自动追加证据 |
| resolve | request_id；source=视频网页；title 可选 | 网站解析、下载成本地媒体，不提交听悟；返回 media_file |
| acquire | request_id；source；title 可选 | 自动取得并验证本地媒体，不提交听悟 |
| resume | target.job_id；wait 可选 | 按已有阶段恢复；已有远端身份时只查询取稿 |
| media-login | platform；wait 可选 | 来源站点独立会话人工登录 |
| media-session-import | platform；source=指定Cookie文件 | 严格站域隔离导入JSON或Netscape文件 |
| sources | 空 fields | 更新并返回适配文档，列出脱敏验证历史 |
| source-add | source | 仅收集链接，标为待验证；不访问网页、不制造支持证据 |
| source-record | source，stage，outcome；note 可选 | 追加人工证据并更新文档 |
| login | wait 可选，默认180，最高600 | 显示浏览器等待人工登录 |
| session-import | source=已有本机 Cookie JSON | 仅迁移阿里云域 Cookie，不迁移整个原型 profile |
| submit | request_id 必填；source 必填，title/language 可选 | 网页优先本机获取；媒体直链优先听悟；验证上传后返回远端身份 |
| attach | trans_id 必填；job_id 或新 request_id | 关联人工确认的已有任务，不再次提交 |
| status | target.job_id | 查询确切任务状态 |
| fetch | target.job_id；wait 默认0，最高60 | 获取已完成的完整稿；未完成时 ready=false |
| import-result | request_id；source=听悟结果 JSON；title 可选 | 离线导入已完成的结果，不访问网络 |
| preferences | cards 可选 ask/always/never | 读取或保存本机卡片偏好 |
| finalize | job_id；corrected_file，summary_file，card_file 可选，cards 可选 | 登记由 agent 生成的本地文件；不改原稿、不写知识库 |
| unlock | name 默认 browser | 仅当持锁进程已退出时清理残留锁 |

同名命令支持 `--source`、`--request-id`、`--title`、`--job-id` 等 kebab-case 参数。`--state-root` 可以覆盖 VTRANS_HOME；不能通过业务请求修改宿主目录。

language 支持 cn/en/ja/yue/mixed；省略时沿用网页默认中文。分流、来源登录、刷新预算和恢复详见 [reliability.md](reliability.md)。route 为离线预判；submit/acquire 会安全解析短链并以 Content-Type 识别无扩展媒体。

source-record 的 stage 支持 tingwu_parse/parser_parse/download/tingwu_submit/media_validate/tingwu_fetch/yuanbao_parse/yt_dlp/platform_parse；outcome 为 accepted/unsupported/failed/error。主证据按内容ID关联并保留历史；各阶段互不替代。适配文档默认在私有目录，宿主 config.json 的 source_book 或 VTRANS_SOURCE_BOOK 可指定路径。签名URL仅留私有记录，公开输出脱敏。

ParseVideo 默认每任务只解析一次，只有已确认过期媒体允许同任务自动刷新一次。失败或未知结果不自动再消耗额度；403本身不证明过期。网页本机获取依赖 yt-dlp；媒体验证依赖 ffprobe，转码/HLS依赖 ffmpeg。额度、验证码、登录要求均需人工处理。

## AI 加工登记

```json
{
  "capability": "finalize",
  "fields": {
    "corrected_file": "C:/任务工作区/transcript_corrected.md",
    "summary_file": "C:/任务工作区/summary.md",
    "cards": "never"
  },
  "target": { "job_id": "vt-返回的24位标识" }
}
```

生成卡片时使用 `cards=always` 并提供 `card_file`。长期偏好仍为 ask 且没有卡片决策时返回 CARD_PREFERENCE_REQUIRED；长期偏好 always 缺少卡片时返回 CARD_REQUIRED。未修改原稿才允许 finalize。重复 finalize 会创建新版本，已有版本保持不变。

## 状态与错误

prepared → submitting → submitted → ai_ready → complete。上传途中可能为 uploading。submitting/submission_unknown 表示结果未知，禁止再次 submit；使用 attach 恢复。uploading 只能继续查询或人工检查，不能重传。

听悟直链提交接口在实测中返回空 data 数组，不能用解析 fileId 当远端 taskId。本插件为本次提交附加随机唯一名称，成功后严格按完整名称恢复 taskId/transId，随后按 ID 查询。如果提交响应丢失但唯一名称已保存，status 可以继续恢复；名字相近或出现两个同名任务均不能代取。

已核对听悟线上前端状态枚举：0=转写完成，1=转写中，2=转写失败，3=上传完成，4=等待上传，5=上传中，11=上传任务失败，20/21/22=直链上传失败。只有0且有可解析、非空 pg/sc 正文才取为最终稿。未知状态不作成功判断。网页接口改版、未知字段或拒绝请求均返回错误，不尝试猜字段拼出稿件。

退出码：0=本次命令成功（任务可能仍处理中），3=需人工登录，4=锁占用，5=提交结果未知，6=上传待确认，其他错误为1。网络错误、提交未知或远端失败不得自动换 request_id 重试。明确的地区限制/下载失败向用户报告；本版不自动配置代理。

原稿为 transcript_raw.md；segments.json 仅含正文、发言人与内部时间值，便于分块校正，不含签名播放 URL。任务产物在私有目录的 jobs/<job_id> 中；可将最终路径交给其他插件，不将整个私有目录交付。

## 三平台发布验收契约

当前候选版为0.3.0-rc.2。本轮门槛为bilibili/douyin/xiaohongshu各至少三个不同有口播视频，并各自覆盖分享短链、普通页面、至少600秒较长视频。元宝、海外和其他七个平台保留历史，不作为本轮发布门槛。

```json
{
  "schema_version": 2,
  "version": "0.3.0-rc.2",
  "scope": "three-platform-spoken-video",
  "samples": [{
    "platform": "bilibili",
    "status": "passed",
    "job_id": "vt-本机24位任务标识",
    "trans_id": "确切听悟ID",
    "task_id": "job中已有则必须一致",
    "content_id": "bilibili:实际BV号",
    "input_kind": "share_short_link",
    "spoken_audio_verified": true,
    "verified_at": "2026-10-03T00:00:00.000Z",
    "raw_sha256": "原稿SHA256",
    "media_sha256": "媒体SHA256"
  }]
}
```

每条样例均须真实提交并取稿，不能使用import-result/attach或同内容重复任务凑数。input_kind为share_short_link或page，由原始输入核对；时长来自任务media_cache.duration_seconds，不能仅写在清单里。content_id由最终来源识别，分享查询参数不影响同内容判断。

使用`node scripts/check-release.js <清单路径> <私有目录>`核验，缺样例/覆盖返回ACCEPTANCE_INCOMPLETE，内容重复、错误远端身份或产物冲突返回ACCEPTANCE_INVALID。`node scripts/acceptance-report.js <私有目录> <脱敏Markdown路径>`从qa-v030-前缀任务生成qa-v030/acceptance-three.json，保留已有人工口播确认。机器清单包含访问参数，只能存于私有目录；报告生成不代表发布。
