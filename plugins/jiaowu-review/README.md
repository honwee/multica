# 教务审批插件（jiaowu-review）

只给教务FDE 工作区用的工作区插件，基于 fork 的两个扩展点（见 `FORK.md`）。插件**只按分身卡片上写明的协议发评论，从不改状态**，由 Hermes 照常接手执行。

| 功能 | 实现 | 需要 |
| --- | --- | --- |
| 审批队列页 | `workspace_page` 界面 `ui/main.js` | 页面开关、`MULTICA_PLUGIN_SURFACE_ORIGIN` |
| 飞书一键审批 | `card_buttons` + `card` 钩子 | 卡片按钮开关、钩子服务、agent 飞书机器人 |
| 过期自动收口 | `track`（event）+ `sweep`（schedule）钩子 | 钩子服务 |

## 分身协议（以卡片 footer 为准）

| 卡片 | 标题 | 同意 | 修改 | 放弃 |
| --- | --- | --- | --- | --- |
| 草稿 | `D123 待确认：…` | `同意` | `改 新内容` | `不要 理由` |
| 经验提案 | `#123 经验提案：…` | `同意` | `修改 新内容` | `拒绝 理由` |
| 请教 | `Q12 分身请教：…` | 回复选项字母，例如 `B`，或直接写答案 | | |

动词从每张卡片的 footer 里读，读不到时才用上表的默认值。请教不能批量处理；「其他」（问课单、导师卡）不提供任何操作。

## 过期收口

- 问课单：标题以 `｜WK-YYYYMMDD-XXXXXX` 结尾。分身「问课停止」会把它改成 `cancelled`，「问课确定」会改成 `done`，「问课重开」会改回去。
- 挂在问课单上的卡片：导师卡是它的子 issue；草稿不是子 issue，只在标题或正文里写 `WK-…`。
- 请教不收口：它们经常就是在问「整单已停止，怎么办」。
- 收口动作：发一条 `// 问课单 WK-… 已停止，此卡建议作废（审批插件自动标记，未改状态）`。`//` 开头的评论按分身约定只留在看板上，不执行。同一张卡只发一次；问课单结束之后才建的卡片不动。
- `track` 钩子的回调 token 只能访问事件里的那一个 issue，所以它只往插件存储里记事实；每 10 分钟 `sweep` 钩子用工作区级 token 发收口评论。存储里每条事实一个 key，用完就删。
- 插件装上之前已经遗留的卡片，在审批队列页顶部的「建议收口」里手动一次性处理。

## 打包

```bash
node plugins/jiaowu-review/build.mjs --zip   # 生成 ui/main.js 和 dist/jiaowu-review-<版本>.zip
```

`ui/main.js` 由 `ui/page.mjs` 和 `lib/protocol.mjs` 生成，不要手改。钩子服务的地址写在 manifest 里（`fde-hooks.lumistedu.com`），换地址就要改 manifest、升版本号、重新打包。线上证书是 `*.lumistedu.com` 通配证书，只覆盖一级子域，所以钩子主机必须是 `xxx.lumistedu.com` 这种一级子域，不能用 `xxx.fde.lumistedu.com`。

## 安装（教务FDE 管理员）

1. 线上先配好 `MULTICA_PLUGIN_SECRET_KEY` 和 `MULTICA_PLUGIN_SURFACE_ORIGIN`（见 LUM-33 的待决问题 1）。没配时插件页面打不开，钩子也不会运行。
2. 教务FDE →「设置 → 插件」→ 上传 `jiaowu-review-1.0.1.zip` → 安装，同意权限：`issues:read`、`comments:read`、`comments:write`、`storage:workspace`、`net:fde-hooks.lumistedu.com`。
3. 「设置 → 插件 → 工作区扩展」打开「侧边栏插件页面」；要用飞书按钮时再打开「飞书通知卡片上的插件按钮」。
4. 在插件详情里轮换 token，记下 signing secret（只显示一次），交给部署钩子服务的人。

## 部署钩子服务

无依赖的 Node 22 进程：

```bash
MULTICA_SIGNING_SECRET=whsec_… PORT=8787 node plugins/jiaowu-review/server/handler.mjs
```

- Multica 必须能通过 HTTPS 访问 `https://fde-hooks.lumistedu.com/hooks/{card,track,sweep}`，所以需要 DNS、证书和反向代理；也可以用 `MULTICA_HOOK_TLS_CERT` / `MULTICA_HOOK_TLS_KEY` 直接提供 HTTPS。
- `GET /healthz` 用来做健康检查。
- `card` 钩子必须在 1.5 秒内返回；点击无效时（例如请教没有选项 D）返回 422，卡片保持可点。

## 飞书一键审批

按钮只会出现在 **agent 飞书机器人**发出的通知卡片上。机器人应用需要在飞书开放平台「事件与回调 → 回调配置」里用长连接订阅「卡片回传交互」并发布新版本（步骤见 `FORK.md`）。

已知限制：按钮在 manifest 里是固定的，请教卡片总是显示 A–D 四个按钮。点了卡片上没有的选项时，平台只会提示「插件处理失败，请重试」，不会显示具体原因。

## 测试

```bash
pnpm --filter @multica/plugin-jiaowu-review test     # 协议、按钮映射、批量、收口、签名校验
cd server && go test ./pkg/plugincontract -run ForkWorkspacePlugins   # 用平台的校验器检查 manifest 和打包内容
```
