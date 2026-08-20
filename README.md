# Meting API — Cloudflare Workers

自建网易云音乐 API + 账户系统，部署在 **Cloudflare Workers** 上（Worker 名称：`meting-api`，D1 数据库：`meting-users`）。

在线地址：https://meting-api.646474.xyz/

## 项目结构

```
├── index.js       # Worker 主代码（ES Module 格式，纯 ASCII 源码）
├── schema.sql     # D1 数据库表结构（users / sessions / play_counts / login_throttle）
├── wrangler.toml  # wrangler 部署配置（含 D1 binding）
└── README.md
```

## 音乐 API（query 参数路由）

| 参数 | 说明 | 示例 |
|------|------|------|
| `server` | 音乐源（仅 netease） | `netease` |
| `type` | 接口类型 | `playlist` / `song` / `url` / `pic` / `lrc` / `search` |
| `id` | 资源 ID（type=search 时可省略） | `12675886878` |
| `keyword` | 搜索关键词（type=search 时必填） | `周杰伦` |
| `format` | url 接口返回格式，`json` 时返回真实 CDN 地址 | `json` |

示例：

```
# 歌单
https://meting-api.646474.xyz/?server=netease&type=playlist&id=12675886878

# 搜索
https://meting-api.646474.xyz/?server=netease&type=search&keyword=周杰伦

# 歌词
https://meting-api.646474.xyz/?server=netease&type=lrc&id=186016

# 音频 302 重定向（浏览器用自己的 IP 跟网易云 302，最稳定）
https://meting-api.646474.xyz/?server=netease&type=url&id=186016

# 音频真实 CDN 地址（JSON，供播放器音效模式下载 blob 用）
https://meting-api.646474.xyz/?server=netease&type=url&id=186016&format=json
```

## 账户 API（path 路由，D1 支持）

为前端 [音乐馆](https://github.com/666mingqing6/Music) 提供跨设备播放计数同步：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/auth/register` | POST | 注册 `{username, password}` → `{token}`（注册即登录） |
| `/auth/login` | POST | 登录 `{username, password}` → `{token}` |
| `/auth/logout` | POST | 登出（Bearer），删除 session |
| `/user/playcounts` | GET | 拉取全部播放计数（Bearer）→ `{counts}` |
| `/user/playcounts` | PUT | 全量覆盖播放计数（Bearer）`{counts}`，幂等 |

鉴权：`Authorization: Bearer <token>`，token 有效期 90 天。

安全设计：
- 密码 **PBKDF2-SHA256**（100k 迭代 + 随机盐 + 恒定时间比较）
- 登录失败限流：同 IP 10 次 / 10 分钟锁定
- counts 上传校验（key 格式、数值范围、最多 3000 条）

song_key 稳定标识（歌单增删改序不影响计数）：
- 网易云歌：`ne:{网易云歌曲ID}`（歌单内与搜索点播的同一首歌共享计数）
- 本地音乐：`lo:{音频文件URL}`
- 兜底：`ti:{歌名}|{歌手}`

## 525 封锁解决方案（核心）

网易云 CDN 封锁了 Cloudflare IP 段，Worker 直接 `fetch music.163.com` 会收到 **525 SSL 握手失败**。

所有对网易云的上游请求经 `neteaseFetch()` 多级回退：

```
请求 music.163.com
   │
   ├─ 1. 直连（CF IP 未被封时最快，6s 超时）
   │
   ├─ 2. 失败（网络异常或 521/522/523/525/530）
   │     → 走 proxy.646474.xyz 转发（已验证完整支持 weapi 加密 POST）
   │
   └─ 3. 直连失败后开启 5 分钟熔断
         期间请求直接走代理，不再等待直连超时
```

`proxy.646474.xyz` 是同一账户下的另一个 CF Worker（反代），出口可达网易云。

## 部署

### 方式一：wrangler CLI（推荐）

```bash
npm install -g wrangler
wrangler login
wrangler d1 create meting-users                 # 首次：建库（记下 database_id 填入 wrangler.toml）
wrangler d1 execute meting-users --file=./schema.sql --remote   # 建表
wrangler deploy
```

### 方式二：Dashboard 手动

Workers & Pages → Create Worker → 粘贴 `index.js` 内容 → Deploy，再在 Settings → Bindings 添加 D1 绑定（变量名 `DB`）。

### 方式三：Cloudflare API

`PUT /accounts/{account_id}/workers/scripts/meting-api`，multipart 上传 `index.js`（metadata 指定 `main_module`、`compatibility_date` 与 d1 binding）。

> ⚠️ **注意**：若通过 API multipart 上传，代码必须是**纯 ASCII**，否则中文注释会因编码问题损坏成 mojibake（曾导致线上故障）。本仓库的 `index.js` 已是纯 ASCII 源码——注释为英文，中文字符串用 `\uXXXX` 转义（如 `'\u6682\u65e0\u6b4c\u8bcd'` 渲染为「暂无歌词」），可安全上传。

## 自定义域名（国内访问）

Worker 默认域名 `*.workers.dev` 在国内无法解析（会被引导到错误 IP），需自定义域名 + 国内可达的 DNS。

当前方案（华为云 DNS 解析）：

1. Cloudflare 侧：Workers → meting-api → Settings → Domains & Routes → 绑定 `meting-api.646474.xyz`
2. CF DNS 侧：`meting-api` 子域添加 4 条 NS 记录，委派到华为云 DNS
3. 华为云 DNS 配置两条解析：
   - **全网默认**：CNAME → `meting-api.666mingqing666.workers.dev`
   - **中国大陆**（地区解析）：A 记录 → `172.67.196.213` / `104.21.92.175`（即 workers.dev 解析出的 CF 边缘 IP，绕过国内对 workers.dev 的 DNS 污染）

## 历史迁移记录

| 平台 | 状态 | 原因 |
|------|------|------|
| Cloudflare Workers（v1） | ❌ 已弃用 | 网易云封锁 CF IP 段，525 错误，当时无回退方案 |
| 腾讯云 EdgeOne | ❌ 已弃用 | 平台政策限制，无法正常运作 |
| **Cloudflare Workers（v2，当前）** | ✅ 使用中 | `neteaseFetch` 直连 + 代理多级回退解决 525；新增 D1 账户系统 |
