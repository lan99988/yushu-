# 小红书 300012 IP 风险诊断记录

结论：**300012 是小红书对数据中心（机房）出口 IP 的风控，登录态不豁免**。在线验收需要住宅/办公网络环境，与本插件代码无关。

## 环境证据（2026-10-05，Windows Server + Node 22.22.2）

| 项目 | 值 |
|---|---|
| 本机出口 IP | `49.234.14.43`（上海电信，腾讯云机房段） |
| 插件浏览器 egress | 直连（受控代理仅做校验，不换出口），与上同 |
| 系统代理出口 | 同上（代理与直连同 IP，排除"换代理绕开"的可能） |

## 复现过程

1. 匿名打开 `xiaohongshu.com/explore` → 重定向到
   `website-login/error?...error_code=300012&error_msg=IP存在风险，请切换可靠网络环境后重试&rejectUrl=edith.xiaohongshu.com/api/sns/web/v1/login/activate`
2. `media-login` 人工登录成功，Cookie 保存完整（含 `web_session`，域 `.xiaohongshu.com`，有效期至 2027）。
3. 带登录态重试：笔记页 SSR 偶尔能返回 `__INITIAL_STATE__` 外壳，但笔记详情 API（feed）与搜索 API（`/s`）仍随机被 300012 拒绝——**风控在 IP 层，不在账号层**。
4. 插件适配器在每次被拒时按设计如实停止（`RESOLVER_FAILED` / 重定向检测），未伪造成功，符合"遇到限流按真实错误停下"的规则。

## 为什么单元测试不算数、AI 代取稿也不算数

验收门槛要求"真实听悟原稿"：插件自己解析 → 下载媒体 → 上传听悟 → 按远端任务 ID 取回原稿。
单元测试（4 例小红书用例，全部通过）只验证解析逻辑；小红书"点点"等第三方 AI 摘要与人工转写都不能证明插件管线通，均不能替代。

## 恢复验收的条件与步骤

在**住宅或办公宽带**环境的 Windows 机器上：

```powershell
git clone https://github.com/lan99988/yushu-.git
Set-Location yushu-
pwsh -File scripts/install-candidate.ps1
# 候选入口登录小红书（Cookie 保存于独立 profile）
node scripts/cli.js media-login --platform xiaohongshu --wait 600 --state-root "$HOME\.agent-apps\video-transcript-candidate\private"
# 三个不同有口播视频：分享短链（App 复制的 xsec_token 链接）、普通页面、≥600 秒长视频
node scripts/cli.js submit --request-id qa-v030-xhs-1 --state-root "$HOME\.agent-apps\video-transcript-candidate\private" --source "<App分享链接>"
```

注意：网页版笔记详情现在要求 `xsec_token`（仅 App 分享链接携带）；裸 `/explore/<id>` 打不开详情，不是插件 bug。
