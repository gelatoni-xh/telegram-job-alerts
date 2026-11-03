# Remote Job Radar：MVP 技术方案与部署手册

面向英文远程求职者，通过 Telegram 搜索职位、保存筛选条件，并在用户当地时间发送每日新增提醒。首个来源是 Jobicy；所有国家与来源中的职业均可选择，数据稀少不是关闭入口的理由。

代码仓库：[gelatoni-xh/telegram-job-alerts](https://github.com/gelatoni-xh/telegram-job-alerts)。机器人：[Remote Job Radar](https://t.me/GelatoniJobRadarBot)。Webhook 使用 `https://gelatoni.uk/bots/telegram-job-alerts/webhook`。

本文描述实现结构及可重复操作步骤。实际账号、密码、token、SSH 私钥、服务器 IP、聊天内容和生产配置不进入本文或公开仓库。

## 1. 技术选型与取舍

| 部分 | 方案 | 原因与成本 |
| --- | --- | --- |
| 应用 | Node.js 24、TypeScript、pnpm 10.32.1 | 一个语言与部署单元，锁定依赖 |
| Telegram | grammY、Webhook | 成熟的 TypeScript 客户端；共用现有 HTTPS 域名 |
| HTTP | Fastify | 只提供健康检查及 webhook，无额外网页应用 |
| 数据 | PostgreSQL 17、Prisma 7、pg adapter | 复用现有实例，但独立数据库及账号 |
| 定时与任务 | PostgreSQL 持久化任务表、应用内调度循环 | 少一个 Redis 服务；任务租约和失败恢复需要自行维护 |
| 部署 | Docker Compose、Nginx、GitHub Actions | 可复制镜像与配置，易迁移及单独停机 |
| 来源 | Jobicy 免费 API | 有原生分页和状态检查；存在七天窗口与来源延迟 |
| 备份 | 单库逻辑备份、服务器定时器、本地定时拉取 | 无新增付费基础设施；本地离线时异地副本会延迟 |

一个常驻进程处理 webhook、交互任务、同步、调度和发送。数据库连接池上限 3，其中一个连接持有应用实例锁；不启动第二个常驻 worker。

当前不引入 Redis、独立搜索引擎、支付、广告系统或管理后台。多来源的统一接口在第二个真实来源接入时再抽象；现在只保留来源名称和稳定外部 ID。

## 2. 资源与部署边界

应用部署到现有 Ubuntu-3，不新增服务器。使用独立 Compose project，宿主机只监听 `127.0.0.1:3050`，容器监听 3000，由现有 Nginx 精确转发 webhook 路径。

应用容器限制为 192 MiB、0.5 CPU，V8 heap 96 MiB。迁移任务单独限制 192 MiB；管理命令用 `docker compose --env-file release.env run --rm --no-deps app node dist/src/cli.js <命令>` 在独立临时容器运行，避免与主进程争用同一容器内存；管理命令逐个执行，控制额外数据库连接。镜像在 GitHub CI 构建，不在小服务器上编译依赖。

资源限制是需要实测的运行预算。上线检查完整分页同步、状态检查、交互和汇总，观察内存、重启、OOM、连接数及已有应用健康状态。空闲内存或健康检查通过不能代替完整业务验证。

数据库与现有 PostgreSQL 共用进程、网络及物理卷，独立使用：

- 数据库：`telegram_job_alerts`。
- 迁移账号：`telegram_job_alerts_owner`，拥有本库对象。
- 运行账号：`telegram_job_alerts_app`，仅应用表读写权限。
- 项目自己的配置、删除记录、备份、镜像标签和部署密钥。

共享 PostgreSQL 是明确的生命周期依赖：原应用下线时，不能顺手删除仍承载本项目的数据库容器、网络和卷。迁出时导出本项目单库，恢复到新的 PostgreSQL。

## 3. 仓库结构与配置

```text
src/
  bot.ts              Telegram 菜单、筛选、订阅、设置
  http.ts             webhook 校验和持久化接收
  jobs.ts             Jobicy 同步、清洗、状态和查询
  rules.ts            国家规则、关键词、当地时间
  ui.ts               文案格式、职位卡片、时区候选
  subscriptions.ts    订阅边界与修订号
  tasks.ts            领取、租约、重试
  digests.ts          汇总生成、积压合并、发送
  privacy.ts          删除与恢复重放
  maintenance.ts      保留清理、doctor
  main.ts             单进程启动与调度
  cli.ts              管理命令
prisma/               schema 和版本化 migration
infra/                Compose、Nginx 片段、备份定时器
scripts/              发布、备份、授权、异地拉取
tests/                规则与真实 PostgreSQL 集成测试
docs/                 运维与来源说明
```

配置通过环境变量注入，`.env.example` 仅放占位值。生产凭据只在受保护配置文件内，chmod 600；应用和迁移分别使用 `.env.production`、`.env.migration`。

关键变量：`DATABASE_URL`、`EXPECTED_DATABASE`、`BOT_TOKEN`、`WEBHOOK_SECRET`、`WEBHOOK_URL`、`DATABASE_POOL_MAX`、`DELETION_JOURNAL_PATH`。

`SOURCE_SYNC_ENABLED`、`SCHEDULER_ENABLED`、`DELIVERY_ENABLED` 默认 false。关闭来源开关会停止领取同步与状态任务；关闭调度开关停止生成汇总任务；关闭发送开关停止发送消费者。交互接收仍在运行。迁移或恢复需要完全停止写入时，应停止整个应用。

启动、CLI 和发布前均校验实际数据库名称。应用使用独立会话 advisory lock，避免两个实例同时执行任务；锁连接失效时进程退出。项目只支持一个活跃应用实例。

## 4. 来源同步与匹配

Jobicy 公开文档允许普通商业集成、存储及再展示，无需单独申请；展示时保留来源标识及 API 返回的 Jobicy 原始链接。使用条款以来源当前文档为准。

1. 使用 `/api/jobs?count=100` 开始一轮遍历，严格按 `nextCursor` 顺序继续，筛选参数保持不变。
2. 每小时最多开始一轮自动遍历；游标从首个请求开始有效 24 小时，实现提前在 23 小时后重新开始。
3. 公开 feed 仅覆盖最近七天，具有三小时发布延迟，不能宣称实时或覆盖所有职位。
4. 每页解析并清洗 HTML，再与本页进度在同一事务提交。错误时不提交半页；重试接续已保存游标。
5. 使用 `jobicy:<id>` 稳定标识。相同 ID 更新内容不产生新的发现序号。
6. 岗位离开七天 feed 不等于关闭；使用 `/api/jobs/status?ids=...`，每批最多 100 个。
7. `active` 可展示，明确 `closed` 才确认关闭，`unknown` 隐藏并重查。常规检查每个 ID 每小时或更低频率。
8. 来源失败不把整批岗位关闭。HTTP 429 按 Retry-After 延后任务；解析失败保留可见错误，避免推进错误边界。

所有 ISO 国家保留入口。国家匹配接受明确国家标签、Worldwide/Anywhere、Europe，以及有限的明确居住地和排除句式。APAC、EMEA、LATAM 等范围不确定的标签保留原文，不猜测扩展。

这不是完整自然语言资格判断：可能漏掉符合条件的职位，也不能确认签证、雇佣、税务或工作许可。界面展示来源地域及原始职位入口。

国家组内 OR、职业组内 OR，组间 AND。关键词在标题与描述中按不区分大小写的字面短语匹配；`%`、`_` 等不会变成 SQL 通配符。Any 取消对应组限制。

职业选项包含基础列表及数据库中出现的全部来源标签，来源新增职业无需通过人工开关才能被搜索。当前搜索每页 5 条，允许零结果时继续保存订阅。

## 5. 一致性、订阅与每日提醒

数据模型包含 User、Subscription、Job、SyncRun、InboxUpdate、Task、Digest、DigestItem、Delivery、DeferredMatch、Event，以及提交边界计数器。

Webhook 接收只做校验和持久化，不等待业务处理：

1. 校验精确路由、请求体大小和 Telegram secret header，使用安全比较。
2. 仅接受私聊，按 `update_id` 唯一去重。
3. 在同一数据库事务创建 Inbox 与交互任务，提交后返回成功；数据库失败返回 503，由 Telegram 重试。
4. 单个聊天每分钟超过 60 个接收请求时返回 429，不先确认成功再静默丢弃。
5. 每个聊天按接收任务顺序处理；菜单按钮带状态版本，过期菜单仅弹出提示，不改变当前筛选条件或页面状态。

岗位写入与订阅水位共同锁定已提交发现序号。创建订阅从当时存量之后开始，不推送第一次查询已经看过的库存；同 ID 更新不会重新变成新增。

编辑、暂停和恢复更新订阅修订号与水位，清除旧候选。全局暂停不覆盖每条订阅自己的暂停状态；主动暂停期间的库存不在恢复后补发，可通过搜索查看。

用户先选 IANA 时区与当地发送时间，再完成第一条订阅。调度每 30 秒扫描到期用户；每个用户、当地日期只生成一份汇总。夏令时不存在的时间顺延至首个有效分钟，重复时间使用第一次。

生成汇总时，水位推进、完整成员、匹配到的订阅修订号及发送记录在同一事务保存。一个职位命中多条订阅只展示一次。暂无状态确认的候选进入 DeferredMatch，不能因为推进水位而永久漏掉。空汇总记录已处理日期，但不发送空消息。

摘要展示 3 条，完整列表每页 5 条。成员及顺序持久化，后续新增职位不改变历史分页。发送前校验订阅修订号、用户状态及岗位可用状态；需要时刷新状态，过滤关闭或未知岗位；来源刷新失败时，仍可发送 24 小时内已确认有效的职位并标注更新延迟，超过 24 小时的候选保留待重查。

任务使用 `FOR UPDATE SKIP LOCKED` 短事务领取，租约 90 秒，每 20 秒续租，完成写入校验 lease token。普通失败最多 8 次，指数退避并加抖动；耗尽进入 failed，可检查并人工重试。

发送前持久化 sending，成功后记录 message_id；重启时 sending 转 uncertain。403 标记不可达并停止自动提醒，用户重新交互可恢复可达状态。429 延后；网络断开无法证明 Telegram 是否已经接收，重试可能重复，不能承诺外部 API 的严格一次发送。

未发送的多个日期合并为一份恢复汇总，避免逐日轰炸。主动暂停、删除和修改会使旧修订号候选失效；已经在途的外部消息无法撤回。

国家和职业选项按当前有效且符合其他筛选条件的岗位数降序排列，数量相同按英文名称排序，按钮显示对应岗位数。每个岗位在同一选项内只计一次；跨国家、跨职业的数量不能直接相加。统计不受当前组已选项限制，零岗位选项仍保留；翻页和搜索保持这一排序。回调使用页面生成时保存的选项标识，避免数据更新后点错选项。

交互以首页、搜索面板、结果列表、职位详情和提醒管理组成闭环，页面标题与职位名称加粗。所有动态文本先转义，再使用 Telegram 支持的 HTML 格式；按钮文字不使用 HTML。

- 首页展示有效岗位量、来源更新时间、提醒入口及全局暂停状态；已有筛选条件时提供继续搜索。
- 搜索面板直接展示国家、职业、关键词及当前匹配量。三组条件可独立修改，也可直接查看全部岗位。编辑提醒时，保存前不改变原提醒。
- 国家与职业页用 ✓/○ 标示选择状态，已选项为绿色，完成及关键操作为蓝色。可跨页多选、直接输入名称搜索、清空名称搜索；零匹配提供明确恢复入口。名称搜索不清除已选项。
- 结果列表每页 5 条，展示职位、公司、地域、薪资及简短摘要，按钮直接显示职位名称。详情页保留原结果页或每日摘要页的返回位置，原始 Jobicy 申请入口保持独立。
- 无结果时解释可以放宽条件，并可直接去掉关键词重试；仍允许保存提醒，等待未来新增。
- 提醒界面统一使用 Alert，按运行、单独暂停及全局暂停区分状态；列表每页 8 条。浏览现有匹配不修改订阅水位，重复保存显示已有提醒。创建、编辑、暂停和恢复均在当前页面显示结果；删除有独立确认。
- 第一条提醒保存时选择时区及时间。优先提供已确认时区、所选国家常见时区和常用候选，完整 IANA 列表及城市搜索仍可用，不自动认定用户时区。设置页单独管理发送时间与全局暂停，隐私说明进入独立页面。
- 时区、时间、关键词输入均提供取消或返回入口；非法输入保留上下文并给出示例。回到首页保留搜索条件，收到旧按钮仅提示过期，不重置新流程。
- 每日推送采用统一职位卡片样式，预览最多 3 条，完整列表保留全部持久化成员与原有顺序；详情仍可返回同一摘要页。

`/start` 和 `/menu` 打开首页，`/cancel` 离开输入步骤并保留筛选条件，`/help` 说明使用方式，`/privacy` 打开隐私与数据管理。

## 6. 数据保留与运行检查

已处理 Inbox 内容 7 天后清除，去重 ID 30 天后清除；交互状态 24 小时过期；事件及已结束历史汇总保留 90 天。未完成任务和未解决发送不按普通历史数据到期直接删除。

岗位保存当前字段与来源稳定 ID，不无限保存原始 API 响应。当前不自动删除职位身份记录，防止再次出现被误认为新增。

事件采用幂等键，记录搜索条件维度、是否有关键词、零结果、订阅操作、汇总生成/发送、分页和打开意图，不将整段聊天作为分析数据。点击原始链接按钮不等于申请成功。

用户可删除订阅、配置和可关联活动。删除先写独立删除记录，再清理数据库；恢复备份时必须重放最新删除记录。记录中仍有 Telegram 标识，因此属于受保护运维数据。

备份通常保留 14 天；异地传输失败时延后服务器清理，避免先丢失最后可恢复副本。界面需说明故障可能推迟备份清理。删除记录在仍有更旧可恢复备份时保留，清理前核对备份范围。

`doctor` 输出最近完整同步、最早待处理任务、failed/uncertain 数量、连接数、用户/订阅/岗位数量。容器日志限大小及文件数量，错误信息去除 URL 和凭据模式；不输出 token 或完整连接串。

## 7. 本地开发与创建 GitHub 仓库

1. 安装 Node 24、pnpm 10.32.1，创建独立项目目录。
2. 初始化 Git、README、AGENTS.md、`.gitignore`、`.dockerignore`，忽略真实环境文件、密钥、日志、数据库备份和镜像归档。
3. 新项目使用 `gh repo create <owner>/<repo> --public --source=. --remote=origin`；仓库已存在时仅关联已有 origin，不重复创建。
4. 配置 package.json、锁文件、TypeScript、Prisma schema 与 migration。`pnpm install --frozen-lockfile` 后执行 `pnpm db:generate`。
5. 使用 `docker compose -f infra/compose.local.yml up -d` 启动独立 PostgreSQL 17。
6. 为测试设置 `DATABASE_URL`、`TEST_DATABASE_URL`，目标数据库必须以 `_test` 结尾；测试会清空本库应用表，禁止连接生产。
7. 执行 `pnpm db:migrate`、`pnpm typecheck`、`pnpm test`、`pnpm build`，检查 `git diff --check` 和待提交内容的凭据泄漏。
8. 提交并推送 main。CI 使用临时 PostgreSQL 执行迁移、类型检查、真实数据库测试及镜像构建。
9. 测试覆盖提交边界、重复 ID、字面匹配、暂停恢复、未知状态、分页完整性、租约竞争、聊天顺序、Webhook 去重、夏令时、发送超时、429/403、积压合并和删除重放。

## 8. 服务器初始化与第一次发布

### 8.1 独立资源

1. 先检查 `free`、`df`、已有容器及健康状态、数据库版本、Docker 网络和端口占用。
2. 创建 `/opt/apps/telegram-job-alerts` 及 `state`、`backups`、`releases`、`scripts`、`infra`。目录限制为部署用户，state 对容器 UID 1000 可写。
3. 在现有 PostgreSQL 中创建 owner/app 两个 LOGIN 角色，NOSUPERUSER、NOCREATEDB、NOCREATEROLE，连接上限 5，分别生成密码。
4. 创建独立库，由 owner 持有；撤销本库及 public schema 的 PUBLIC 权限。app 只获 CONNECT、USAGE 和应用对象读写。
5. 为 owner 创建的后续表设置默认读写授权；迁移后再运行 `scripts/grant-runtime.sh`，确保运行账号不能读写 `_prisma_migrations`。
6. 写入两个受保护环境文件，初始三个开关全部 false。`.ops.conf` 仅记录数据库容器和本库名。
7. 复制 Compose 配置，接入现有数据库网络。数据库连接不暴露公网；不修改防火墙或新增公开端口。

### 8.2 CI 与镜像

1. 创建 GitHub production environment，配置独立可撤销 SSH 部署密钥及已核实的 known_hosts。
2. GitHub Secrets 只保存 SSH 部署入口；bot 和数据库凭据留在服务器，不进入镜像与构建日志。
3. 仓库变量 `DEPLOY_ENABLED` 控制部署，准备完成后设 true。PR 只检查，不部署。
4. CI 构建完整 commit SHA 标签镜像，保存归档及 SHA256，上传到项目 `releases/<sha>`。
5. 服务器核对归档后 `docker load`，执行 `scripts/deploy.sh <sha>`；GitHub concurrency 和服务器 flock 串行发布。
6. 发布脚本先备份本库、校验库名，再执行 migration deploy、运行授权、切换 release.env 并只重建本项目 app。
7. 健康检查未通过则发布失败，检查日志及兼容性；不自动逆向修改数据库。

### 8.3 首轮业务与入口

1. 迁移后检查运行账号可读写应用表，不能建表、访问迁移表或切换成 owner。
2. 在调度仍关闭时，通过容器 CLI 执行 `node dist/src/cli.js sync`，完成首轮存量遍历。
3. 在现有域名 TLS server 中加入仓库 Nginx 示例的精确 webhook location，备份原配置，`nginx -t` 成功后 reload。
4. 公网使用错误 secret 请求 webhook，应得到 403；已有博客及其他域名应继续正常。
5. 开启来源、调度和发送，重建本项目 app，再执行 `node dist/src/cli.js webhook` 注册 HTTPS 地址和 secret，不清空 pending updates。
6. 核对 webhook URL、pending 数量及 Telegram 错误。Cloudflare 不应对该路径缓存或返回交互挑战。
7. 使用真实机器人完成搜索、订阅、时区、暂停恢复和删除验证；每日发送使用受控订阅者单独验收，模拟测试不能代替实际 Telegram 消息验证。
8. 完整同步及交互期间检查 RSS、OOM、重启、DB 连接和原有应用。健康检查只是验收项目之一。

## 9. 备份与恢复

1. 安装 `infra/telegram-job-alerts-backup.service` 和 timer；定时器按 UTC 每日执行，Persistent=true，可补执行错过的任务。
2. `scripts/backup.sh` 仅 pg_dump 本库，custom 格式、no-owner。先写临时文件，核对非空及 pg_restore --list，再原子发布。
3. 每份备份记录开始时间、校验和，并复制当时删除记录。开始时间在 dump 前采集，避免遗漏备份期间发生的删除。
4. 本地 `scripts/pull-backups.py` 经已有 SSH 入口拉取本项目备份及最新删除记录，校验全部 dump 后写 last-success.json。
5. 本机调度在电脑开机联网时运行；离线期间服务器继续备份，但异地副本不会自动变新。检查最后成功时间，不把装了调度等同于副本始终新鲜。
6. 异地传输核验成功后，才按 14 天清理本项目两端备份；失败时保留旧副本。不得清理其他业务备份。
7. 恢复演练创建单独临时数据库，使用同版本 pg_restore、no-owner、no-acl 并以 owner 建立对象，核对表数、行数、约束与代表数据。
8. 生产恢复先隔离 webhook 并停应用，再恢复到新库，重建运行授权、校验 schema 和目标库名。
9. 使用最新独立删除记录执行 `replay-deletions <备份开始时间>`，完成后才能恢复交互和发送。只使用旧备份里的删除记录副本不够。
10. 核对用户、订阅、水位、未发送汇总及租约；审查 uncertain。备份后的已发送状态可能丢失，不能承诺恢复后无重复提醒。

每日逻辑备份通常意味着最坏约一天的恢复点损失；备份失败会扩大范围。恢复耗时通过实际演练测量，不预先承诺固定分钟数。

## 10. 日常发布、迁移与下线

日常发布沿用 SHA 镜像、发布前备份、迁移、授权、切换及健康检查。代码回滚必须确认旧版本兼容现有 schema：停应用、恢复 previous-release.env、重新启动并检查。回滚代码不意味着恢复旧数据库。

迁移到独立服务器：

1. 新机准备同版本 PostgreSQL、相同镜像及受保护配置，所有开关关闭，入口隔离。
2. 用近期备份演练，检查运行权限和资源。
3. 删除旧 webhook 时保留 pending updates，停止旧应用及 CLI 写入；确认无消费者后做最终备份。
4. 传输校验、恢复、重放最新删除记录，核对 schema、行数、水位、修订号、任务和待发汇总。
5. 保持同一 bot token，尽量保持公开地址，切换代理或 DNS；更新 CI、备份和拉取目标。
6. 只启动新机应用，重新注册 webhook，进行受控交互及发送。Telegram 更新保留时间有限，不适合无限期停机。
7. 新机产生写入后的回退，必须先停新机并把新状态带回旧机，不能直接启动迁移前快照。

独立下线：

1. 关闭本项目 CI 部署入口，移除 webhook 并停止 app、备份 timer 和本地拉取任务。
2. 删除精确 webhook Nginx location，校验并 reload，检查其他业务。
3. 做最终备份并确认主机外副本，确定保留/删除日期，撤销本项目 SSH 部署密钥。
4. 仅删除本项目容器及确认不再需要的项目镜像和归档，不执行全局 Docker prune。
5. 保留共享数据库容器、网络和卷。删库、删角色、销毁备份属于单独不可逆操作，需要届时基于实际依赖与保留要求执行。

英文运维命令与故障处理详见仓库 [operations.md](https://github.com/gelatoni-xh/telegram-job-alerts/blob/main/docs/operations.md)，来源边界详见 [source.md](https://github.com/gelatoni-xh/telegram-job-alerts/blob/main/docs/source.md)。
