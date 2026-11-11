const { getQuotes } = require('./quotes.cjs');

const limit = 30;
const dayMs = 24 * 60 * 60 * 1000;
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

function tradingViewUrl(item, listing = '') {
  let ticker = item.code;
  if (item.market === 'cn') {
    ticker = chinaExchanges[item.code.slice(0, 2)] + ':' + item.code.slice(2);
  } else if (item.market === 'crypto') {
    ticker = (item.currency === 'USDT' ? 'BINANCE:' : 'COINBASE:') + item.code.replace('-', '');
  } else if (validUsListing(listing, item.code)) {
    const exchange = usExchanges[listing.slice(item.code.length + 1)];
    if (exchange) ticker = exchange + ':' + item.code;
  }
  const url = new URL('https://www.tradingview.com/chart/');
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('interval', 'D');
  return url.href;
}

function candle(date, open, high, low, close) {
  if (![open, high, low, close].every(value => (typeof value === 'number' || typeof value === 'string' && value.trim()) &&
      Number.isFinite(Number(value)) && Number(value) > 0)) return null;
  const [o, h, l, c] = [open, high, low, close].map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      h < Math.max(o, c) || l > Math.min(o, c)) return null;
  return { date, open: o, high: h, low: l, close: c };
}

function dateFromMs(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString().slice(0, 10) : '';
}

function lastCandles(rows, parse) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row)) continue;
    const result = parse(row);
    if (result) byDate.set(result.date, result);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-limit);
}

async function json(fetch, url, headers) {
  const response = await fetch(url, { credentials: 'omit', headers, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error('History endpoint unavailable');
  return response.json();
}

async function stockHistory(fetch, item, knownListing) {
  const us = item.market === 'us';
  const listing = us ? await usListing(fetch, item, knownListing) : '';
  if (us && !listing) return { error: '暂未识别该美股的上市交易所，无法获取日 K。' };
  const ticker = us ? 'us' + listing : item.code.toLowerCase();
  const endpoint = us ? 'usfqkline' : 'fqkline';
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/' + endpoint + '/get?param=' + ticker + ',day,,,' + limit + ',qfq';
  const response = await json(fetch, url, { Referer: 'https://gu.qq.com/' });
  const series = response?.data?.[ticker];
  const adjusted = Array.isArray(series?.qfqday) && series.qfqday.length > 0;
  const rows = adjusted ? series.qfqday : series?.day;
  const candles = lastCandles(rows, ([date, open, close, high, low]) => candle(date, open, high, low, close));
  return { candles, source: '腾讯财经', adjusted, listing };
}

async function beijingHistory(fetch, item) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.' + item.code.slice(2) +
    '&klt=101&fqt=0&end=20500101&lmt=' + limit + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55';
  const result = await json(fetch, url);
  const rows = result?.data?.klines;
  const values = Array.isArray(rows) ? rows.filter(row => typeof row === 'string').map(row => row.split(',')) : [];
  return {
    source: '东方财富',
    candles: lastCandles(values, ([date, open, close, high, low]) => candle(date, open, high, low, close)),
  };
}

async function cryptoHistory(fetch, item) {
  if (item.currency === 'USDT') {
    const url = 'https://data-api.binance.vision/api/v3/klines?symbol=' + item.code.replace('-', '') + '&interval=1d&limit=' + limit;
    const rows = await json(fetch, url);
    return {
      source: 'Binance',
      candles: lastCandles(rows, ([time, open, high, low, close]) => candle(dateFromMs(Number(time)), open, high, low, close)),
    };
  }
  const end = new Date();
  const start = new Date(end.getTime() - limit * dayMs);
  const url = new URL('https://api.exchange.coinbase.com/products/' + item.code + '/candles');
  url.searchParams.set('granularity', '86400');
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());
  const rows = await json(fetch, url);
  return {
    source: 'Coinbase',
    candles: lastCandles(rows, ([time, low, high, open, close]) => candle(dateFromMs(Number(time) * 1000), open, high, low, close)),
  };
}

async function getHistory(fetch, item, knownListing) {
  try {
    if (item.market === 'cn' && item.code.startsWith('BJ')) {
      const beijing = await beijingHistory(fetch, item).catch(() => null);
      if (beijing?.candles.length) return beijing;
    }
    const result = await (item.market === 'crypto' ? cryptoHistory(fetch, item) : stockHistory(fetch, item, knownListing));
    if (result.error || result.candles.length) return result;
    return { error: '行情源暂未提供该标的的日 K 数据。' };
  } catch {
    return { error: '暂时无法加载日 K，请稍后再试。' };
  }
}

module.exports = { getHistory, usListing, tradingViewUrl };
