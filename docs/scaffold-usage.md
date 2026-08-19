# 脚手架使用指南

本指南面向使用 GitHub Template 或直接克隆仓库后开发新 Skill 的用户。设计原则见[成熟 Skill 独立开发设计](mature-skill-development-design.md)，逐任务流程见[成熟 Skill 独立开发实施计划](mature-skill-development-plan.md)。

## CLI

初始化命令格式：

```bash
npm run init:skill -- --name <skill-name> --description "<concrete objective>" [options]
```

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `--name` | 是 | Skill 名称；拒绝空值、路径和不安全控制字符。 |
| `--description` | 是 | 单行、可验证的 Skill 目标。 |
| `--license` | 否 | `Apache-2.0`、`MIT` 或 `UNLICENSED`；默认 `Apache-2.0`。 |
| `--dry-run` | 否 | 输出计划，不创建文件、目录或状态。 |
| `--help` | 否 | 输出参数和示例后退出。 |

成功状态包括 `initialized`、`already-initialized` 和 `dry-run`。参数、所有权或路径冲突返回非零退出码。直接克隆源仓库时，CLI 会提示修改 `origin`，但不会写入 Git 配置。

## 初始化与所有权

初始化器只替换它能证明仍为源仓库基线的 `README.md`、`LICENSE`、`package.json` 和 `package-lock.json`。其余生成目标必须不存在。任一摘要、类型、父目录或链接不符合预期时，整个操作在写入前失败。

同一参数重复执行返回 `already-initialized`。不同名称、目标或许可证不会覆盖已有 Skill。需要开发另一个 Skill 时，从干净的 Template 仓库创建新仓库。

## State

初始化最后写入 `.scaffold/state.json`。该文件使用固定 Schema，并包含：

- `schema_version` 和 `scaffold_version`
- `status`：初始为 `draft`，完成证据后改为 `ready`
- `skill`：名称、目标和许可证
- `initialized_at`：UTC 日期
- `initial_files`：初始化输出的仓库相对路径和 SHA-256

`initial_files` 是来源与漂移证据，不是当前文件摘要。正常开发会产生 `STATE_DIGEST_DRIFT` warning；不要为了消除 warning 重写初始摘要。状态不记录 remote、凭据或模型输出。

## Source 与 Initialized

| 模式 | 判定 | 用途 | 发布白名单 |
| --- | --- | --- | --- |
| `source` | `package.json` 中 `scaffold.mode` 为 `source`，且没有状态文件 | 维护脚手架本身 | `package.json` 声明的脚手架文件集合 |
| `initialized` | `scaffold.mode` 为 `initialized`，且存在有效状态文件 | 开发一个具体 Skill | 仅 `SKILL.md` |

`npm run check` 自动按当前模式验证。`npm run gate:delivery` 只接受 initialized 仓库。

## Evidence Contract v1

Skill Brief、评测集和交付报告使用稳定 ID 建立引用。每个字段使用契约规定的一种引用：

- `artifact:path#sha256`：实际格式为 `artifact:<path>#sha256:<64 位小写十六进制摘要>`，用于固定不可变产物字节。
- `path:`：实际格式为 `path:<path>`，用于指向实现文件。
- `eval:`：实际格式为 `eval:<evaluation-id>[,<evaluation-id>...]`，用于引用 `evals/evals.json` 中一个或多个唯一评测 ID，例如 `eval:EVAL-001,EVAL-002`。

字段映射固定如下：

- enabled 轨道、Prompt 预算、评测结果和 capability claim 的 `evidence` 使用 `artifact:`。
- delivery requirement 的 `implementation` 使用一个 `path:`。
- delivery requirement 的 `verification` 使用一个 `eval:`；多个 ID 在同一前缀后用逗号分隔。
- disabled 轨道记录非空禁用理由。
- blocked 轨道使用 `required:<work>;impact:<delivery-impact>`，并另填 `unblock_condition`。

例如：

```text
implementation: path:SKILL.md
verification: eval:EVAL-001,EVAL-002
evidence: artifact:SKILL.md#sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
blocked: required:<work>;impact:<delivery-impact>
```

路径必须使用 `/`、保持仓库相对且不能包含 `.`、`..`、片段、绝对路径或 URL。`artifact` 摘要必须由实际文件字节计算。`eval` 必须指向带断言和 pass 结果的现有案例。

Gate 确定性解析约定位置和状态，不搜索任意 prose，也不调用 Agent。**Gate 不证明模型真实运行**，不证明证据内容真实，也不能替代人工复核。正式 Agent、行为质量或兼容声明仍需保留可复现的真实运行记录。

## Check 与 Gate

开发中运行：

```bash
npm run check
```

该命令运行 `node:test` 与只读仓库验证。修复错误后重新执行；warning 必须解释，但初始摘要因正常开发产生的漂移可保留。

交付前，将以下状态同步为 ready：

1. `.scaffold/state.json` 的 `status`
2. `docs/skill-brief.md` 契约中的 `status`
3. 每条验收标准、行为评测和交付追踪
4. Token 预算与启用、禁用或阻塞轨道证据

然后运行：

```bash
npm run gate:delivery
```

只有退出码为 0 才能声明确定性门通过。命令输出的 `EVIDENCE` 是已解析的追踪记录，不是外部运行证明。

只在静止工作树运行交付门禁。Gate 会记录输入身份与摘要，并通过连续两轮复核拒绝观测到的变化；Node.js 标准库不能为多个普通文件创建原子快照，因此不能保证检测忽略协作约定的同用户进程在最终观测后的非协作写入。Gate 返回后的修改不属于本次结论。运行期间不要由其他进程修改仓库，完成后再基于同一提交发布。

## 事务与恢复

初始化先创建 stage 文件，再以所有权摘要和文件身份提交目标。任何步骤失败时会按相反顺序回滚；无法证明所有权时停止自动清理并保留恢复证据。不要使用 `git reset`、强制覆盖或批量删除来处理事务错误。

所有协作初始化进程必须遵守 `.scaffold-init.lock`。Node.js 标准库无法消除不遵守锁的同用户恶意竞态，因此不要在初始化期间用其他进程改写目标或父目录。

### 陈旧锁恢复

脚手架不会在初始化时自动删除已有锁。异常退出后按以下顺序处理：

1. 确认没有 `init-skill.js` 或其他初始化进程仍在运行。
2. 只读检查 `.scaffold-init.lock` 中的 `protocol`、`pid`、`created_at` 和随机 `token`，并记录文件 SHA-256。
3. 将读取到的精确 token 和摘要传给正式恢复命令。
4. 命令成功后重试 dry run；失败时保留锁和错误信息中的恢复证据。
5. 若内容无效或存在随机 stage、backup、detached 文件，停止自动操作，先核对错误信息中的恢复路径。

可以用 Node.js 只读检查锁内容和摘要：

```bash
node -e "const fs=require('node:fs');const c=require('node:crypto');const b=fs.readFileSync('.scaffold-init.lock');console.log(b.toString('utf8'));console.log(c.createHash('sha256').update(b).digest('hex'))"
```

执行条件化恢复，不要使用平台删除命令直接处理锁：

```bash
npm run recover:lock -- --expected-token <token> --expected-sha256 <digest>
```

恢复命令要求协议、token 和 SHA-256 完全匹配，拒绝仍存活的 PID；原子隔离后会再次复核文件身份、内容和 PID，只有全部不变才删除隔离文件。失败时不会覆盖并发创建的新锁。

## 许可证

- `Apache-2.0`：生成 Apache License 2.0 文本。
- `MIT`：生成初始化年份和中性贡献者署名。
- `UNLICENSED`：不生成 `LICENSE`，并拒绝后续出现与状态冲突的该文件。

初始化后不能通过重跑 CLI 切换许可证。要变更许可证，先完成法律和项目决策，再在新的需求版本中显式迁移所有元数据和发布内容。

## Package 白名单

source 仓库的 `package.json#files` 只包含维护脚手架所需文件。initialized 仓库固定为：

```json
{
  "files": ["SKILL.md"]
}
```

该白名单限制 `npm pack` 内容，不会改变 GitHub 自动源码归档。对本脚手架仓库，`npm pack --dry-run` 仅用于内部发布白名单审计，不发布到 npm；GitHub Release 只使用自动生成的 source archives，不上传任何自定义 Release 资产。由脚手架生成的 Skill 若选择其他分发入口，必须先在 Skill Brief 中启用并按对应白名单单独验证。

## 升级

初始化是一次性所有权转换，不会自动拉取或合并脚手架新版本。升级现有 Skill 时：

1. 阅读目标脚手架版本的 Release 与迁移说明。
2. 在独立分支比较设计、计划、Schema 和命令变化。
3. 先为迁移行为添加失败测试，再最小修改受影响文件。
4. 保留 `.scaffold/state.json` 的初始摘要；只有正式 Schema 迁移器明确要求时才修改结构。
5. 运行 `npm run check`、受影响行为评测和 `npm run gate:delivery`。

脚手架不提供 reset 或 uninstall 命令。不要用重新初始化、目录复制或强制 reset 作为升级方式。
