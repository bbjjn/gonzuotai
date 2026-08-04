/**
 * 支付宝基金自动追踪脚本
 * 基于一次性配置 + 定投计划，自动拉净值、算份额、算盈亏
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'alipay-funds.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'alipay-funds-live.json');

// 天天基金移动端批量接口（公开、稳定）
const EASTMONEY_API = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo';

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function fetchFundData(codes) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({
      plat: 'Android',
      appType: 'ttjj',
      product: 'EFund',
      Version: '1',
      deviceid: 'workbuddy',
      Fcodes: codes.join(',')
    }).toString();

    const req = https.get(`${EASTMONEY_API}?${query}`, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.Success && Array.isArray(json.Datas)) {
            resolve(json.Datas);
          } else {
            reject(new Error(json.ErrMsg || '天天基金接口返回异常'));
          }
        } catch (e) {
          reject(new Error(`解析失败: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function getBusinessDaysDiff(fromDate, toDate) {
  const start = new Date(fromDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(toDate);
  end.setHours(0, 0, 0, 0);

  if (end <= start) return 0;

  let days = 0;
  const cur = new Date(start);
  cur.setDate(cur.getDate() + 1); // 从 snapshot 次日开始算
  while (cur <= end) {
    // 简化：按自然日计算定投；QDII 实际交易日不完全一致，作为仪表盘近似足够
    days++;
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function calculateFund(fund, navInfo, daysOfDCA) {
  const nav = parseFloat(navInfo.NAV);
  const navDate = navInfo.PDATE;
  const navChange = parseFloat(navInfo.NAVCHGRT || 0);

  const baseShares = fund.shares;
  const baseCost = fund.shares * (fund.costPerShare || nav);

  // 追加定投（从 snapshot 次日到今日）
  const additionalInvested = daysOfDCA * fund.dailyAmount;
  const additionalShares = daysOfDCA > 0 ? additionalInvested / nav : 0;

  const currentShares = baseShares + additionalShares;
  const totalInvested = baseCost + additionalInvested;
  const currentValue = currentShares * nav;
  const unrealizedPnl = currentValue - totalInvested;
  const pnlPercent = totalInvested > 0 ? (unrealizedPnl / totalInvested) * 100 : 0;

  return {
    code: fund.code,
    name: fund.name,
    shortName: fund.shortName,
    shares: +currentShares.toFixed(4),
    nav: nav,
    navDate: navDate,
    navChangePercent: navChange,
    dailyAmount: fund.dailyAmount,
    daysOfDCA: daysOfDCA,
    totalInvested: +totalInvested.toFixed(2),
    marketValue: +currentValue.toFixed(2),
    unrealizedPnl: +unrealizedPnl.toFixed(2),
    pnlPercent: +pnlPercent.toFixed(2),
    currency: fund.currency,
    category: fund.category,
    dataSource: '天天基金',
    updatedAt: new Date().toISOString()
  };
}

async function main() {
  const config = readConfig();
  const today = new Date().toISOString().split('T')[0];
  const daysOfDCA = getBusinessDaysDiff(config.snapshotDate, today);

  console.log(`[支付宝基金] ${new Date().toISOString()} 开始计算...`);
  console.log(`  快照日: ${config.snapshotDate}, 今日: ${today}, 累计定投天数: ${daysOfDCA}`);

  const codes = config.funds.map(f => f.code);
  const navData = await fetchFundData(codes);
  const navMap = {};
  navData.forEach(d => { navMap[d.FCODE] = d; });

  const results = [];
  let totalValue = 0;
  let totalInvested = 0;
  let totalPnl = 0;

  config.funds.forEach(fund => {
    const navInfo = navMap[fund.code];
    if (!navInfo) {
      console.warn(`  ⚠️  未找到 ${fund.code} 净值`);
      return;
    }
    const calc = calculateFund(fund, navInfo, daysOfDCA);
    results.push(calc);
    totalValue += calc.marketValue;
    totalInvested += calc.totalInvested;
    totalPnl += calc.unrealizedPnl;
    console.log(`  ✅ ${calc.shortName}: 净值 ${calc.nav}, 市值 ¥${calc.marketValue}, 盈亏 ${calc.pnlPercent}%`);
  });

  const output = {
    fetchedAt: new Date().toISOString(),
    snapshotDate: config.snapshotDate,
    today: today,
    daysOfDCA: daysOfDCA,
    totalMarketValue: +totalValue.toFixed(2),
    totalInvested: +totalInvested.toFixed(2),
    totalUnrealizedPnl: +totalPnl.toFixed(2),
    totalPnlPercent: totalInvested > 0 ? +((totalPnl / totalInvested) * 100).toFixed(2) : 0,
    funds: results,
    disclaimer: '定投按自然日近似计算，实际以支付宝确认份额为准；红利再投已纳入份额基准'
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[支付宝基金] 总计市值 ¥${output.totalMarketValue}, 已写入 ${OUTPUT_PATH}`);

  return output;
}

module.exports = { main, readConfig };

if (require.main === module) {
  main().catch(err => {
    console.error('错误:', err.message);
    process.exit(1);
  });
}
