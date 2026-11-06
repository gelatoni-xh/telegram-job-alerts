# Remote Job Radar · 远程职位雷达

[![中文](https://img.shields.io/badge/阅读中文-README.md-1677ff?style=flat-square)](README.md) [![English](https://img.shields.io/badge/Read%20English-README.en.md-555?style=flat-square)](README.en.md)

一个使用英文交互的 Telegram Bot，帮助你发现远程职位，并接收符合个人偏好的每日摘要。职位来自 [Jobicy](https://jobicy.com/jobs-rss-feed)，所有申请链接均指向原始职位页面。

[打开 Bot](https://t.me/GelatoniJobRadarBot) · [运维指南](docs/operations.md) · [数据源与匹配规则](docs/source.md)

## 功能

- 按关键词、类别和地区浏览远程职位。
- 保存订阅偏好，接收每日摘要。
- 对职位去重并保留投递状态，确保摘要内容和发送记录一致。
- 跳转 Jobicy 查看完整职位说明及申请信息。

## 技术栈

TypeScript · Node.js 24 · grammY · Fastify · PostgreSQL 17 · Prisma

## 本地运行

使用 Node.js 24 和 pnpm 10.32.1。复制 `.env.example` 配置本地环境，启动 `infra/compose.local.yml` 中的独立 PostgreSQL 服务，然后安装依赖并初始化数据库：

```sh
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm typecheck
pnpm test
pnpm build
```

配置、部署、备份、迁移和停机流程见[运维指南](docs/operations.md)。本仓库目前未声明开源许可证。
