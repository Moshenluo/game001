# 命运裂隙 - 后端部署指南

## Cloudflare Worker 部署（3分钟搞定）

### 前置条件
1. 注册 [Cloudflare 账号](https://dash.cloudflare.com/) （免费）
2. 安装 Node.js

### 步骤

```bash
# 1. 进入 worker 目录
cd worker

# 2. 安装 Wrangler CLI
npm install -g wrangler

# 3. 登录 Cloudflare
wrangler login

# 4. 创建 KV 命名空间（用于存储排行榜、存档、成就）
wrangler kv:namespace create RIFT_KV
# 会输出一个 ID，复制它

# 5. 编辑 wrangler.toml，把 YOUR_KV_NAMESPACE_ID 替换为上面的 ID

# 6. 设置 DeepSeek API 密钥（安全存储，不会出现在代码中）
wrangler secret put DEEPSEEK_API_KEY
# 粘贴你的 API Key: sk-xxxxx

# 7. 部署！
wrangler deploy
```

部署完成后会显示 Worker URL，类似：
`https://rift-of-fate.your-subdomain.workers.dev`

### 更新前端配置

修改 `game/index.html` 中的 `WORKER_URL`：
```javascript
const WORKER_URL = 'https://rift-of-fate.your-subdomain.workers.dev';
```

### 验证

```bash
curl https://rift-of-fate.your-subdomain.workers.dev/health
# 应返回: {"status":"ok","game":"命运裂隙","version":"2.0",...}
```

## 自定义域名（可选）

在 Cloudflare Dashboard → Workers → rift-of-fate → Triggers → 添加自定义域名

## 免费额度

- Workers: 10万次请求/天（免费）
- KV: 1GB 存储 + 10万次读/天（免费）
- 对于个人游戏完全够用

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/ai` | POST | AI代理（代理DeepSeek调用） |
| `/api/leaderboard` | GET/POST | 排行榜查询/提交 |
| `/api/save` | POST | 保存游戏进度 |
| `/api/load` | POST | 读取游戏存档 |
| `/api/achievements` | POST | 成就检查/更新 |
