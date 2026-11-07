# Lumist fork 规则

本仓库 `honwee/multica` 是 Lumist 维护的 `multica-ai/multica` fork，部署在 https://fde.lumistedu.com 。以下规则适用于所有在本仓库工作的人和 agent，与 [AGENTS.md](AGENTS.md) 的规则同时生效。

## 改动放在哪里

1. **业务逻辑优先做成工作区插件，或用工作区配置实现。** 教务、飞书业务流程等 Lumist 专属逻辑不进核心代码。
2. **必须改核心代码时，只做默认关闭的通用扩展点。**
   - 扩展点要通用（不写 Lumist 的业务名词），默认关闭，关闭时行为与上游完全一致。
   - fork 的代码放在独立的包和文件里（例如 `server/internal/feishuorg/`、`*_fork.go`、`fork_*_test.go`），对上游文件只留最小的接入点（一行调用、一个注册、一个条件）。
   - 接入点越少，每周合并上游时冲突越少。
3. **扩展点不往上游提 PR。** 通用扩展点只留在 fork。

## 已有的通用扩展点

都由 `workspace.settings.plugin_extensions` 按工作区开关，默认关闭；关闭时行为与上游一致。管理员在「设置 → 插件 → 工作区扩展」里开关。

- **工作区页面**（`workspace_page` 界面）：插件页面出现在 Work 侧边栏的「插件」分组，路由 `/{slug}/plugins/{installationId}/{surfaceKey}`。页面通过 bridge 可以调用 `GET /issues`、`POST /issue-batches/comments`、`POST /issue-batches/status`，都以当前用户身份逐条校验执行，每一条写入 `plugin_batch_action`（含 `via_plugin_id`）。代码：`server/internal/handler/plugin_extensions_fork.go`、`packages/views/plugins/plugin-workspace-pages.tsx`。
- **飞书通知卡片按钮**（manifest 的 `card_buttons` + `card_action` 触发）：只出现在 agent 机器人发送的通知卡片上。点击经机器人长连接回调（`card.action.trigger`），平台校验签名、点击者身份和 issue 权限，每张卡片只执行一次（`plugin_card_action`），再调用插件钩子并以点击者身份执行它返回的动作。机器人应用需要在飞书开放平台用长连接订阅「卡片回传交互」。代码：`server/internal/handler/plugin_card_action_fork.go`、`server/internal/feishunotify/buttons_fork.go`、`server/internal/integrations/lark/ws_card_action_fork.go`。
- 最小示例：`examples/plugins/workspace-review/`。

## 工作区插件

各工作区的业务插件放在 `plugins/<名字>/`，每个目录是一个 pnpm workspace 包（`pnpm test` 会跑它的测试），并在 `server/pkg/plugincontract/fork_plugins_test.go` 里登记，用平台的打包校验器检查。上线方式是在对应工作区的「设置 → 插件」上传安装，不随服务端发版。

- `plugins/jiaowu-review/`：教务FDE 的审批插件（审批队列页、飞书一键审批、问课单结束后的收口评论）。

## 数据库迁移编号

- fork 自己的新迁移从 **`90000_`** 开始编号（`90000_xxx.up.sql`、`90001_xxx.up.sql`……），和上游的编号段永远分开。编号固定 5 位，保证按文件名排序与按数字排序一致。
- `9000_feishu_org_admit_on_login` 是按旧规则（`9000_`）编号且已上线的迁移，**不改名**，列在 `server/internal/migrations/fork_migrations_test.go` 的 `forkPre90000MigrationStems` 里。迁移运行器按文件名的字典序执行，`90000_…` 排在 `9000_…` **之前**，所以从空库建库时新的 `90000+` 迁移会先于它执行：新迁移不能依赖 `feishu_org_config.admit_on_login` 列；确实需要时用 `ADD COLUMN IF NOT EXISTS` 等幂等写法自己保证。
- `fork_migrations_test.go` 会拒绝 9000–89999 之间新出现的迁移编号。
- 迁移运行器按完整文件名排序，`schema_migrations` 记录完整文件名，所以同号不同名的迁移两边都会执行。
- 已上线的 fork 迁移 `614_feishu_*` 到 `637_feishu_*`（含 `627_lark_workspace_app_connection`）与上游 614 起的编号重叠，**不改名**。它们列在 `server/internal/migrations/fork_migrations_test.go`，编号唯一性检查对它们豁免。不要往这个列表里加新迁移。
- fork 迁移不能依赖上游未来才会有的对象；如果上游迁移依赖了 fork 迁移建的对象，或反过来，必须在同步记录里写明。

## 每周同步上游

- **每周同步一次** `multica-ai/multica` 的 `main`，同步完就发版（按发布工具包的 B 流程，patch 递增）。
- **只用 merge，不用 rebase**，不改写 `main` 历史：
  ```bash
  git checkout -b chore/upstream-sync-<YYYYMMDD> origin/main
  git fetch https://github.com/multica-ai/multica.git main
  git merge --no-ff FETCH_HEAD
  ```
- 冲突取舍原则：上游的改动优先保留；fork 的功能（飞书组织同步、飞书通知、daemon 工作区允许列表等）必须完整保留。生成文件（`server/pkg/db/generated/`）不手工合并，用 `make sqlc` 重新生成。
- 版本号冲突保留 fork 当前版本，由发版 PR 再升。
- 每次同步在 [docs/fork-sync-log.md](docs/fork-sync-log.md) 追加一节：上游 commit、冲突文件和取舍、迁移情况、验证结果。
- 合并前在 `make up` 起的环境里跑 `make test`（真实数据库），以及 `pnpm typecheck`、`pnpm lint`、`pnpm test` 和移动端的检查。
