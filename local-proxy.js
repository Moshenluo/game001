// Local API Proxy Server for Rift of Fate
// Handles both Qwen (via cloudflared tunnel) and DeepSeek API
// Run: node local-proxy.js
// Game connects to http://localhost:3001

const http = require('http');
const https = require('https');

const PORT = 3001;
const QWEN_URL = (process.env.QWEN_URL || 'https://frp-sea.com:52695') + '/v1/chat/completions';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// DeepSeek API key - set via environment variable or use hardcoded default
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || 'sk-a0abe1b7481d4b898c7aa1793268acb2';

function proxyRequest(targetUrl, body, headers, res) {
  const url = new URL(targetUrl);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    rejectUnauthorized: false, // Allow self-signed certs (Sakura Frp)
    timeout: 60000
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[Proxy Error]', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Proxy timeout' }));
  });

  proxyReq.write(body);
  proxyReq.end();
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = req.url;
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    // Health check
    if (url === '/' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: 'ok', source: 'local-proxy', qwen: true, deepseek: !!DEEPSEEK_KEY }));
      return;
    }

    // DeepSeek route
    if (url === '/api/ai' && req.method === 'POST') {
      if (!DEEPSEEK_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set. Run: set DEEPSEEK_API_KEY=sk-xxx' }));
        return;
      }
      try {
        const parsed = JSON.parse(body);
        // Map model name
        const MODEL_MAP = { 'deepseek': 'deepseek-v4-flash', 'deepseek-chat': 'deepseek-v4-flash' };
        parsed.model = MODEL_MAP[parsed.model] || parsed.model || 'deepseek-v4-flash';
        // Disable thinking for V4
        if (parsed.model.includes('v4')) {
          parsed.thinking = { type: 'disabled' };
          parsed.max_tokens = Math.max(parsed.max_tokens || 2000, 4096);
        }
        console.log(`[DeepSeek] model=${parsed.model}, tokens=${parsed.max_tokens}`);
        proxyRequest(DEEPSEEK_URL, JSON.stringify(parsed), {
          'Authorization': 'Bearer ' + DEEPSEEK_KEY
        }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
      }
      return;
    }

    // Qwen direct route (via cloudflared tunnel)
    if (url === '/api/direct' && req.method === 'POST') {
      try {
        const parsed = JSON.parse(body);
        parsed.chat_template_kwargs = { enable_thinking: false };
        console.log(`[Qwen] model=${parsed.model || 'qwen3.6'}`);
        proxyRequest(QWEN_URL, JSON.stringify(parsed), {}, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
      }
      return;
    }

    // Leaderboard/save/load stubs (local mode)
    if (url.startsWith('/api/leaderboard')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(req.method === 'GET' ? [] : { ok: true, rank: 1, total: 1 }));
      return;
    }
    if (url === '/api/save' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, playerId: 'LOCAL', message: '本地存档(仅内存)' }));
      return;
    }
    if (url === '/api/load' && req.method === 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '本地模式暂无存档' }));
      return;
    }
    if (url === '/api/achievements' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ earned: [], newAchievements: [], all: [], total: 0, unlocked: 0 }));
      return;
    }

    // Image generation proxy (highwayapi.ai)
    if (url === '/api/image' && req.method === 'POST') {
      const IMAGE_KEY = process.env.IMAGE_API_KEY || 'sk_T0j2q5MKukBqeg8yQkGx6FDGGzVHl1S1BmoMmK9JwP0';
      try {
        const parsed = JSON.parse(body);
        console.log(`[Image] model=${parsed.model || 'gpt-image-2'}, size=${parsed.size || '1024x1024'}`);
        proxyRequest('https://api.highwayapi.ai/v3/gpt-image-2-text-to-image', JSON.stringify(parsed), {
          'Authorization': 'Bearer ' + IMAGE_KEY
        }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Not found: ' + url }));
  });
});

server.listen(PORT, () => {
  console.log(`\n🎮 Rift of Fate 本地代理已启动!`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   Qwen: ${QWEN_URL.includes('frp-sea') ? '✅ 直连 frp-sea.com:52695' : QWEN_URL.includes('trycloudflare') ? '✅ cloudflared隧道' : '❌ 未配置'}`);
  console.log(`   DeepSeek: ${DEEPSEEK_KEY ? '✅ 已配置API Key' : '❌ 未设置 DEEPSEEK_API_KEY'}`);
  if (!DEEPSEEK_KEY) {
    console.log(`\n   设置DeepSeek Key: set DEEPSEEK_API_KEY=sk-你的key`);
    console.log(`   然后重新运行: node local-proxy.js\n`);
  }
  console.log(`\n⚙️ 游戏访问: http://localhost:8080 (WORKER_URL 默认已指向 localhost:${PORT})\n`);
});
