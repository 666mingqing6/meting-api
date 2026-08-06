# Meting API - EdgeOne 边缘函数

网易云音乐 API 部署在腾讯云 EdgeOne 上，替代 Cloudflare Workers（后者到 music.163.com 的 TLS 握手被 525 封锁）。

## 自动部署

EdgeOne 已连接本 GitHub 仓库，**push 代码到 main 分支即自动部署**，无需任何手动操作或额外脚本。

## 文件说明

| 文件 | 说明 |
|------|------|
| `index.js` | meting-api 边缘函数代码（网易云 playlist/song/url/pic/lrc） |
| `proxy.txt` | 通用 CORS 代理边缘函数代码 |

## API 接口

访问 `https://meting-api.646474.xyz/`：

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

Cloudflare Workers 到 `music.163.com` 的 TLS 握手被 525 错误封锁（网易云 CDN 已封锁 Cloudflare IP 段）。EdgeOne 边缘节点为腾讯国内 IP，不被封锁，可正常请求网易云 weapi。
