# Relay Status Monitor

一个面向 AI API 中转站的自托管状态监控面板。它可以统一管理多个 SUB2API 与 New API 上游，按 Key/分组采集余额、延迟、可用率和模型测速数据，并通过告警规则与飞书 Webhook 发送异常通知。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/yigehaozi/relay-status-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/yigehaozi/relay-status-monitor/actions/workflows/ci.yml)
[![Next.js](https://img.shields.io/badge/Next.js-14-black.svg)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-required-336791.svg)](https://www.postgresql.org/)

> 仓库只包含程序源码、公开文档和合成演示数据，不包含生产数据库、真实上游凭证、运行日志或内部开发记录。

## 界面预览

所有预览均使用合成演示数据，不对应真实服务、余额或账号。

### 桌面端

[![桌面端登录页](docs/screenshots/desktop/login.png)](docs/screenshots/desktop/login.png)

[![桌面端总览页](docs/screenshots/desktop/dashboard.png)](docs/screenshots/desktop/dashboard.png)

[![桌面端上游管理页](docs/screenshots/desktop/upstreams.png)](docs/screenshots/desktop/upstreams.png)

[![桌面端上游详情页](docs/screenshots/desktop/upstream-detail.png)](docs/screenshots/desktop/upstream-detail.png)

[![桌面端告警事件页](docs/screenshots/desktop/incidents.png)](docs/screenshots/desktop/incidents.png)

[![桌面端设置页](docs/screenshots/desktop/settings.png)](docs/screenshots/desktop/settings.png)

### 手机端

<p align="center"><a href="docs/screenshots/mobile/login.png"><img src="docs/screenshots/mobile/login.png" alt="手机端登录页" width="390"></a></p>
<p align="center"><a href="docs/screenshots/mobile/dashboard.png"><img src="docs/screenshots/mobile/dashboard.png" alt="手机端总览页" width="390"></a></p>
<p align="center"><a href="docs/screenshots/mobile/upstreams.png"><img src="docs/screenshots/mobile/upstreams.png" alt="手机端上游管理页" width="390"></a></p>
<p align="center"><a href="docs/screenshots/mobile/upstream-detail.png"><img src="docs/screenshots/mobile/upstream-detail.png" alt="手机端上游详情页" width="390"></a></p>
<p align="center"><a href="docs/screenshots/mobile/incidents.png"><img src="docs/screenshots/mobile/incidents.png" alt="手机端告警事件页" width="390"></a></p>
<p align="center"><a href="docs/screenshots/mobile/settings.png"><img src="docs/screenshots/mobile/settings.png" alt="手机端设置页" width="390"></a></p>

## 主要能力

- 多上游管理：支持 SUB2API 与 New API，可为一个上游配置多个独立 Key/分组。
- 指标采集：记录余额、接口延迟、模型测试延迟、首 Token 延迟和流式 TPS。
- 轻重分层：日常刷新只查询余额和模型列表；重量采集会发送少量模型生成请求。
- 状态聚合：分别维护 Key 状态和上游汇总状态，支持在线、降级、离线和未知状态。
- 远端元数据：New API 可同步 Token 名称、分组名称、分组说明和倍率。
- 告警管理：支持余额、延迟、连续失败和最近一小时可用率规则，并提供冷却与自动恢复。
- 通知渠道：当前支持飞书自定义机器人 Webhook，可选签名密钥。
- 响应式界面：桌面端与手机端均可使用，并支持深色/浅色主题。
- 本地认证：使用用户名和密码登录，登录会话保存在 HttpOnly Cookie 中。

## 支持的上游

| 类型 | 余额 | 延迟/模型列表 | 模型与流式测速 | 远端 Key 元数据 | 所需凭证 |
| --- | --- | --- | --- | --- | --- |
| `SUB2API` | `GET /v1/usage` | `GET /v1/models` | `POST /v1/chat/completions` | 仅使用余额响应中可用的分组字段 | API Key |
| `NEW_API` | `GET /api/user/self` | `GET /v1/models` | `POST /v1/chat/completions` | Token 搜索、Token 用量和用户分组接口 | API Key；余额和完整元数据还需要 Access Token 与用户 ID |

不同部署或二次开发版本的接口可能存在差异。添加上游后，请先使用“测试”或“刷新”确认兼容性。重量测试会产生真实模型请求并消耗少量额度。

## 技术栈

- Next.js 14、React 18、TypeScript
- Tailwind CSS、shadcn/ui、TanStack Table、Recharts
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
| `APP_ENCRYPTION_KEY` | 是 | 仅用于加密上游凭证；应用运行和 demo seed 均需要，至少 32 字节。 |
| `SESSION_SECRET` | 是 | 仅用于签发登录会话；至少 32 字节且不得与 `APP_ENCRYPTION_KEY` 相同。 |
| `CRON_SECRET` | 建议 | 定时采集接口的 Bearer 密钥，也可以登录后在设置页保存。数据库设置优先于环境变量。 |
| `NEXT_PUBLIC_APP_NAME` | 否 | 预留的客户端应用名称配置。 |
| `ADMIN_PASSWORD` | seed 必填 | 基础 seed 为 `admin` 用户设置的密码。缺失或为空时 seed 会拒绝运行。 |
| `DEMO_ADMIN_PASSWORD` | demo seed 必填 | 演示用户 `demo` 的密码。 |
| `DEMO_CRON_SECRET` | demo seed 必填 | 演示数据库中保存的定时采集密钥。 |

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
- 默认告警规则；
- 默认采集参数。

基础 seed 会幂等更新 `admin` 的密码，不会写入上游、API Key、Access Token 或指标数据。

需要预览完整界面时，可以在独立的演示数据库中写入合成数据：

```bash
DATABASE_URL='postgresql://demo_user:strong_password@127.0.0.1:5432/relay_monitor_demo?schema=public' \
APP_ENCRYPTION_KEY='replace-with-a-demo-only-encryption-key' \
SESSION_SECRET='replace-with-a-different-demo-session-key' \
DEMO_ADMIN_PASSWORD='replace-with-a-demo-password' \
DEMO_CRON_SECRET='replace-with-a-demo-cron-secret' \
pnpm db:seed:demo
```

演示 seed 会创建 `demo` 用户，以及 12 个虚构上游、20 个分组、1120 条 7 天指标、7 条告警、规则和设置。为完整展示凭证状态，它还会生成 19 个合成 API Key 和 9 个合成 Access Token，并使用本次显式传入的 `APP_ENCRYPTION_KEY` 加密；这些值只以 `sk-demo-*` / `access-demo-*` 形式存在，不连接任何真实服务。再次执行时，只会重建固定的演示上游数据，但会更新同名演示规则、渠道和设置。

演示 seed 不会读取项目根目录的 `.env`，`DATABASE_URL`、`APP_ENCRYPTION_KEY`、`SESSION_SECRET`、`DEMO_ADMIN_PASSWORD` 和 `DEMO_CRON_SECRET` 必须通过当前进程环境显式提供。它只应连接到本地或专用演示数据库，避免把演示设置混入生产环境。登录用户名固定为 `demo`，密码是执行命令时提供的 `DEMO_ADMIN_PASSWORD`。

> 当前仓库以 `prisma db push` 作为首次部署方式。若在生产环境长期维护 schema，请在自己的发布流程中采用 Prisma Migration，并在迁移前备份数据库。

### 4. 启动开发服务

```bash
pnpm dev
```

默认访问地址为 [http://localhost:3000](http://localhost:3000)。如需使用其他端口：

```bash
pnpm exec next dev -p 3100
```

登录后建议按以下顺序配置：

1. 在“设置 > 修改密码”中定期更新管理员密码。
2. 在“上游管理”中添加上游。
3. 为上游添加 Key/分组并填写所需凭证。
4. 执行一次轻量刷新或完整测试。
5. 配置告警规则、飞书 Webhook 和定时采集密钥。

## 凭证配置

### SUB2API

每个分组至少需要一个 API Key。系统使用它查询 `/v1/usage` 和 `/v1/models`，重量测试还会请求 `/v1/chat/completions`。

普通 API Key 不一定有权限查询分组管理接口。因此，系统只会保存上游在用量响应中明确返回的分组信息，不会猜测名称、说明或倍率。

### New API

New API 使用两套独立凭证：

- API Key：用于 Token 用量、模型列表和模型测试。
- Access Token + 用户 ID：用于账户余额、Token 搜索和用户分组配置。

只配置 API Key 时，系统仍可执行模型相关检查，并尽可能读取 Token 名称；余额和完整分组信息可能不可用。创建、编辑或手动刷新 Key 时，系统会尝试同步远端元数据，失败不会清空已经保存的凭证或旧元数据。

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

每次触发都会采集所有已启用上游中的已启用 Key：

- 轻量模式：余额 + `/v1/models` 延迟，不发送模型生成请求。
- 重量模式：在轻量模式基础上执行非流式模型测试和流式 TPS 测试，会消耗少量额度。
- 重量采集周期由设置页中的“重量采集间隔”决定。

设置页会根据当前访问地址和保存的 `CRON_SECRET` 生成命令。数据库中的 `cron_secret` 优先于环境变量中的 `CRON_SECRET`。

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
- 修改 `APP_ENCRYPTION_KEY` 前先规划凭证迁移；直接更换会导致现有加密凭证无法解密。
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
| `DATABASE_URL='...' APP_ENCRYPTION_KEY='...' SESSION_SECRET='...' DEMO_ADMIN_PASSWORD='...' DEMO_CRON_SECRET='...' pnpm db:seed:demo` | 向显式指定的独立数据库写入合成演示数据 |
| `pnpm db:studio` | 打开 Prisma Studio |

## 扩展适配器

适配器位于 `src/lib/adapters/`。新增上游类型时需要：

1. 在 Prisma 的 `UpstreamType` 中增加类型并更新数据库。
2. 实现 `UpstreamAdapter` 的余额、延迟、模型列表、模型测试和流式测试方法。
3. 如远端支持，再实现可选的 `fetchKeyMetadata`。
4. 在适配器注册表中注册新实现。
5. 在上游表单中增加新类型选项，并验证凭证字段与错误提示。

适配器必须使用统一的超时控制，并返回脱敏错误；任何响应都不得把 API Key 或 Access Token 写入日志、指标或客户端 DTO。

## 故障排查

### Prisma 无法连接数据库

- 检查 `DATABASE_URL` 的主机、端口、数据库名和账号权限。
- 确认 PostgreSQL 已启动，并允许应用所在网络访问。
- 首次部署重新执行 `pnpm db:generate` 和 `pnpm db:push`。

### 登录后立即返回登录页

- 确认 `SESSION_SECRET` 已配置且所有应用实例一致，并与 `APP_ENCRYPTION_KEY` 不同。
- 生产环境必须通过 HTTPS 访问，否则安全 Cookie 可能无法正常保存。
- 更换 `SESSION_SECRET` 或修改密码后，旧会话会失效，需要重新登录。

### 已保存的上游凭证不可用

- 确认当前 `APP_ENCRYPTION_KEY` 与写入凭证时相同。
- 检查上游地址是否可从服务器访问，以及证书和 DNS 是否正常。
- New API 余额查询需要同时配置 Access Token 与用户 ID。
- 使用“刷新”执行轻量检查；使用“测试”执行完整模型检查。

### CRON 返回 401

- 检查 Authorization Header 是否严格为 `Bearer <secret>`。
- 若设置页保存过 `CRON_SECRET`，应使用数据库中的值，而不是旧环境变量。
- 避免在代理层移除 `Authorization` Header。

### 重量采集消耗过多额度

- 增大“重量采集间隔”。
- 为每个 Key 选择成本更低、响应更稳定的测试模型。
- 日常人工检查优先使用轻量“刷新”，仅在需要验证生成能力时执行“测试”。

### 飞书没有收到告警

- 确认告警渠道和对应规则均已启用。
- 检查 Webhook 地址、可选签名密钥和机器人安全策略。
- 告警存在冷却窗口；同一 Key、同一类型在冷却期内不会重复发送。

## 安全说明

- 上游 API Key 和 Access Token 使用 AES-256-GCM 加密后写入数据库。
- `APP_ENCRYPTION_KEY` 只应通过受控环境变量提供，不能与数据库备份存放在同一公开位置。
- `SESSION_SECRET` 必须与应用加密密钥分离，并只通过受控环境变量提供。
- 登录密码使用 bcrypt 哈希且最少 14 个字符；会话使用 7 天有效期的 HttpOnly、SameSite Cookie。
- 前端 API 只返回 `hasApiKey`、`hasAccessToken` 等状态，不返回凭证明文或密文。
- CRON 接口不依赖登录 Cookie，必须使用独立、高强度的 `CRON_SECRET`。
- 飞书 Webhook 配置和数据库中的 CRON 密钥属于敏感数据，应限制数据库和管理员账号访问。
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
