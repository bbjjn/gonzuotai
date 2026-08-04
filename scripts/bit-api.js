/**
 * BIT (Matrixport) API 客户端 v4
 * 只读数据：余额、持仓、挂单
 * 每次运行自动检测代理出口 IP，变更自动更新缓存
 * IP 检测优先 ifconfig.me → api.ipify.org → myip.ipip.net
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ===== 配置 =====
// 优先环境变量，fallback 读取 keys.json + 默认 Clash 代理
function loadKeysFromFile() {
  try {
    const kp = path.join(__dirname, '..', 'data', 'keys.json');
    if (fs.existsSync(kp)) {
      const keys = JSON.parse(fs.readFileSync(kp, 'utf8'));
      return keys.bit || {};
    }
  } catch (_) {}
  return {};
}

const keyFile = loadKeysFromFile();
const CONFIG = {
  accessKey: process.env.BIT_ACCESS_KEY || keyFile.accessKey || '',
  secretKey: process.env.BIT_SECRET_KEY || keyFile.secretKey || '',
  baseUrl: 'mapi.matrixport.com',
  proxyUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
};
const IP_CACHE_FILE = path.join(__dirname, '.bit-ip-cache');

// IP 检测服务列表（按优先级，首个成功即返回）
const IP_CHECK_SERVICES = [
  { name: 'ifconfig.me', url: 'https://ifconfig.me', parser: (body) => body.trim() },
  { name: 'api.ipify.org', url: 'https://api.ipify.org', parser: (body) => body.trim() },
  { name: 'myip.ipip.net', url: 'https://myip.ipip.net', parser: (body) => {
    const m = body.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    return m ? m[1] : 'unknown';
  }},
];

// ===== IP 检测（多服务 fallback，每次运行自动检测最新 IP） =====
function createAgent() {
  return CONFIG.proxyUrl ? new HttpsProxyAgent(CONFIG.proxyUrl) : undefined;
}

function checkIPFromService(service) {
  return new Promise((resolve, reject) => {
    const req = https.get(service.url, {
      agent: createAgent(),
      timeout: 8000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const ip = service.parser(d);
          if (ip && ip.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
            resolve(ip);
          } else {
            reject(new Error(`invalid IP from ${service.name}: ${d.substring(0,60)}`));
          }
        } catch (e) {
          reject(new Error(`parse failed from ${service.name}: ${d.substring(0,60)}`));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`${service.name}: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error(`${service.name}: timeout`)); });
  });
}

async function checkOutboundIP() {
  for (const svc of IP_CHECK_SERVICES) {
    try {
      const ip = await checkIPFromService(svc);
      return { ip, source: svc.name };
    } catch (e) {
      // 尝试下一个服务
    }
  }
  throw new Error('所有 IP 检测服务均不可达');
}

function getCachedIP() {
  try {
    if (fs.existsSync(IP_CACHE_FILE)) {
      return fs.readFileSync(IP_CACHE_FILE, 'utf8').trim();
    }
  } catch (e) { /* ignore */ }
  return null;
}

function saveCachedIP(ip) {
  try {
    fs.writeFileSync(IP_CACHE_FILE, ip, 'utf8');
  } catch (e) { /* ignore */ }
}

async function verifyAndReportIP() {
  const { ip: currentIP } = await checkOutboundIP();
  const cachedIP = getCachedIP();
  const changed = cachedIP !== null && cachedIP !== currentIP;

  if (changed) {
    console.log('  ⚠️ 代理出口地址已变更，请在 BIT 后台核对 IP 白名单。');
    saveCachedIP(currentIP);
  } else if (cachedIP) {
    console.log('  ✅ 代理出口地址状态未变化。');
  } else {
    console.log('  📌 已检测并缓存代理出口地址。');
    saveCachedIP(currentIP);
  }

  return { changed };
}

// ===== 签名 =====
function sign(timestamp, method, path, body) {
  const prehash = `${timestamp}${method.toUpperCase()}${path}&${body}`;
  return crypto.createHmac('sha256', CONFIG.secretKey).update(prehash, 'utf8').digest('hex');
}

// ===== HTTP 请求 =====
function apiRequest(method, path, queryParams, bodyObj) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const qs = queryParams
      ? '?' + Object.entries(queryParams).filter(([,v]) => v != null && v !== '').map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&')
      : '';
    const fullPath = path + qs;

    const options = {
      hostname: CONFIG.baseUrl,
      port: 443,
      path: fullPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-MatrixPort-Access-Key': CONFIG.accessKey,
        'X-Signature': sign(timestamp, method, fullPath, body),
        'X-Timestamp': String(timestamp),
        'X-Auth-Version': 'v2',
      },
      agent: createAgent(),
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse (${res.statusCode}): ${data.substring(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ===== 数据接口 =====
async function getStockBalance() {
  const r = await apiRequest('GET', '/stock/v1/balance');
  if (r.code !== 0) throw new Error(`Stock balance: ${r.message} (${r.code})`);
  return r.data;
}

async function getStockPositions() {
  const r = await apiRequest('GET', '/stock/v1/positions');
  if (r.code !== 0) throw new Error(`Positions: ${r.message} (${r.code})`);
  return r.data;
}

async function getOpenOrders() {
  const r = await apiRequest('GET', '/stock/v1/open_orders');
  if (r.code !== 0) throw new Error(`Open orders: ${r.message} (${r.code})`);
  return r.data;
}

async function getWalletBalance() {
  const r = await apiRequest('GET', '/mapi/v1/wallet/balance');
  if (r.code !== 0) throw new Error(`Wallet: ${r.message} (${r.code})`);
  return r.data;
}

// ===== 汇总 =====
async function fetchAll() {
  // 第一步：检测 IP
  await verifyAndReportIP();

  console.log(`[BIT API] ${new Date().toISOString()} 开始拉取`);

  const results = { fetchedAt: new Date().toISOString(), wallet: null, stockBalance: null, positions: null, openOrders: null, errors: [] };
  const fetchers = [
    { key: 'wallet', fn: getWalletBalance },
    { key: 'stockBalance', fn: getStockBalance },
    { key: 'positions', fn: getStockPositions },
    { key: 'openOrders', fn: getOpenOrders },
  ];

  const jobs = fetchers.map(async ({ key, fn }) => {
    try {
      results[key] = await fn();
      console.log(`  ✅ ${key}`);
    } catch (err) {
      results.errors.push(`${key}: ${err.message}`);
      console.log(`  ❌ ${key}: ${err.message}`);
    }
  });
  await Promise.all(jobs);

  const ok = fetchers.filter(f => results[f.key] !== null).length;
  console.log(`[BIT API] ${ok}/${fetchers.length} 成功, ${results.errors.length} 失败`);

  return results;
}

// ===== CLI =====
if (require.main === module) {
  if (!CONFIG.accessKey || !CONFIG.secretKey) {
    console.error('缺少 BIT API 凭据：请设置 BIT_ACCESS_KEY 和 BIT_SECRET_KEY 环境变量。');
    process.exit(1);
  }
  fetchAll().then(d => console.log('\n' + JSON.stringify(d, null, 2))).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { fetchAll, verifyAndReportIP, getWalletBalance, getStockBalance, getStockPositions, getOpenOrders };
