const { getQuotes, binanceMarketUrl } = require('./quotes.cjs');

const limit = 30;
const dayMs = 24 * 60 * 60 * 1000;
const chartPeriods = {
  day: { binance: '1d', eastmoney: 101, tradingView: 'D' },
  week: { binance: '1w', eastmoney: 102, tradingView: 'W' },
  month: { binance: '1M', eastmoney: 103, tradingView: 'M' },
};
const usExchanges = { OQ: 'NASDAQ', O: 'NASDAQ', N: 'NYSE', AM: 'AMEX', A: 'AMEX', ARCA: 'AMEX', PK: 'OTC', OB: 'OTC' };
const chinaExchanges = { SH: 'SSE', SZ: 'SZSE', BJ: 'BJSE' };

function validUsListing(listing, code) {
  return typeof listing === 'string' && listing.startsWith(code + '.') &&
    /^[A-Z\d]{1,4}$/.test(listing.slice(code.length + 1));
}

async function usListing(fetch, item, known) {
  if (validUsListing(known, item.code)) return known;
  const result = await getQuotes(fetch, [item]);
  const listing = result.get(item.key)?.quote?.listing;
  return validUsListing(listing, item.code) ? listing : '';
}

function isChartPeriod(period) {
  return typeof period === 'string' && Object.hasOwn(chartPeriods, period);
}

function tradingViewUrl(item, listing = '', period) {
  let ticker = item.code;
  if (item.market === 'cn') {
    ticker = chinaExchanges[item.code.slice(0, 2)] + ':' + item.code.slice(2);
  } else if (item.market === 'perp') {
    ticker = 'BINANCE:' + item.code;
  } else if (item.market === 'crypto') {
    ticker = (item.currency === 'USDT' ? 'BINANCE:' : 'COINBASE:') + item.code.replace('-', '');
  } else if (validUsListing(listing, item.code)) {
    const exchange = usExchanges[listing.slice(item.code.length + 1)];
    if (exchange) ticker = exchange + ':' + item.code;
  }
  const url = new URL('https://www.tradingview.com/chart/');
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('interval', isChartPeriod(period) ? chartPeriods[period].tradingView : '15');
  return url.href;
}

function candle(date, open, high, low, close, volume) {
  if (![open, high, low, close].every(value => (typeof value === 'number' || typeof value === 'string' && value.trim()) &&
      Number.isFinite(Number(value)) && Number(value) > 0)) return null;
  const [o, h, l, c] = [open, high, low, close].map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      h < Math.max(o, c) || l > Math.min(o, c)) return null;
  const amount = typeof volume === 'number' || typeof volume === 'string' && volume.trim() ? Number(volume) : NaN;
  return { date, open: o, high: h, low: l, close: c, volume: Number.isFinite(amount) && amount >= 0 ? amount : null };
}

function dateFromMs(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString().slice(0, 10) : '';
}

function normalizeCandles(rows, parse) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row)) continue;
    const result = parse(row);
    if (result) byDate.set(result.date, result);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function parseStockCandle([date, open, close, high, low, volume]) {
  return candle(date, open, high, low, close, volume);
}

async function json(fetch, url, headers) {
  const response = await fetch(url, { credentials: 'omit', headers, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error('History endpoint unavailable');
  return response.json();
}

async function stockHistory(fetch, item, knownListing, period) {
  const us = item.market === 'us';
  const listing = us ? await usListing(fetch, item, knownListing) : '';
  if (us && !listing) return { error: '暂未识别该美股的上市交易所，无法获取 K 线。' };
  const ticker = us ? 'us' + listing : item.code.toLowerCase();
  const endpoint = us ? 'usfqkline' : 'fqkline';
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/' + endpoint + '/get?param=' + ticker + ',' + period + ',,,' + limit + ',qfq';
  const response = await json(fetch, url, { Referer: 'https://gu.qq.com/' });
  const series = response?.data?.[ticker];
  const adjustedRows = series?.['qfq' + period];
  const adjusted = Array.isArray(adjustedRows) && adjustedRows.length > 0;
  const rows = adjusted ? adjustedRows : series?.[period];
  return { candles: normalizeCandles(rows, parseStockCandle), source: '腾讯财经', adjusted, listing, volumeUnit: us ? '股' : '手' };
}

async function beijingHistory(fetch, item, period) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.' + item.code.slice(2) +
    '&klt=' + chartPeriods[period].eastmoney + '&fqt=0&end=20500101&lmt=' + limit + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56';
  const result = await json(fetch, url);
  const rows = result?.data?.klines;
  const values = Array.isArray(rows) ? rows.filter(row => typeof row === 'string').map(row => row.split(',')) : [];
  return {
    source: '东方财富', volumeUnit: '手',
    candles: normalizeCandles(values, parseStockCandle),
  };
}

function bucketStart(time, period, offset = 0) {
  const day = new Date(time);
  if (period === 'month') return Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + offset, 1);
  const midnight = Math.floor(time / dayMs) * dayMs;
  if (period === 'week') return midnight + (7 * offset - (day.getUTCDay() + 6) % 7) * dayMs;
  return midnight + offset * dayMs;
}

function aggregateCandles(rows, period) {
  if (period === 'day') return rows;
  const buckets = new Map();
  for (const bar of rows) {
    const date = dateFromMs(bucketStart(Date.parse(bar.date), period));
    const bucket = buckets.get(date);
    if (!bucket) {
      buckets.set(date, { ...bar, date });
      continue;
    }
    bucket.high = Math.max(bucket.high, bar.high);
    bucket.low = Math.min(bucket.low, bar.low);
    bucket.close = bar.close;
    bucket.volume = bucket.volume === null || bar.volume === null ? null : bucket.volume + bar.volume;
  }
  return [...buckets.values()];
}

async function coinbaseHistory(fetch, item, period) {
  const end = Date.now();
  const start = bucketStart(end, period, 1 - limit);
  const requests = [];
  // Coinbase returns at most 300 daily candles per request, including any extra leading bucket.
  for (let from = start; from < end; from += 280 * dayMs) {
    const to = Math.min(end, from + 280 * dayMs);
    const url = new URL('https://api.exchange.coinbase.com/products/' + item.code + '/candles');
    url.searchParams.set('granularity', '86400');
    url.searchParams.set('start', new Date(from).toISOString());
    url.searchParams.set('end', new Date(to).toISOString());
    requests.push(json(fetch, url).then(rows => Array.isArray(rows) ? rows.filter(row => {
      const time = Number(row?.[0]) * 1000;
      return time >= from && time < to;
    }) : []));
  }
  const daily = normalizeCandles((await Promise.all(requests)).flat(),
    ([time, low, high, open, close, volume]) => candle(dateFromMs(Number(time) * 1000), open, high, low, close, volume));
  return { source: 'Coinbase', volumeUnit: item.code.split('-')[0], candles: aggregateCandles(daily, period) };
}

async function cryptoHistory(fetch, item, period) {
  if (item.currency === 'USDT') {
    const url = binanceMarketUrl(item, 'klines') +
      '&interval=' + chartPeriods[period].binance + '&limit=' + limit;
    const rows = await json(fetch, url);
    return {
      source: item.source, volumeUnit: item.base ?? item.code.split('-')[0],
      candles: normalizeCandles(rows, ([time, open, high, low, close, volume]) => candle(dateFromMs(Number(time)), open, high, low, close, volume)),
    };
  }
  return coinbaseHistory(fetch, item, period);
}

async function getHistory(fetch, item, knownListing, period = 'day') {
  if (!isChartPeriod(period)) return { error: 'K 线周期无效。' };
  try {
    if (item.market === 'cn' && item.code.startsWith('BJ')) {
      const beijing = await beijingHistory(fetch, item, period).catch(() => null);
      if (beijing?.candles.length) return { ...beijing, candles: beijing.candles.slice(-limit) };
    }
    const result = await (item.market === 'cn' || item.market === 'us'
      ? stockHistory(fetch, item, knownListing, period) : cryptoHistory(fetch, item, period));
    if (result.error) return result;
    if (result.candles.length) return { ...result, candles: result.candles.slice(-limit) };
    return { error: '行情源暂未提供该标的在所选周期的 K 线。' };
  } catch {
    return { error: '暂时无法加载 K 线，请稍后再试。' };
  }
}

module.exports = { getHistory, usListing, tradingViewUrl, isChartPeriod };
