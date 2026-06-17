// ===== Rift of Fate - Cloudflare Worker =====
// API Proxy + Leaderboard + Achievements + Save/Load
// Deploy: wrangler deploy

// Rate limiting: max requests per IP per minute
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW = 60; // seconds

// DeepSeek API
const AI_URL = 'https://api.deepseek.com/chat/completions';
const AI_MODEL = 'deepseek-v4-flash';
const AI_TEMP = 0.85;
const AI_MAX_TOKENS = 2000;

// Achievement definitions
const ACHIEVEMENTS = {
  first_blood: { name: '初战告捷', desc: '击败第一个敌人', icon: '⚔️' },
  kills_10: { name: '十杀勇者', desc: '累计击杀10个敌人', icon: '💀' },
  kills_50: { name: '半百屠夫', desc: '累计击杀50个敌人', icon: '☠️' },
  kills_100: { name: '百杀传说', desc: '累计击杀100个敌人', icon: '🏆' },
  boss_hunter: { name: '猎龙者', desc: '击败第一个BOSS', icon: '🐉' },
  boss_hunter_5: { name: '龙王克星', desc: '击败5个BOSS', icon: '👑' },
  level_10: { name: '初窥门径', desc: '达到10级', icon: '📈' },
  level_30: { name: '炉火纯青', desc: '达到30级', icon: '🔥' },
  level_50: { name: '登峰造极', desc: '达到50级', icon: '⭐' },
  level_100: { name: '超凡入圣', desc: '达到100级', icon: '✨' },
  breakthrough_1: { name: '破境初成', desc: '完成第一次突破', icon: '⚡' },
  breakthrough_5: { name: '五重天劫', desc: '完成5次突破', icon: '🌩️' },
  gold_1000: { name: '小富即安', desc: '累计获得1000金币', icon: '💰' },
  gold_5000: { name: '富甲一方', desc: '累计获得5000金币', icon: '🏦' },
  survive_12: { name: '一岁轮回', desc: '存活12个月(1年)', icon: '📅' },
  survive_60: { name: '五载春秋', desc: '存活60个月(5年)', icon: '🗓️' },
  legendary_challenge: { name: '传说挑战者', desc: '完成挑战级突破', icon: '🔴' },
  npc_victor: { name: '江湖扬名', desc: '击败5个NPC', icon: '🥋' },
  explorer: { name: '世界探索者', desc: '探索10个不同地点', icon: '🗺️' },
  lucky_star: { name: '幸运之星', desc: '幸运值达到25', icon: '🍀' },
  hell_clear: { name: '地狱行者', desc: '在地狱难度存活超过6个月', icon: '💀' }
};

// CORS headers
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function error(msg, status = 400) {
  return json({ error: msg }, status);
}

// ===== Main Router =====
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Health check
      if (path === '/' || path === '/health') {
        return json({ status: 'ok', game: '命运裂隙', version: '2.0', features: ['ai_proxy', 'leaderboard', 'achievements', 'save'] });
      }

      // AI Proxy
      if (path === '/api/ai' && request.method === 'POST') {
        return await handleAI(request, env);
      }

      // AI Direct — forward to Qwen 3.6 (llama.cpp)
      if (path === '/api/direct' && request.method === 'POST') {
        return await handleAIDirect(request, env);
      }

      // Leaderboard
      if (path === '/api/leaderboard' && request.method === 'POST') {
        return await submitScore(request, env);
      }
      if (path === '/api/leaderboard' && request.method === 'GET') {
        return await getLeaderboard(request, env);
      }

      // Save / Load
      if (path === '/api/save' && request.method === 'POST') {
        return await saveGame(request, env);
      }
      if (path === '/api/load' && request.method === 'POST') {
        return await loadGame(request, env);
      }

      // Achievements
      if (path === '/api/achievements' && request.method === 'POST') {
        return await handleAchievements(request, env);
      }

      return error('Not Found', 404);
    } catch (e) {
      console.error('[Worker]', e.message);
      return error('Internal Error', 500);
    }
  }
};

// ===== Rate Limiting =====
async function checkRateLimit(env, ip) {
  const key = 'rl:' + ip;
  const now = Math.floor(Date.now() / 1000);
  let data = await env.RIFT_KV.get(key, 'json');

  if (!data || data.window !== now - (now % RATE_LIMIT_WINDOW)) {
    data = { count: 1, window: now - (now % RATE_LIMIT_WINDOW) };
  } else {
    data.count++;
    if (data.count > RATE_LIMIT_MAX) return false;
  }

  await env.RIFT_KV.put(key, JSON.stringify(data), { expirationTtl: RATE_LIMIT_WINDOW + 10 });
  return true;
}

function getIP(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

// ===== AI Proxy =====
async function handleAI(request, env) {
  const ip = getIP(request);
  if (!(await checkRateLimit(env, ip))) {
    return error('请求过于频繁，请稍后再试', 429);
  }

  // Check API key is configured
  if (!env.DEEPSEEK_API_KEY) {
    return error('Server API key not configured', 500);
  }

  const body = await request.json();

  // Build proxy request to DeepSeek — map game model names to actual API names
  const MODEL_MAP = { 'deepseek': AI_MODEL, 'deepseek-chat': AI_MODEL };
  const proxyBody = {
    model: MODEL_MAP[body.model] || body.model || AI_MODEL,
    messages: body.messages,
    temperature: body.temperature ?? AI_TEMP,
    max_tokens: body.max_tokens || AI_MAX_TOKENS,
  };

  const res = await fetch(AI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.DEEPSEEK_API_KEY,
    },
    body: JSON.stringify(proxyBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[AI Proxy] DeepSeek error:', res.status, errText.substring(0, 300));
    let detail = res.status;
    try { const ej = JSON.parse(errText); if (ej.error) detail += ': ' + (ej.error.message || ej.error.type || JSON.stringify(ej.error).slice(0, 100)); } catch (_) { detail += ' ' + errText.slice(0, 120); }
    return error('DeepSeek: ' + detail, 502);
  }

  const data = await res.json();

  // Log usage (optional, for monitoring)
  const usageKey = 'usage:' + new Date().toISOString().slice(0, 10);
  const usageCount = parseInt(await env.RIFT_KV.get(usageKey) || '0');
  await env.RIFT_KV.put(usageKey, String(usageCount + 1), { expirationTtl: 86400 * 30 });

  return json(data);
}

// Qwen 3.6 llama.cpp server (via cloudflared tunnel for valid SSL)
const QWEN_URL = 'https://decided-singer-late-stopped.trycloudflare.com/v1/chat/completions';

async function handleAIDirect(request, env) {
  const ip = getIP(request);
  if (!(await checkRateLimit(env, ip))) {
    return error('请求过于频繁，请稍后再试', 429);
  }

  const body = await request.json();

  const proxyBody = {
    model: body.model || 'qwen3.6',
    messages: body.messages,
    temperature: body.temperature ?? AI_TEMP,
    max_tokens: body.max_tokens || AI_MAX_TOKENS,
    chat_template_kwargs: { enable_thinking: false },
  };

  const res = await fetch(QWEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(proxyBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[AI Direct] Qwen error:', res.status, errText.substring(0, 200));
    return error('AI service error: ' + res.status, 502);
  }

  const data = await res.json();

  const usageKey = 'usage:qwen:' + new Date().toISOString().slice(0, 10);
  const usageCount = parseInt(await env.RIFT_KV.get(usageKey) || '0');
  await env.RIFT_KV.put(usageKey, String(usageCount + 1), { expirationTtl: 86400 * 30 });

  return json(data);
}

// ===== Leaderboard =====
async function submitScore(request, env) {
  const body = await request.json();
  const { name, level, kills, months, difficulty, score, gold, breakthroughs } = body;

  if (!name || !level) return error('Missing name or level');
  if (name.length > 20) return error('Name too long');

  const entry = {
    name: name.slice(0, 20),
    level: Math.min(999, Math.max(1, level)),
    kills: Math.max(0, kills || 0),
    months: Math.max(0, months || 0),
    difficulty: difficulty || 'normal',
    score: Math.max(0, score || level * 100 + (kills || 0) * 10),
    gold: Math.max(0, gold || 0),
    breakthroughs: Math.max(0, breakthroughs || 0),
    date: new Date().toISOString().slice(0, 10),
  };

  // Read current leaderboard (top 50)
  let board = [];
  try { board = JSON.parse(await env.RIFT_KV.get('leaderboard') || '[]'); } catch (e) { }

  board.push(entry);
  board.sort((a, b) => (b.score || b.level * 100) - (a.score || a.level * 100));
  board = board.slice(0, 50);

  await env.RIFT_KV.put('leaderboard', JSON.stringify(board));

  // Find rank
  const rank = board.findIndex(e => e === entry) + 1;
  return json({ ok: true, rank, total: board.length });
}

async function getLeaderboard(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '20'));

  let board = [];
  try { board = JSON.parse(await env.RIFT_KV.get('leaderboard') || '[]'); } catch (e) { }

  return json(board.slice(0, limit));
}

// ===== Save / Load =====
async function saveGame(request, env) {
  const body = await request.json();
  const { playerId, playerName, data } = body;

  if (!data) return error('No game data');

  // Generate or use existing player ID
  const pid = playerId || 'P' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

  const saveData = {
    playerId: pid,
    playerName: (playerName || '冒险者').slice(0, 20),
    data: data,
    savedAt: new Date().toISOString(),
    version: 2,
  };

  await env.RIFT_KV.put('save:' + pid, JSON.stringify(saveData), { expirationTtl: 86400 * 90 }); // 90 days

  return json({ ok: true, playerId: pid, message: '存档成功！记住你的玩家代码: ' + pid });
}

async function loadGame(request, env) {
  const body = await request.json();
  const { playerId } = body;

  if (!playerId) return error('Missing playerId');

  const raw = await env.RIFT_KV.get('save:' + playerId);
  if (!raw) return error('未找到存档，请检查玩家代码', 404);

  try {
    return json(JSON.parse(raw));
  } catch (e) {
    return error('存档数据损坏', 500);
  }
}

// ===== Achievements =====
async function handleAchievements(request, env) {
  const body = await request.json();
  const { playerId, stats } = body;

  if (!stats) return error('Missing stats');

  const earned = [];

  // Check each achievement based on stats
  if (stats.kills >= 1) earned.push('first_blood');
  if (stats.kills >= 10) earned.push('kills_10');
  if (stats.kills >= 50) earned.push('kills_50');
  if (stats.kills >= 100) earned.push('kills_100');
  if (stats.bossKills >= 1) earned.push('boss_hunter');
  if (stats.bossKills >= 5) earned.push('boss_hunter_5');
  if (stats.level >= 10) earned.push('level_10');
  if (stats.level >= 30) earned.push('level_30');
  if (stats.level >= 50) earned.push('level_50');
  if (stats.level >= 100) earned.push('level_100');
  if (stats.breakthroughs >= 1) earned.push('breakthrough_1');
  if (stats.breakthroughs >= 5) earned.push('breakthrough_5');
  if (stats.totalGold >= 1000) earned.push('gold_1000');
  if (stats.totalGold >= 5000) earned.push('gold_5000');
  if (stats.months >= 12) earned.push('survive_12');
  if (stats.months >= 60) earned.push('survive_60');
  if (stats.legendaryChallenge) earned.push('legendary_challenge');
  if (stats.npcKills >= 5) earned.push('npc_victor');
  if (stats.regionsExplored >= 10) earned.push('explorer');
  if (stats.luck >= 25) earned.push('lucky_star');
  if (stats.hellSurvive6) earned.push('hell_clear');

  // Save to KV if playerId provided
  let newAchievements = [];
  if (playerId) {
    let existing = [];
    try { existing = JSON.parse(await env.RIFT_KV.get('ach:' + playerId) || '[]'); } catch (e) { }

    newAchievements = earned.filter(a => !existing.includes(a));
    if (newAchievements.length > 0) {
      const combined = [...new Set([...existing, ...earned])];
      await env.RIFT_KV.put('ach:' + playerId, JSON.stringify(combined), { expirationTtl: 86400 * 365 });
    }
  }

  // Build response with full achievement details
  const allAch = Object.entries(ACHIEVEMENTS).map(([id, ach]) => ({
    id, ...ach,
    earned: earned.includes(id),
    isNew: newAchievements.includes(id),
  }));

  return json({
    earned,
    newAchievements,
    all: allAch,
    total: Object.keys(ACHIEVEMENTS).length,
    unlocked: earned.length,
  });
}
