// Local CORS proxy for llama.cpp server (HTTPS remote support)
// Auto-injects chat_template_kwargs to disable Qwen3 thinking mode
// Usage: node proxy.js [local_port] [remote_url]
// Example: node proxy.js 18080 https://frp-sea.com:52695

const http = require('http');
const https = require('https');

const LOCAL_PORT = parseInt(process.argv[2]) || 18080;
const REMOTE_URL = process.argv[3] || 'https://frp-sea.com:52695';

const remote = new URL(REMOTE_URL);
const isRemoteHttps = remote.protocol === 'https:';
const remoteRequest = isRemoteHttps ? https.request : http.request;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function forwardRequest(req, res, body) {
  const targetUrl = `${REMOTE_URL}${req.url}`;
  const parsed = new URL(targetUrl);

  const opts = {
    hostname: parsed.hostname,
    port: parsed.port || (isRemoteHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: parsed.host,
    },
  };

  // If we buffered a body, update content-length
  if (body) {
    opts.headers['content-length'] = Buffer.byteLength(body);
  }

  if (isRemoteHttps) {
    opts.rejectUnauthorized = false;
  }

  const proxyReq = remoteRequest(opts, (proxyRes) => {
    // Strip upstream CORS headers to avoid duplicates
    const headers = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!k.toLowerCase().startsWith('access-control-')) headers[k] = v;
    }
    Object.assign(headers, CORS_HEADERS);
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[PROXY ERROR] ${req.method} ${req.url} -> ${err.message}`);
    res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
  });

  if (body) {
    proxyReq.end(body);
  } else {
    req.pipe(proxyReq);
  }
}

const server = http.createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // For chat completions, intercept and inject chat_template_kwargs
  if (req.method === 'POST' && req.url.includes('/v1/chat/completions')) {
    let chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const json = JSON.parse(raw);
        if (!json.chat_template_kwargs) {
          json.chat_template_kwargs = { enable_thinking: false };
        }
        const modified = JSON.stringify(json);
        console.log(`[Proxy] Injected chat_template_kwargs for ${req.url}`);
        forwardRequest(req, res, modified);
      } catch (e) {
        // If JSON parse fails, forward as-is
        forwardRequest(req, res, Buffer.concat(chunks));
      }
    });
  } else {
    forwardRequest(req, res, null);
  }
});

server.listen(LOCAL_PORT, '127.0.0.1', () => {
  console.log(`[Proxy] Listening on http://127.0.0.1:${LOCAL_PORT}`);
  console.log(`[Proxy] Forwarding to ${REMOTE_URL} (${isRemoteHttps ? 'HTTPS' : 'HTTP'})`);
  console.log(`[Proxy] Auto-injecting chat_template_kwargs for Qwen3`);
  console.log(`[Proxy] Ctrl+C to stop`);
});
