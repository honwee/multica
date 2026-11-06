# Fork 上游同步记录

规则见 [FORK.md](../FORK.md)。每次同步在最上面追加一节。

## 2026-11-06 · 首次同步（LUM-32，发布 0.8.6）

- 上游：`multica-ai/multica` `main` @ `a9434451e`（`fix(issues): offer retry for failed first list pages (#10044)`）
- 分叉点：`b3f1e6bf6`（2026-11-04）；同步前 fork 领先 119、落后 43 个提交
- 分支：`chore/upstream-sync-20261106`，merge commit `f416531e9`

### 冲突文件与取舍

| 文件 | 取舍 |
| --- | --- |
| `apps/desktop/package.json`、`apps/web/package.json` | 保留 fork 的 0.8.5，发版 PR 升 0.8.6 |
| `server/pkg/agent/zcode.go` | 两边修了同一个 stderr 读取竞争，取上游 `withStartupStderr`，丢弃 fork 的 `ef87db6e9` 实现 |
| `server/pkg/db/queries/workspace.sql` | 合并：`ListWorkspaces` 同时保留 fork 的 `m.disabled_at IS NULL` 和上游的 `pinned_at` 排序 |
| `server/pkg/db/generated/*.go` | `make sqlc` 重新生成（`feishu_org.sql.go` 随 `member` 新列一起更新） |
| `server/internal/handler/agent.go` | 保留 fork 的“权限与绑定同一事务”及其提交位置；加入上游的 `pendingMovedTo`，提交后唤醒新 runtime |
| `packages/core/api/schemas.ts` | Lark schema 保留 fork 版本（`agent_id` 可空）；新增上游 `WorkspaceListItemSchema`、`WorkspacePinnedSchema` |
| `apps/mobile/data/api.ts` | 两边都加了 `listAgents({ includeArchived })`，URL 相同，保留 fork 实现 |
| `apps/mobile/data/api.test.ts` | 保留 fork 的 `beforeEach`，加入上游 `listAgents` 用例 |
| `apps/mobile/data/queries/agents.ts` | 采用上游可选 `includeArchived`（独立缓存键）；保留 fork 的 `agentKeys` / `agentDetailOptions` / `agentRunsOptions`；fork 的 Agent 管理页显式传 `includeArchived: true` |

合并后另外两个 fork 提交：

- `test(migrations)`：迁移编号唯一性检查豁免已上线的 fork 迁移 614–637（列表在 `server/internal/migrations/fork_migrations_test.go`）。
- `test(mobile)`：上游 MUL-8683 的图片序列用例假设 API 地址为空，fork 的 server store 默认指向托管地址；测试里置空 `apiUrl`，行为不变。

### 迁移

- 上游新增：`614_project_creator`（`project` 加列）、`615_attachment_image_dimensions`（`attachment` 加列）、`616_member_pinned`（`member` 加列，`IF NOT EXISTS`）。
- 与 fork 的 `614_feishu_user_identity`、`615_feishu_org_model`、`616_feishu_org_config_workspace_index` 同号。运行器按完整文件名排序，`schema_migrations` 记完整文件名，两边都执行。
- 依赖：两边互不依赖。上游三个迁移只给已有表加可空列；fork 迁移不涉及这三列。fork 的 `ListWorkspaces` 用到上游 `member.pinned_at`，这是查询层依赖，迁移顺序不影响。
- 空库：按文件名顺序执行完 664 个迁移（`614_feishu…` → `614_project…` → `615_attachment…` → `615_feishu…` → `616_feishu…` → `616_member…` → `617…637`），`schema_migrations` 664 行。
- 增量（本地演练）：临时库先用 fork `main`（`1bc5ce3c9`，即线上状态）迁到 637，再用合并后分支迁移，只执行上游 3 个迁移，结果 664 行，新列齐全。临时库已删除。
- 线上副本：由 `fde-deploy` phase 1 在生产库副本上空跑，结果见 LUM-32 结束评论。

### 验证

- `make test`（`make up` 起的环境，真实数据库）：通过。第一次运行时开发 API 同时在跑，它的后台任务把测试夹具的 runtime 标成离线，导致 3 个 handler 用例 422、1 个 daemon 计时用例偶发失败；单独重跑通过，`make down` 后完整重跑全部通过。
- `pnpm typecheck`、`pnpm lint`（0 error）、`pnpm test`：通过。
- 移动端 `typecheck`、`lint`、`test`：通过。
