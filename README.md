# Meting API — Cloudflare Workers

自建网易云音乐 API，部署在 **Cloudflare Workers** 上（Worker 名称：`meting-api`）。

在线地址：https://meting-api.646474.xyz/

## 项目结构

```
├── index.js       # Worker 主代码（ES Module 格式，纯 ASCII 源码）
├── wrangler.toml  # wrangler 部署配置
└── README.md
```

## API 接口

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

### 接口说明

- **playlist / song / search**：调用网易云 weapi 加密接口（AES-128-CBC 双重加密 + RSA），纯 JS 实现，无外部依赖
- **url**：默认 302 到网易云公开直链（`music.163.com/song/media/outer/url?id=xxx.mp3`）；`format=json` 时调 weapi 解析真实 CDN 地址
- **pic**：优先使用 `src` 参数传入的真实 picUrl，否则本地计算网易云加密 ID 构造直链（MD5 + XOR magic string）
- **lrc**：调 weapi 获取歌词，失败返回占位文本
- **search**：多级回退 —— 方案1 weapi/cloudsearch（加密搜索），方案2 旧版 GET 搜索接口（无加密）

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
wrangler deploy
```

### 方式二：Dashboard 手动

Workers & Pages → Create Worker → 粘贴 `index.js` 内容 → Deploy

### 方式三：Cloudflare API

`PUT /accounts/{account_id}/workers/scripts/meting-api`，multipart 上传 `index.js`（metadata 指定 `main_module` 与 `compatibility_date`）。

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
| **Cloudflare Workers（v2，当前）** | ✅ 使用中 | `neteaseFetch` 直连 + 代理多级回退，彻底解决 525 |
