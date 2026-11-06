# Lumist fork 规则

本仓库 `honwee/multica` 是 Lumist 维护的 `multica-ai/multica` fork，部署在 https://fde.lumistedu.com 。以下规则适用于所有在本仓库工作的人和 agent，与 [AGENTS.md](AGENTS.md) 的规则同时生效。

## 改动放在哪里

1. **业务逻辑优先做成工作区插件，或用工作区配置实现。** 教务、飞书业务流程等 Lumist 专属逻辑不进核心代码。
2. **必须改核心代码时，只做默认关闭的通用扩展点。**
   - 扩展点要通用（不写 Lumist 的业务名词），默认关闭，关闭时行为与上游完全一致。
   - fork 的代码放在独立的包和文件里（例如 `server/internal/feishuorg/`、`*_fork.go`、`fork_*_test.go`），对上游文件只留最小的接入点（一行调用、一个注册、一个条件）。
   - 接入点越少，每周合并上游时冲突越少。
3. **扩展点不往上游提 PR。** 通用扩展点只留在 fork。

## 数据库迁移编号

- fork 自己的新迁移从 **`9000_`** 开始编号（`9000_xxx.up.sql`、`9001_xxx.up.sql`……），和上游的编号段永远分开。
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
