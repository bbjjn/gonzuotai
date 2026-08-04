/**
 * 币安(Binance) 只读 API 接入 v2.0
 * 拉取：现货账户余额、持仓、挂单
 * 三重密钥源：ENV > keys.json > 报错
 */
const crypto = require('crypto');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

// ── 密钥 ──
function loadKeys() {
  try {
    const kp = path.join(__dirname, '..', 'data', 'keys.json');
    if (fs.existsSync(kp)) {
      return JSON.parse(fs.readFileSync(kp, 'utf8')).binance || {};
    }
  } catch (_) {}
  return {};
}
const keysFile = loadKeys();
const API_KEY = process.env.BINANCE_API_KEY || keysFile.apiKey || '';
const SECRET_KEY = process.env.BINANCE_SECRET_KEY || keysFile.secretKey || '';

if (!API_KEY || !SECRET_KEY) {
  console.error('缺少币安 API 凭据');
  process.exit(1);
}

// ── 代理 ──
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const AGENT = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

// ── 签名（与 curl / 裸测成功版本完全一致） ──
function signBinance(params) {
  // 按 key 排序
  const sorted = {};
  Object.keys(params).filter(k => params[k] != null).sort().forEach(k => { sorted[k] = params[k]; });
  const qs = new URLSearchParams(sorted).toString();
  return { qs, sig: crypto.createHmac('sha256', SECRET_KEY).update(qs, 'utf8').digest('hex') };
}

// ── HTTP 请求 ──
function apiGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://${hostname}${path}`, { agent: AGENT, timeout: 15000, headers }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch (e) { reject(new Error(`JSON: ${d.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── 主流程 ──
async function main() {
  const fetchedAt = new Date().toISOString();
  console.log(`[币安 API] ${fetchedAt} 开始拉取`);
  const errors = [];

  // 1. 同步服务器时间
  let serverTimeOffset = 0;
  try {
    const { data } = await apiGet('api.binance.com', '/api/v3/time');
    serverTimeOffset = data.serverTime - Date.now();
    console.log(`  📡 时间偏移: ${serverTimeOffset}ms`);
  } catch (e) {
    errors.push(`timeSync: ${e.message}`);
    console.log(`  ❌ timeSync: ${e.message}`);
  }

  function serverNow() { return Date.now() + serverTimeOffset; }

  // 2. 现货账户
  let account = null;
  try {
    const ts = serverNow();
    const { qs, sig } = signBinance({ timestamp: ts, recvWindow: 15000 });
    const { data } = await apiGet('api.binance.com', `/api/v3/account?${qs}&signature=${sig}`, { 'X-MBX-APIKEY': API_KEY });
    if (data.code) {
      errors.push(`account: ${data.code} ${data.msg}`);
      console.log(`  ❌ account: ${data.code} ${data.msg}`);
    } else if (data.balances) {
      const nonZero = data.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
      account = { canTrade: data.canTrade, balances: nonZero, totalBalances: data.balances.length, nonZeroCount: nonZero.length };
      console.log(`  ✅ account → ${nonZero.length}/${data.balances.length} 非零资产`);
    }
  } catch (e) {
    errors.push(`account: ${e.message}`);
    console.log(`  ❌ account: ${e.message}`);
  }

  // 3. 挂单
  let openOrders = [];
  try {
    const ts = serverNow();
    const { qs, sig } = signBinance({ timestamp: ts, recvWindow: 15000 });
    const { data } = await apiGet('api.binance.com', `/api/v3/openOrders?${qs}&signature=${sig}`, { 'X-MBX-APIKEY': API_KEY });
    if (data.code) {
      errors.push(`openOrders: ${data.code} ${data.msg}`);
      console.log(`  ❌ openOrders: ${data.code} ${data.msg}`);
    } else {
      openOrders = Array.isArray(data) ? data : [];
      console.log(`  ✅ openOrders → ${openOrders.length} 个挂单`);
    }
  } catch (e) {
    errors.push(`openOrders: ${e.message}`);
    console.log(`  ❌ openOrders: ${e.message}`);
  }

  // 4. 价格
  let prices = {};
  if (account && account.balances) {
    const assets = account.balances;
    const symbols = assets.filter(b => b.asset !== 'USDT' && b.asset !== 'BUSD' && b.asset !== 'USDC')
      .map(b => `${b.asset}USDT`);
    if (symbols.length > 0) {
      try {
        const { data } = await apiGet('api.binance.com', '/api/v3/ticker/price');
        if (Array.isArray(data)) {
          data.forEach(t => { prices[t.symbol] = parseFloat(t.price); });
        }
        console.log(`  ✅ prices → ${Object.keys(prices).length} 个交易对`);
      } catch (e) {
        console.log(`  ⚠️  prices: ${e.message}`);
      }
    }
  }

  // 5. 汇总
  let summary = { totalValueUSDT: 0, positionCount: 0, positions: [] };
  if (account && account.balances) {
    let totalUSDT = 0;
    const positions = [];
    account.balances.forEach(b => {
      const free = parseFloat(b.free), locked = parseFloat(b.locked), total = free + locked;
      const priceUSDT = (b.asset === 'USDT' || b.asset === 'BUSD' || b.asset === 'USDC') ? 1 : (prices[`${b.asset}USDT`] || 0);
      const valueUSDT = total * priceUSDT;
      totalUSDT += valueUSDT;
      if (total > 0) positions.push({ asset: b.asset, free, locked, total, priceUSDT, valueUSDT: +valueUSDT.toFixed(2) });
    });
    summary = { totalValueUSDT: +totalUSDT.toFixed(2), positionCount: positions.length, positions: positions.sort((a, b) => b.valueUSDT - a.valueUSDT) };
    console.log(`  💰 总估值: $${summary.totalValueUSDT.toLocaleString()} (${positions.length} 持仓)`);
  }

  // 6. 输出
  const successCount = (account ? 1 : 0) + (openOrders ? 1 : 0);
  console.log(`[币安 API] ${successCount}/2 接口成功, ${errors.length} 错误`);

  const result = {
    fetchedAt, errors, serverTimeOffset,
    account, openOrders, prices, summary
  };

  // 最终输出（供 refresh-data.js 解析）
  console.log('\n' + JSON.stringify(result, null, 2));
  return result;
}

main().catch(err => {
  console.error('致命错误:', err.message);
  process.exit(1);
});
