# Meting API - EdgeOne 边缘函数

网易云音乐 API 部署在腾讯云 EdgeOne Makers 上，通过 GitHub 连接自动部署。

## 项目结构

```
├── functions/
│   ├── index.js       # meting-api（路由 /，处理所有 API 请求）
│   └── proxy.js       # 通用 CORS 代理（路由 /proxy）
├── static/
│   └── index.html     # 静态首页
└── README.md
```

EdgeOne Makers 自动检测 `functions/` 目录的边缘函数，`functions/index.js` 匹配根路径 `/`。

## 自动部署

EdgeOne 已连接本 GitHub 仓库，**push 代码到 main 分支即自动部署**。

## API 接口

访问部署域名（如 `https://meting-api.646474.xyz/`）：

| 参数 | 说明 | 示例 |
|------|------|------|
| `server` | 音乐源（仅 netease） | `netease` |
| `type` | 类型 | `playlist` / `song` / `url` / `pic` / `lrc` |
| `id` | 资源 ID | `12675886878` |

示例：
```
https://meting-api.646474.xyz/?server=netease&type=playlist&id=12675886878
https://meting-api.646474.xyz/?server=netease&type=url&id=2154802869
https://meting-api.646474.xyz/?server=netease&type=lrc&id=2154802869
```

## 背景

Cloudflare Workers 到 `music.163.com` 的 TLS 握手被 525 错误封锁（网易云 CDN 已封锁 Cloudflare IP 段）。EdgeOne 边缘节点为腾讯国内 IP，不被封锁。
