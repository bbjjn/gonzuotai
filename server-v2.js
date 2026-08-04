/**
 * 个人跨市场资产工作台 - 后端服务 v2
 * 提供 /api/live-data 和 /api/refresh 接口
 * 定时自动刷新（每15分钟）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const PORT = process.env.PORT || 3458;

// 加载 .env
function loadEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    const envContent = fs.readFileSync(envPath, 'utf8').replace(/\r/g, '');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    });
  } catch (e) { console.log('.env load error:', e.message); }
}
loadEnv();

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ===== 内存缓存 =====
let cachedData = null;
let lastRefreshTime = null;
let refreshRunning = false;
const DATA_FILE = path.join(ROOT, 'assets', 'live-data.json');

function loadDataFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    cachedData = JSON.parse(raw);
    return cachedData;
  } catch (e) {
    console.error('[Data] 读取失败:', e.message);
    return null;
  }
}

function runRefresh() {
  return new Promise((resolve, reject) => {
    const script = path.join(ROOT, 'scripts', 'refresh-data.js');
    if (!fs.existsSync(script)) {
      return reject(new Error('refresh-data.js 不存在'));
    }
    try {
      const stdout = execSync(`"${process.execPath}" "${script}"`, {
        timeout: 120000,
        encoding: 'utf-8',
        cwd: ROOT,
        env: process.env
      });
      const data = loadDataFile();
      // 写入时间只是辅助信息；没有有效数据版本的刷新不能被标记为成功。
      if (!data?.generatedAt) throw new Error('刷新未生成有效数据版本');
      console.log('[Refresh] 成功，版本:', data.generatedAt);
      resolve({ stdout, data });
    } catch (e) {
      reject(e);
    }
  });
}

function jsonResponse(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // 行情接口必须禁止浏览器、CDN 和中间代理复用旧响应。
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control'
  });
  res.end(JSON.stringify(obj));
}

// ===== HTTP 服务器 =====
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // API: 获取当前数据
  if (url === '/api/live-data' && req.method === 'GET') {
    const data = cachedData || loadDataFile();
    if (!data) {
      return jsonResponse(res, 503, { ok: false, error: '数据尚未就绪，请先刷新' });
    }
    return jsonResponse(res, 200, {
      ok: true,
      data,
      // 由 generatedAt 作为端到端版本号，前端仅在版本变化时标记数据更新。
      dataVersion: data.generatedAt,
      cached: !!cachedData,
      refreshedAt: lastRefreshTime || data.generatedAt
    });
  }

  // API: 触发刷新
  if (url === '/api/refresh' && req.method === 'POST') {
    if (refreshRunning) {
      return jsonResponse(res, 409, { ok: false, error: '刷新正在进行中，请稍候' });
    }
    refreshRunning = true;
    runRefresh()
      .then(({ data }) => {
        lastRefreshTime = data.generatedAt;
        refreshRunning = false;
        jsonResponse(res, 200, { ok: true, data, dataVersion: data.generatedAt, refreshedAt: lastRefreshTime });
      })
      .catch((e) => {
        refreshRunning = false;
        console.error('[Refresh Error]', e.message);
        jsonResponse(res, 500, { ok: false, error: e.message.slice(0, 300) });
      });
    return;
  }

  // API: 服务状态
  if (url === '/api/status' && req.method === 'GET') {
    const data = cachedData || loadDataFile();
    return jsonResponse(res, 200, {
      ok: true,
      hasData: !!data,
      dataVersion: data?.generatedAt || null,
      lastRefresh: lastRefreshTime,
      refreshing: refreshRunning,
      dataAge: data ? Date.now() - new Date(data.generatedAt).getTime() : null
    });
  }

  // 静态文件
  let filePath = url === '/' ? '/index.html' : url;
  filePath = path.resolve(ROOT, '.' + filePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end(); return;
  }
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ===== 定时自动刷新（每15分钟） =====
setInterval(() => {
  if (refreshRunning) return;
  refreshRunning = true;
  console.log('[Auto Refresh] 开始定时刷新...');
    runRefresh()
    .then(({ data }) => {
      lastRefreshTime = data.generatedAt;
      console.log('[Auto Refresh] 完成，数据版本', lastRefreshTime);
    })
    .catch((e) => console.error('[Auto Refresh] 失败:', e.message))
    .finally(() => { refreshRunning = false; });
}, 15 * 60 * 1000);

// 启动时加载数据
loadDataFile();
if (cachedData) {
  lastRefreshTime = cachedData.generatedAt;
  console.log('[Startup] 已加载缓存数据:', cachedData.generatedAtCN || cachedData.generatedAt);
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('API endpoints:');
  console.log('  GET  /api/live-data  - 获取当前数据');
  console.log('  POST /api/refresh    - 触发数据刷新');
  console.log('  GET  /api/status     - 服务状态');
  // 启动后立即生成首个数据版本，避免云端部署后等待15分钟才有可用数据。
  if (!cachedData && !refreshRunning) {
    refreshRunning = true;
    runRefresh()
      .then(({ data }) => { lastRefreshTime = data.generatedAt; console.log('[Startup Refresh] 完成', data.generatedAt); })
      .catch(e => console.error('[Startup Refresh] 失败:', e.message))
      .finally(() => { refreshRunning = false; });
  }
});
