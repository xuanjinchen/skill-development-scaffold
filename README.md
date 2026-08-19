<!-- skill-development-scaffold:source -->
# Skill Development Scaffold

一个可执行的 Node.js 仓库模板，用于从明确目标开始开发、验证和交付成熟的 Agent Skill。

## 用途

该仓库提供初始化器、通用设计与实施计划、Evidence Contract v1、确定性检查和交付门禁。它默认采用用户优先型：先交付核心 Skill，再按证据启用脚本、资料、适配器、安装器或发布流程。

## 使用 GitHub Template

1. 在 GitHub 打开本仓库，选择 **Use this template**。
2. 创建自己的仓库并克隆该新仓库。
3. 在新仓库根目录安装依赖并执行初始化。

这种方式会让 `origin` 直接指向你的仓库，适合作为默认入口。

## 直接克隆

也可以直接克隆源仓库：

```bash
git clone https://github.com/xuanjinchen/skill-development-scaffold.git my-skill
cd my-skill
```

直接克隆会保留源仓库 `origin`。发布前必须改为自己的远端并核对结果：

```bash
git remote set-url origin https://github.com/OWNER/REPOSITORY.git
git remote -v
```

初始化器只读取 `origin` 以给出警告，不会修改远端。

## 前置条件

- Node.js 22 或更高版本
- npm（随 Node.js 提供）
- Git（使用 GitHub Template、克隆或版本维护时需要）

本项目没有第三方运行时或测试依赖。运行 `npm install` 可按锁文件确认本地 npm 元数据。

## 初始化

在仓库根目录运行一次：

```bash
npm run init:skill -- --name example-skill --description "Generate consistent example outputs"
```

默认许可证为 `Apache-2.0`。也可传入 `--license MIT` 或 `--license UNLICENSED`。名称、目标或许可证与现有初始化状态不一致时，命令会拒绝覆盖。

### Dry run

先查看计划且不写入文件：

```bash
npm run init:skill -- --name example-skill --description "Generate consistent example outputs" --dry-run
```

查看完整参数：

```bash
npm run init:skill -- --help
```

## 生成文件

初始化会渲染或更新以下受管目标：

- `SKILL.md` 和面向当前 Skill 的 `README.md`
- `docs/skill-brief.md`、`docs/decisions.md`、`docs/delivery-report.md`
- `evals/evals.json`
- `package.json` 和 `package-lock.json`
- `.scaffold/state.json`
- `LICENSE`，仅适用于 `Apache-2.0` 或 `MIT`

状态文件记录初始文件 SHA-256、许可证和生命周期状态。它不保存凭据、远端地址或开发会话内容。

## 验证与交付门禁

开发期间运行确定性检查：

```bash
npm run check
```

当 Skill Brief、行为评测、交付报告和 `.scaffold/state.json` 都达到 ready 后，运行：

```bash
npm run gate:delivery
```

`check` 验证结构、状态、编码、许可证、链接和发布白名单。`gate:delivery` 进一步检查 Evidence Contract v1，但不会调用模型，也不证明模型真实运行。应在静止工作树运行 Gate；它能拒绝观测到的变化，但不能消除最终观测后的非协作写入。真实 Agent 结果必须由执行者单独产生并记录。详见[脚手架使用指南](docs/scaffold-usage.md)。

## 事务与恢复

初始化使用仓库级排他锁、所有权摘要和事务回滚。它不会执行 `git reset`，不会重写 Git 历史，不会提交、推送或发布，也不会修改 Git remote。

若进程异常退出后保留 `.scaffold-init.lock`，不要直接重试或删除。先确认没有初始化进程仍在运行，再按[陈旧锁恢复流程](docs/scaffold-usage.md#陈旧锁恢复)取得 token 和摘要，并执行 `npm run recover:lock`。事务报告恢复证据时，保留相关文件直到完成所有权检查。

## 仓库结构

```text
docs/               通用设计、实施计划和使用指南
scripts/            Node.js 命令入口
src/                初始化、状态、模板、事务和验证模块
templates/          Skill 项目与许可证模板
tests/              node:test 契约与回归测试
AGENTS.md            开发 Agent 的执行规则
```

## 贡献

提交改动前运行 `npm run check`。行为修改应先提供失败测试；文档修改应同步更新契约测试。Pull Request 只包含当前目标所需的文件，不覆盖无关工作区改动。

## 版本与发布

版本变化记录在 [CHANGELOG.md](CHANGELOG.md)。本仓库只通过不可变 Git Tag 和 GitHub Release 发布，并仅使用 GitHub 自动生成的 source archives（源码归档）；不发布 npm 包，也不上传自定义 Release 资产。`npm pack --dry-run` 只用于检查公开文件白名单。

## 安全

不要在 Issue、日志、fixture、文档或提交历史中加入真实凭据、私人路径和私人邮箱。涉及付费服务、用户配置、破坏性操作或公开发布时，先取得明确授权。安全问题请使用 GitHub 的私密漏洞报告渠道，不要公开披露可利用细节。

## 许可证

脚手架源码采用 [Apache License 2.0](LICENSE)。初始化的新 Skill 默认沿用 Apache-2.0，也可显式选择 MIT 或 UNLICENSED。
