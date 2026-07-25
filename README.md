# Relay Status Monitor

一个面向 Sub2API 账号真实流量的自托管可观测面板。服务通过只读数据库连接同步账号与请求指标，提供统一窗口、覆盖完整性、告警事件和飞书 Webhook 通知。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/yigehaozi/relay-status-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/yigehaozi/relay-status-monitor/actions/workflows/ci.yml)
[![Next.js](https://img.shields.io/badge/Next.js-14-black.svg)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-required-336791.svg)](https://www.postgresql.org/)

> 仓库只包含程序源码和公开文档，不包含生产数据库、真实凭证、运行日志或内部开发记录。

## 主要能力

- 账号总览：支持今天、近 1 小时和近 24 小时窗口，以及可调度状态、平台、分组和搜索筛选。
- 真实流量指标：聚合可用率、错误率、总延迟、首 Token 延迟、缓存命中和双口径计费。
- 覆盖完整性：区分完整、账号上线前缺失、采集延迟和中间缺口，不把缺失数据当作零值。
- 账号详情：展示趋势、分钟明细、调度状态和逐账号倍率告警配置。
- 告警管理：提供七类固定账号规则、事件筛选、冷却和自动恢复。
- 通知渠道：当前支持飞书自定义机器人 Webhook，可选签名密钥。
- 响应式界面：桌面端与手机端均可使用，并支持深色/浅色主题。
- 认证：支持本地管理员会话与 Sub2API 管理员启动票据。

## 技术栈

- Next.js 15、React 18、TypeScript
- Tailwind CSS、shadcn/ui、Recharts
- Prisma 6、PostgreSQL
- bcrypt、JWT、AES-256-GCM

详细设计见 [系统架构](docs/architecture.md)。

## Quick Start（快速开始）

### 环境要求

- Node.js 20 LTS 或更新版本
- pnpm 9 或更新版本
- PostgreSQL 14 或更新版本
- 可选：`curl` 与系统 `cron`，用于定时采集

### 1. 获取源码

```bash
git clone https://github.com/yigehaozi/relay-status-monitor.git
cd relay-status-monitor
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

至少设置数据库、应用加密密钥与独立会话密钥：

```dotenv
DATABASE_URL="postgresql://monitor_user:strong_password@127.0.0.1:5432/relay_monitor?schema=public"
SUB2API_DATABASE_URL="postgresql://readonly_user:strong_password@127.0.0.1:5432/sub2api?schema=public"
APP_ENCRYPTION_KEY="replace-with-a-long-random-secret"
SESSION_SECRET="replace-with-a-different-long-random-secret"
CRON_SECRET="replace-with-an-independent-random-secret"
```

可以使用 OpenSSL 生成随机密钥：

```bash
openssl rand -base64 48
```

环境变量说明：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | PostgreSQL 连接字符串。生产环境建议使用独立数据库和最小权限账号。 |
| `SUB2API_DATABASE_URL` | 是 | Sub2API PostgreSQL 只读连接串，仅用于账号与真实流量采集。 |
| `APP_ENCRYPTION_KEY` | 是 | 仅用于加密通知渠道配置，至少 32 字节。 |
| `SESSION_SECRET` | 是 | 仅用于签发登录会话；至少 32 字节且不得与 `APP_ENCRYPTION_KEY` 相同。 |
| `CRON_SECRET` | 建议 | 定时采集接口的 Bearer 密钥，仅从服务端环境变量读取。设置 API 和数据库不保存该值。 |
| `NEXT_PUBLIC_APP_NAME` | 否 | 预留的客户端应用名称配置。 |
| `ADMIN_PASSWORD` | seed 必填 | 基础 seed 为 `admin` 用户设置的密码。缺失或为空时 seed 会拒绝运行。 |

不要把 `.env`、数据库导出、API Key、Access Token、Webhook 地址或签名密钥提交到版本库。

### 3. 初始化数据库

生成 Prisma Client，并把当前 schema 同步到空数据库：

```bash
pnpm db:generate
pnpm db:push
```

写入基础数据，并显式设置管理员密码：

```bash
ADMIN_PASSWORD='replace-with-a-strong-password' pnpm db:seed
```

基础 seed 会创建：

- 管理员 `admin`，密码来自本次执行的 `ADMIN_PASSWORD`；
- 默认账号告警规则；
- 默认采集参数。

基础 seed 会幂等更新 `admin` 的密码，不会写入账号、指标或告警事件数据。

> 当前仓库以 `prisma db push` 作为首次部署方式。若在生产环境长期维护 schema，请在自己的发布流程中采用 Prisma Migration，并在迁移前备份数据库。

### 4. 启动开发服务

```bash
pnpm dev
```

默认访问地址为 [http://localhost:3000](http://localhost:3000)。如需使用其他端口：

```bash
pnpm exec next dev -p 3100
```

登录后可在设置页管理账号告警规则、飞书通知渠道和本地管理员密码。

## 定时采集

定时采集入口为：

```text
GET /api/cron/collect
Authorization: Bearer <CRON_SECRET>
```

建议每分钟触发一次：

```cron
* * * * * curl -fsS -H 'Authorization: Bearer replace-with-your-cron-secret' 'https://monitor.example/api/cron/collect' > /dev/null
```

每次触发会同步账号投影、重算最近完整分钟的真实流量指标并评估账号告警。采集只读取数据库，不发送模型生成请求。

设置页只显示服务端是否已配置 `CRON_SECRET`，不会读取、编辑或展示该值。部署时请在服务器环境中设置密钥，并在受控的 crontab 配置中引用同一个值。

## 生产运行

```bash
pnpm build
pnpm start
```

生产部署建议：

- 使用进程管理器或容器保持单个 Next.js 服务稳定运行。
- 使用反向代理提供 HTTPS，并只开放必要端口。
- 为 PostgreSQL 配置定期加密备份。
- 将 `.env` 交给部署平台的 Secret 管理能力，不写入镜像或仓库。
- 为外部 cron 设置超时、失败日志和重试策略，避免无界并发。
- 修改 `APP_ENCRYPTION_KEY` 前先规划通知渠道配置迁移；直接更换会导致现有加密配置无法解密。
- 更换 `SESSION_SECRET` 会使所有已有会话失效。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动开发服务 |
| `pnpm build` | 创建生产构建 |
| `pnpm start` | 启动生产服务 |
| `pnpm lint` | 执行代码检查 |
| `pnpm db:generate` | 生成 Prisma Client |
| `pnpm db:push` | 将 schema 同步到数据库 |
| `ADMIN_PASSWORD='...' pnpm db:seed` | 写入基础数据并设置 `admin` 密码 |
| `pnpm db:migrate:alert-channels` | 将旧版飞书明文配置一次性迁移为版本化密文，可幂等重复执行 |
| `pnpm db:studio` | 打开 Prisma Studio |

## 故障排查

### Prisma 无法连接数据库

- 检查 `DATABASE_URL` 的主机、端口、数据库名和账号权限。
- 确认 PostgreSQL 已启动，并允许应用所在网络访问。
- 首次部署重新执行 `pnpm db:generate` 和 `pnpm db:push`。

### 登录后立即返回登录页

- 确认 `SESSION_SECRET` 已配置且所有应用实例一致，并与 `APP_ENCRYPTION_KEY` 不同。
- 生产环境必须通过 HTTPS 访问，否则安全 Cookie 可能无法正常保存。
- 更换 `SESSION_SECRET` 或修改密码后，旧会话会失效，需要重新登录。

### CRON 返回 401

- 检查 Authorization Header 是否严格为 `Bearer <secret>`。
- 确认运行服务的环境变量中配置了 `CRON_SECRET`；数据库中的旧 `cron_secret` 不会被读取。
- 避免在代理层移除 `Authorization` Header。

### 飞书没有收到告警

- 确认告警渠道和对应规则均已启用。
- 检查 Webhook 地址、可选签名密钥和机器人安全策略。
- 告警存在冷却窗口；同一账号、同一规则在冷却期内不会重复发送。

## 安全说明

- 飞书 Webhook 与可选签名密钥使用 AES-256-GCM 加密后写入数据库。
- `APP_ENCRYPTION_KEY` 只应通过受控环境变量提供，不能与数据库备份存放在同一公开位置。
- `SESSION_SECRET` 必须与应用加密密钥分离，并只通过受控环境变量提供。
- 登录密码使用 bcrypt 哈希且最少 14 个字符；会话使用 7 天有效期的 HttpOnly、SameSite Cookie。
- CRON 接口不依赖登录 Cookie，必须使用独立、高强度的 `CRON_SECRET`。
- 飞书 Webhook 配置为 write-only；API 只返回是否已配置，不返回明文、密文或末尾片段。
- 对外部署前请使用高强度管理员密码，并启用 HTTPS、数据库备份和网络访问控制。

如发现安全问题，请不要在公开 Issue 中粘贴凭证、数据库内容或完整响应。请只提供可复现的脱敏信息。

## 参与贡献

1. Fork 本仓库并从 `main` 创建功能分支。
2. 保持改动聚焦，并同步更新相关公开文档。
3. 提交前运行代码检查和生产构建。
4. 确认提交中不含 `.env`、数据库导出、真实截图、运行日志或凭证。
5. 创建 Pull Request，说明问题、方案、验证方式和兼容性影响。

更多协作规则见 [贡献指南](CONTRIBUTING.md)、[安全策略](SECURITY.md) 和 [行为准则](CODE_OF_CONDUCT.md)。版本变化见 [CHANGELOG](CHANGELOG.md)。

## License

本项目使用 [MIT License](LICENSE)。
