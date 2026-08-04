/**
 * 个人跨市场资产工作台 - 全量数据刷新脚本 v3.0
 * API 凭据通过环境变量注入
 * 拉取：美股/A股/指数/汇率 + 币安 + BIT账户 + 支付宝基金
 * 生成 assets/live-data.json
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
// WESTOCK_CLI 可来自 .env。Windows 绝对路径不能再经 path.resolve 重写，
// 否则 D:/... 会被错误解释为相对目录，导致行情源静默失效。
const configuredWestockCli = process.env.WESTOCK_CLI;
const WESTOCK_CLI = configuredWestockCli
  ? (path.isAbsolute(configuredWestockCli) ? configuredWestockCli : path.resolve(PROJECT_ROOT, configuredWestockCli))
  : path.join(PROJECT_ROOT, 'node_modules', 'westock-data', 'scripts', 'index.js');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'assets', 'live-data.json');
const ALIPAY_LIVE_FILE = path.join(PROJECT_ROOT, 'data', 'alipay-funds-live.json');

function loadEnvFile() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvFile();

function hasCredentials(prefix) {
  return Boolean(process.env[`${prefix}_API_KEY`] && process.env[`${prefix}_SECRET_KEY`]);
}

function hasBitCredentials() {
  return Boolean(process.env.BIT_ACCESS_KEY && process.env.BIT_SECRET_KEY);
}

// 清除残留的旧环境变量，防止覆盖 keys.json
function cleanEnv() {
  // 子进程必须保留托管平台注入的凭据。keys.json 已被 .gitignore 排除，
  // 因此无需再清除环境变量；清除会导致云端账户数据始终为空。
  return { ...process.env };
}

// ===== 行情数据 =====
// 优先使用可选的 westock CLI；云端没有该本机路径时，回退到腾讯公开行情接口。
function westock(args) {
  if (!fs.existsSync(WESTOCK_CLI)) return null;
  const cmd = `"${NODE}" "${WESTOCK_CLI}" ${args}`;
  try {
    const raw = execSync(cmd, { timeout: 20000, encoding: 'utf-8', cwd: PROJECT_ROOT });
    return JSON.parse(raw);
  } catch (e) {
    console.error(`  ⚠️ westock 失败: ${args.slice(0,40)}... → ${e.message.slice(0,60)}`);
    return null;
  }
}

function fetchTencentQuotes(codes) {
  return new Promise((resolve, reject) => {
    const request = https.get(`https://qt.gtimg.cn/q=${codes.join(',')}`, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        const quotes = {};
        for (const rawLine of body.split(';')) {
          const line = rawLine.trim();
          const match = line.match(/^v_([^=]+)=\"([^\"]*)\"$/);
          if (!match || !match[2]) continue;
          const fields = match[2].split('~');
          const code = match[1];
          quotes[code] = {
            code,
            name: fields[1] || code,
            price: parseFloat(fields[3]) || 0,
            previousClose: parseFloat(fields[4]) || 0,
            changePercent: parseFloat(fields[32]) || 0,
            time: fields[30] || new Date().toISOString()
          };
        }
        resolve(quotes);
      });
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('腾讯行情请求超时')); });
  });
}

async function getQuotes(codes) {
  const result = {};
  const missing = [];
  for (const code of codes) {
    const data = westock(`quote ${code} --raw`);
    const item = Array.isArray(data) ? data[0] : (data?.data?.[0] || null);
    if (item && parseFloat(item.price) > 0) {
      result[code] = {
        code,
        name: item.name || code,
        price: parseFloat(item.price) || 0,
        previousClose: parseFloat(item.previous_close) || 0,
        changePercent: parseFloat(item.change_percent) || 0,
        time: item.time || new Date().toISOString()
      };
    } else {
      missing.push(code);
    }
  }
  if (missing.length) {
    try { Object.assign(result, await fetchTencentQuotes(missing)); }
    catch (e) { console.error(`  ⚠️ 腾讯行情回退失败: ${e.message}`); }
  }
  return result;
}

function findQuote(data, code) {
  if (!data || !data.data) return null;
  for (const item of data.data) {
    if (item.code === code) return item;
    if (item.data && item.data.code === code) return item.data;
    if (item.symbol === code) return item.data || item;
  }
  return null;
}

// ===== 币安 API =====
function pullBinance() {
  console.log('\n[7/9] 拉取币安资产...');
  try {
    const raw = execSync(
      `"${NODE}" "${path.join(__dirname, 'binance-api.js')}"`,
      { timeout: 30000, encoding: 'utf-8', cwd: PROJECT_ROOT, env: cleanEnv() }
    );
    // 从 stdout 最后提取 JSON
    const match = raw.match(/\n(\{[\s\S]*\})\s*$/);
    if (!match) { console.log('  ⚠️ 币安 JSON 解析失败'); return null; }
    const data = JSON.parse(match[1]);
    const tv = data.summary?.totalValueUSDT || 0;
    const pc = data.summary?.positionCount || 0;
    console.log(`  ✅ 币安 → $${tv}, ${pc} 持仓`);
    return {
      fetchedAt: data.fetchedAt || new Date().toISOString(),
      totalValueUSDT: tv,
      positions: (data.summary?.positions || []).map(p => ({
        asset: p.asset,
        free: p.free,
        locked: p.locked,
        total: p.total,
        priceUSDT: p.priceUSDT,
        valueUSDT: p.valueUSDT
      })),
      openOrders: (data.openOrders || []).length,
      dataSource: '币安 API (只读)'
    };
  } catch (e) {
    console.log(`  ⚠️ 币安拉取失败: ${e.message.slice(0, 80)}`);
    return null;
  }
}

// ===== BIT API =====
function pullBit() {
  console.log('[1/8] 拉取 BIT 账户数据...');
  try {
    const raw = execSync(
      `"${NODE}" "${path.join(__dirname, 'bit-api.js')}"`,
      { timeout: 30000, encoding: 'utf-8', cwd: PROJECT_ROOT, env: cleanEnv() }
    );
    const match = raw.match(/\n(\{[\s\S]*\})\s*$/);
    if (!match) { console.log('  ⚠️ BIT JSON 解析失败'); return null; }
    const data = JSON.parse(match[1]);
    const cash = data.stockBalance?.total_cash !== undefined
      ? parseFloat(data.stockBalance.total_cash)
      : null;

    // 解析真实持仓：BIT positions 可能是对象 {AAPL: {...}, TSLA: {...}}
    let realPositions = [];
    if (data.positions && typeof data.positions === 'object' && !Array.isArray(data.positions)) {
      realPositions = Object.values(data.positions).filter(p => p && p.ticker);
    } else if (Array.isArray(data.positions)) {
      realPositions = data.positions.filter(p => p && p.ticker);
    }

    const posCount = realPositions.length;
    const ordersCount = Array.isArray(data.openOrders) ? data.openOrders.length : 0;
    const errors = data.errors || [];

    console.log(`  ✅ BIT → 现金$${cash != null ? cash : '?'}, ${posCount}持仓, ${ordersCount}挂单`);
    if (posCount > 0) {
      realPositions.forEach(p => {
        console.log(`     ${p.ticker}: ${p.quantity || p.shares || '?'}股, 成本$${p.avg_cost || p.costPriceUSD || '?'}`);
      });
    }

    return {
      fetchedAt: data.fetchedAt || new Date().toISOString(),
      cashUSD: cash,
      positionCount: posCount,
      openOrdersCount: ordersCount,
      realPositions: realPositions,
      errors: errors,
      dataSource: 'BIT API (只读)'
    };
  } catch (e) {
    console.log(`  ⚠️ BIT 拉取失败: ${e.message.slice(0, 80)}`);
    return null;
  }
}

// ===== 主流程 =====
async function main() {
  console.log('═══════════════════════════════════');
  console.log('  跨市场资产工作台 - 数据刷新 v4.0');
  console.log('═══════════════════════════════════');
  console.log(`时间: ${new Date().toLocaleString('zh-CN')}\n`);

  // 0. API 凭据由环境变量提供，缺失的服务将被跳过
  if (hasBitCredentials() || hasCredentials('BINANCE')) {
    console.log('[0/9] 已检测到 API 环境变量');
  } else {
    console.log('[0/9] 未检测到交易所 API 环境变量，跳过账户数据拉取');
  }

  // 1. BIT 账户（最优先——用真实持仓决定后续拉哪些行情）
  let bitAccount = null;
  let realBitPositions = [];
  let realBitCashUSD = null;
  bitAccount = pullBit();
  if (bitAccount && bitAccount.realPositions) {
    realBitPositions = bitAccount.realPositions;
    realBitCashUSD = bitAccount.cashUSD;
  }

  // 2. 汇率
  console.log('\n[2/9] 拉取 USD/CNY 汇率...');
  const bootstrapQuotes = await getQuotes(['fxUSDCNY']);
  let usdCny = bootstrapQuotes.fxUSDCNY?.price || 7.2485;
  console.log(`  ✅ USD/CNY = ${usdCny}`);

  // 3. 美股行情（仅拉取 BIT 真实持仓的标的）
  console.log('\n[3/9] 拉取美股行情（基于 BIT 真实持仓）...');
  const bitPositions = [];

  if (realBitPositions.length === 0) {
    console.log('  ℹ️  BIT 账户无持仓，跳过美股行情拉取');
  } else {
    // 从真实持仓构建行情查询列表
    const tickerToCode = (t) => {
      const upper = t.toUpperCase();
      return `us${upper}`;
    };

    const positionCodes = realBitPositions.map(p => tickerToCode(p.ticker));
    const usQuotes = await getQuotes(positionCodes);

    for (const rp of realBitPositions) {
      const ticker = rp.ticker.toUpperCase();
      const code = tickerToCode(ticker);
      const q = usQuotes[code];
      const shares = parseFloat(rp.quantity || rp.shares || 0);
      const costPrice = parseFloat(rp.avg_cost || rp.costPriceUSD || 0);

      let cp, changePct, ds, dataTime;
      if (q && parseFloat(q.price) > 0) {
        cp = parseFloat(q.price);
        changePct = parseFloat(q.change_percent) || 0;
        ds = '腾讯自选股';
        dataTime = q.time || new Date().toISOString();
      } else {
        cp = costPrice;
        changePct = 0;
        ds = '行情未获取';
        dataTime = new Date().toISOString();
      }

      const mv = +(cp * shares).toFixed(2);
      const cv = +(costPrice * shares).toFixed(2);
      const pnl = +(mv - cv).toFixed(2);
      const pnlPct = costPrice > 0 ? +((cp - costPrice) / costPrice * 100).toFixed(2) : 0;

      bitPositions.push({
        ticker, name: rp.name || rp.ticker, shares,
        costPriceUSD: costPrice, currentPriceUSD: cp,
        changePercent: +changePct.toFixed(2), marketValueUSD: mv,
        costValueUSD: cv, unrealizedPnlUSD: pnl,
        realizedPnlUSD: 0, pnlPercent: pnlPct,
        sector: getSector(ticker), dataSource: ds,
        dataTime
      });

      const s = changePct >= 0 ? '+' : '';
      console.log(`  ${ticker.padEnd(6)} ${shares}股  @$${String(cp).padEnd(10)} ${s}${changePct.toFixed(2)}%  [${ds}]`);
    }
  }

  // 4. A股 — 当前无 A 股持仓/关注列表，跳过
  console.log('\n[4/9] A股行情...');
  console.log('  ℹ️  无 A 股关注列表，跳过');
  const cnMarket = [];

  // 5. 指数（逐个查询，批量不稳定）
  console.log('\n[5/9] 拉取指数行情（逐个）...');
  // 用户主要持有美股和QDII基金，显示美股指数
  const idxDefs = [
    { code: 'usNDX', name: '纳斯达克100' },
    { code: 'usINX', name: '标普500' },
    { code: 'usDJI', name: '道琼斯' }
  ];
  const idxData = await getQuotes(idxDefs.map(idx => idx.code));
  const indexQuotes = idxDefs.map(idx => {
    const quote = idxData[idx.code];
    const price = quote?.price || 0;
    const pct = quote?.changePercent || 0;
    const s = pct >= 0 ? '+' : '';
    console.log(`  ${idx.name.padEnd(8)} ${String(price).padEnd(12)} ${s}${pct}%`);
    return { code: idx.code, name: idx.name, price, changePct: pct };
  });
  const idxRealCount = indexQuotes.filter(i => i.price > 0).length;

  // 6. 支付宝基金
  console.log('\n[6/9] 拉取支付宝基金...');
  let alipayFunds = null;
  try {
    execSync(`"${NODE}" "${path.join(__dirname, 'alipay-funds.js')}"`, { timeout: 30000, encoding: 'utf-8' });
    if (fs.existsSync(ALIPAY_LIVE_FILE)) {
      alipayFunds = JSON.parse(fs.readFileSync(ALIPAY_LIVE_FILE, 'utf8'));
      console.log(`  ✅ 支付宝基金 → 3只, 总市值 ¥${alipayFunds.totalMarketValue}`);
    }
  } catch (e) {
    console.log(`  ⚠️ 支付宝基金拉取失败: ${e.message.slice(0, 60)}`);
  }

  // 7. 币安
  const binanceData = pullBinance();

  // 8. BIT 已在步骤1完成，这里不再重复
  // ===== 9. 组装输出 =====
  console.log('\n[9/9] 生成 live-data.json...');
  const output = {
    generatedAt: new Date().toISOString(),
    generatedAtCN: new Date().toLocaleString('zh-CN'),
    exchangeRate: {
      'USD/CNY': usdCny,
      source: '中国外汇交易中心 (via 腾讯自选股)',
      updatedAt: new Date().toISOString()
    },
    bitPositions,
    bitCashUSD: realBitCashUSD != null ? realBitCashUSD : 0,
    alipayFunds,
    cnMarket,
    indexQuotes,
    binanceAssets: binanceData || undefined,
    bitAccount: bitAccount || undefined,
    dataFreshness: {
      usStocks: bitPositions.length === 0 ? '无持仓' : `实时(${bitPositions.filter(p=>p.dataSource==='腾讯自选股').length}/${bitPositions.length}只)`,
      cnStocks: cnMarket.length === 0 ? '未配置' : `实时(${cnMarket.filter(s=>s.price>0).length}/${cnMarket.length}只)`,
      indices: idxRealCount === 4 ? '实时' : `实时(${idxRealCount}/4)`,
      forex: '实时',
      alipayFunds: alipayFunds ? `净值截至${alipayFunds.funds?.[0]?.navDate || '--'}` : '未配置',
      binance: binanceData ? `实时(${binanceData.positions.length}持仓)` : '未配置',
      bitAccount: bitAccount
        ? (bitAccount.errors && bitAccount.errors.length > 0 ? 'API认证失败' : '实时(API联通)')
        : '未配置'
    },
    disclaimer: '以上数据来源于腾讯自选股(westock-data)、币安API、BIT API、天天基金，仅供参考。投资有风险，决策需谨慎。'
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n✅ 数据已写入 ${OUTPUT_FILE}`);
  console.log(`   文件: ${(fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1)} KB`);
  console.log(`   状态: ${JSON.stringify(output.dataFreshness)}`);
}

function getSector(ticker) {
  const map = { AAPL: '科技', MSFT: '科技', GOOGL: '科技', META: '科技', NVDA: '半导体', TSLA: '汽车', AMZN: '电商' };
  return map[ticker] || '其他';
}

if (require.main === module) {
  main().catch(err => { console.error('\n❌ 刷新失败:', err.message); process.exit(1); });
}

module.exports = { main };
