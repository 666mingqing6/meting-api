# Meting API - EdgeOne 边缘函数

网易云音乐 API 部署在腾讯云 EdgeOne 边缘函数上，替代 Cloudflare Workers（后者到 music.163.com 的 TLS 握手被 525 封锁）。

## 文件说明

| 文件 | 说明 |
|------|------|
| `index.js` | meting-api 边缘函数代码（网易云 playlist/song/url/pic/lrc） |
| `proxy.txt` | 通用 CORS 代理边缘函数代码 |
| `deploy_edgeone.py` | 自动部署脚本（通过腾讯云 OpenAPI） |
| `.github/workflows/deploy.yml` | GitHub Action 自动部署 workflow |

## 自动部署

本仓库配置了 GitHub Action，**push 到 main 分支时自动部署**到 EdgeOne。

### 1. 配置 Secrets

在仓库 **Settings → Secrets and variables → Actions** 添加 3 个 Secret：

| Secret 名 | 说明 | 获取方式 |
|-----------|------|---------|
| `TENCENTCLOUD_SECRET_ID` | 腾讯云 API SecretId | [API 密钥管理](https://console.cloud.tencent.com/cam/capi) |
| `TENCENTCLOUD_SECRET_KEY` | 腾讯云 API SecretKey | 同上 |
| `EDGEONE_ZONE_ID` | EdgeOne 站点 ID | EdgeOne 控制台 → 站点列表 → 复制站点 ID（格式 `zone-xxxxxxxx`） |

### 2. 首次部署

配置好 Secrets 后，在仓库 **Actions** 页面：
1. 选择 **Deploy to EdgeOne** workflow
2. 点击 **Run workflow**
3. 选择部署目标（meting-api / proxy / both）
4. 等待部署完成

### 3. 后续更新

修改 `index.js` 后 push 到 main 分支即可自动重新部署。

## 前置条件

### EdgeOne 站点准备

1. 在 EdgeOne 接入你的域名（如 `646474.xyz`）
2. 添加加速域名（如 `meting-api.646474.xyz`）
3. 获取站点 ID 配置到 Secrets

### 腾讯云 API 密钥

1. 访问 [API 密钥管理](https://console.cloud.tencent.com/cam/capi)
2. 创建密钥，获取 SecretId 和 SecretKey
3. 确保账号已开通 EdgeOne 服务并有边缘函数操作权限

## 手动本地部署

```bash
pip install -r requirements.txt

export TENCENTCLOUD_SECRET_ID="你的SecretId"
export TENCENTCLOUD_SECRET_KEY="你的SecretKey"
export EDGEONE_ZONE_ID="zone-xxxxxxxx"

python deploy_edgeone.py meting-api --file index.js
python deploy_edgeone.py proxy
```

## API 接口

部署后访问 `https://meting-api.646474.xyz/`：

| 参数 | 说明 | 示例 |
|------|------|------|
| `server` | 音乐源（目前仅支持 netease） | `netease` |
| `type` | 类型 | `playlist` / `song` / `url` / `pic` / `lrc` |
| `id` | 资源 ID | `12675886878` |

示例：
```
https://meting-api.646474.xyz/?server=netease&type=playlist&id=12675886878
https://meting-api.646474.xyz/?server=netease&type=url&id=2154802869
https://meting-api.646474.xyz/?server=netease&type=lrc&id=2154802869
```

## 从 Cloudflare Workers 迁移

CF Worker 到 `music.163.com` 的 TLS 握手被 525 错误封锁（网易云 CDN 已封锁 Cloudflare IP 段）。EdgeOne 边缘节点为腾讯国内 IP，不被封锁，可正常请求网易云 weapi。
