const FUND_CONFIG = [
  { code: "270042", name: "广发纳斯达克100ETF联接人民币(QDII)A", shortName: "广发纳斯达克100", dailyAmount: 5, shares: 0.6411, costPerShare: 7.7989, currency: "CNY", category: "QDII-股票指数" },
  { code: "040046", name: "华安纳斯达克100ETF联接(QDII)A", shortName: "华安纳斯达克100", dailyAmount: 10, shares: 1.2736, costPerShare: 7.8518, currency: "CNY", category: "QDII-股票指数" },
  { code: "019174", name: "摩根纳斯达克100指数(QDII)美元现汇A", shortName: "摩根纳斯达克100", dailyAmount: 10, shares: 5.666, costPerShare: 1.7649, currency: "CNY", category: "QDII-股票指数" }
];

const CACHE_KEY = "live-data-v1";
const DATA_TTL_SECONDS = 14 * 60;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "pragma": "no-cache",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Cache-Control"
    }
  });
}

function daysSince(snapshotDate) {
  const start = new Date(`${snapshotDate}T00:00:00+08:00`);
  const now = new Date();
  return Math.max(0, Math.floor((now.getTime() - start.getTime()) / 86400000));
}

function parseTencentQuotes(text) {
  const output = {};
  for (const rawLine of text.split(";")) {
    const line = rawLine.trim();
    const match = line.match(/^v_([^=]+)=\"([^\"]*)\"$/);
    if (!match || !match[2]) continue;
    const fields = match[2].split("~");
    output[match[1]] = {
      code: match[1],
      name: fields[1] || match[1],
      price: Number(fields[3]) || 0,
      previousClose: Number(fields[4]) || 0,
      changePercent: Number(fields[32]) || 0,
      time: fields[30] || new Date().toISOString()
    };
  }
  return output;
}

async function getTencentQuotes(codes) {
  const response = await fetch(`https://qt.gtimg.cn/q=${codes.join(",")}`, {
    headers: { "user-agent": "Mozilla/5.0" }, cf: { cacheTtl: 30 }
  });
  if (!response.ok) throw new Error(`腾讯行情 HTTP ${response.status}`);
  return parseTencentQuotes(await response.text());
}

async function getFunds(snapshotDate) {
  const response = await fetch("https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=gonzuotai&Fcodes=" + FUND_CONFIG.map(f => f.code).join(","));
  if (!response.ok) throw new Error(`基金行情 HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload.Success || !Array.isArray(payload.Datas)) throw new Error("基金行情返回异常");
  const source = Object.fromEntries(payload.Datas.map(item => [item.FCODE, item]));
  const daysOfDCA = daysSince(snapshotDate);
  const funds = [];
  let totalMarketValue = 0;
  let totalInvested = 0;
  let totalUnrealizedPnl = 0;
  for (const fund of FUND_CONFIG) {
    const quote = source[fund.code];
    if (!quote) continue;
    const nav = Number(quote.NAV) || 0;
    if (!nav) continue;
    const additionalInvested = daysOfDCA * fund.dailyAmount;
    const shares = fund.shares + additionalInvested / nav;
    const invested = fund.shares * fund.costPerShare + additionalInvested;
    const marketValue = shares * nav;
    const unrealizedPnl = marketValue - invested;
    const row = {
      ...fund,
      shares: Number(shares.toFixed(4)), nav, navDate: quote.PDATE,
      navChangePercent: Number(quote.NAVCHGRT || 0), daysOfDCA,
      totalInvested: Number(invested.toFixed(2)), marketValue: Number(marketValue.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      pnlPercent: invested ? Number((unrealizedPnl / invested * 100).toFixed(2)) : 0,
      dataSource: "天天基金", updatedAt: new Date().toISOString()
    };
    funds.push(row);
    totalMarketValue += marketValue;
    totalInvested += invested;
    totalUnrealizedPnl += unrealizedPnl;
  }
  return {
    fetchedAt: new Date().toISOString(), snapshotDate, today: new Date().toLocaleDateString("sv-SE"), daysOfDCA,
    totalMarketValue: Number(totalMarketValue.toFixed(2)), totalInvested: Number(totalInvested.toFixed(2)),
    totalUnrealizedPnl: Number(totalUnrealizedPnl.toFixed(2)),
    totalPnlPercent: totalInvested ? Number((totalUnrealizedPnl / totalInvested * 100).toFixed(2)) : 0,
    funds, disclaimer: "定投按自然日近似计算，实际以支付宝确认份额为准"
  };
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map(item => item.toString(16).padStart(2, "0")).join("");
}

async function getBinance(env) {
  if (!env.BINANCE_API_KEY || !env.BINANCE_SECRET_KEY) return null;
  const timestamp = Date.now();
  const query = new URLSearchParams({ timestamp: String(timestamp), recvWindow: "15000" }).toString();
  const signature = await hmac(env.BINANCE_SECRET_KEY, query);
  const response = await fetch(`https://api.binance.com/api/v3/account?${query}&signature=${signature}`, { headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY } });
  if (!response.ok) throw new Error(`币安账户 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.code) throw new Error(payload.msg || "币安账户错误");
  const balances = payload.balances.filter(item => Number(item.free) > 0 || Number(item.locked) > 0);
  const positions = [];
  for (const item of balances) {
    const total = Number(item.free) + Number(item.locked);
    const priceUSDT = ["USDT", "USDC", "BUSD"].includes(item.asset) ? 1 : 0;
    positions.push({ asset: item.asset, free: Number(item.free), locked: Number(item.locked), total, priceUSDT, valueUSDT: Number((total * priceUSDT).toFixed(2)) });
  }
  return { fetchedAt: new Date().toISOString(), totalValueUSDT: Number(positions.reduce((sum, item) => sum + item.valueUSDT, 0).toFixed(2)), positions, openOrders: 0, dataSource: "币安 API (只读)" };
}

async function refreshData(env) {
  const now = new Date();
  const [quotes, alipayFunds, binanceResult] = await Promise.all([
    getTencentQuotes(["fxUSDCNY", "usNDX", "usINX", "usDJI"]),
    getFunds(env.FUND_SNAPSHOT_DATE || "2026-08-03"),
    getBinance(env).catch(() => null)
  ]);
  const rate = quotes.fxUSDCNY?.price || 7.2485;
  const indexQuotes = [
    { code: "usNDX", name: "纳斯达克100" }, { code: "usINX", name: "标普500" }, { code: "usDJI", name: "道琼斯" }
  ].map(item => ({ ...item, price: quotes[item.code]?.price || 0, changePct: quotes[item.code]?.changePercent || 0 }));
  return {
    generatedAt: now.toISOString(), generatedAtCN: now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    exchangeRate: { "USD/CNY": rate, source: "腾讯自选股", updatedAt: now.toISOString() },
    bitPositions: [], bitCashUSD: 0, alipayFunds, cnMarket: [], indexQuotes,
    binanceAssets: binanceResult || { fetchedAt: now.toISOString(), totalValueUSDT: 0, positions: [], openOrders: 0, dataSource: "币安未配置" },
    bitAccount: { fetchedAt: now.toISOString(), cashUSD: 0, positionCount: 0, openOrdersCount: 0, realPositions: [], dataSource: env.BIT_ACCESS_KEY ? "BIT Worker 适配待启用" : "BIT 未配置" },
    dataFreshness: {
      usStocks: "无持仓", cnStocks: "未配置", indices: `实时(${indexQuotes.filter(item => item.price > 0).length}/3)`, forex: "实时",
      alipayFunds: `净值截至${alipayFunds.funds[0]?.navDate || "--"}`,
      binance: binanceResult ? `实时(${binanceResult.positions.length}持仓)` : "未配置",
      bitAccount: env.BIT_ACCESS_KEY ? "待配置 Cloudflare 出口 IP 白名单" : "未配置"
    },
    disclaimer: "数据来源：腾讯自选股、天天基金、币安 API，仅供参考。投资有风险，决策需谨慎。"
  };
}

async function readData(env) {
  const cache = await caches.open("gonzuotai-data");
  const cached = await cache.match("https://gonzuotai.internal/live-data");
  if (cached) return await cached.json();
  const fresh = await refreshData(env);
  await cache.put("https://gonzuotai.internal/live-data", new Response(JSON.stringify(fresh), { headers: { "cache-control": `max-age=${DATA_TTL_SECONDS}` } }));
  return fresh;
}

async function refreshAndCache(env) {
  const data = await refreshData(env);
  const cache = await caches.open("gonzuotai-data");
  await cache.put("https://gonzuotai.internal/live-data", new Response(JSON.stringify(data), { headers: { "cache-control": `max-age=${DATA_TTL_SECONDS}` } }));
  return data;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({}, 204);
    const url = new URL(request.url);
    if (url.pathname === "/api/status") {
      const data = await readData(env);
      return json({ ok: true, hasData: true, dataVersion: data.generatedAt, lastRefresh: data.generatedAt, refreshing: false, dataAge: Date.now() - new Date(data.generatedAt).getTime() });
    }
    if (url.pathname === "/api/live-data") {
      const data = await readData(env);
      return json({ ok: true, data, dataVersion: data.generatedAt, refreshedAt: data.generatedAt });
    }
    if (url.pathname === "/api/refresh" && request.method === "POST") {
      try {
        const data = await refreshAndCache(env);
        return json({ ok: true, data, dataVersion: data.generatedAt, refreshedAt: data.generatedAt });
      } catch (error) { return json({ ok: false, error: error.message }, 502); }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshAndCache(env));
  }
};
