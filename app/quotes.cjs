const { TextDecoder } = require('node:util');
const { sourceGroup, sourceUrl, jsonField } = require('./preferences.cjs');

const names = { cn: 'A 股', us: '美股', crypto: '加密货币' };
const validMarkets = Object.keys(names);
const defaults = [
  ['cn', 'SH000001', '上证指数'], ['cn', 'SH600519', '贵州茅台'], ['cn', 'SZ300750', '宁德时代'],
  ['us', 'AAPL', '苹果'], ['us', 'NVDA', '英伟达'],
  ['crypto', 'BTC-USDT', '比特币'], ['crypto', 'ETH-USDT', '以太坊'],
];

function symbol(market, input, name = '') {
  if (!validMarkets.includes(market) || typeof input !== 'string') return null;
  let code = input.trim().toUpperCase();
  if (market === 'cn') {
    code = code.replace(/^(\d{6})\.(SH|SZ|BJ)$/, '$2$1');
    if (/^[0-9]{6}$/.test(code)) {
      const prefix = /^[56]/.test(code) ? 'SH' : /^[489]/.test(code) ? 'BJ' : /^[013]/.test(code) ? 'SZ' : '';
      code = prefix + code;
    }
    if (!/^(SH|SZ|BJ)\d{6}$/.test(code)) return null;
  } else if (market === 'us') {
    code = code.replace('-', '.');
    if (!/^[A-Z]{1,6}(\.[A-Z]{1,2})?$/.test(code)) return null;
  } else {
    code = code.replaceAll(' ', '').replace('/', '-');
    if (!code.includes('-')) code += '-USD';
    if (!/^[A-Z0-9]{1,16}-(USD|USDT)$/.test(code)) return null;
  }
  const currency = market === 'cn' ? 'CNY' : code.endsWith('-USDT') ? 'USDT' : 'USD';
  return {
    key: market + '/' + code, market, code, name: typeof name === 'string' ? name.slice(0, 80) : '',
    currency, source: market !== 'crypto' ? '腾讯财经' : currency === 'USD' ? 'Coinbase' : 'Binance',
  };
}

function number(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function percentage(price, previous) {
  return previous > 0 ? (price / previous - 1) * 100 : null;
}

function tencentQuotes(data) {
  const result = new Map();
  for (const match of data.matchAll(/^\s*v_([\w.\-]+)="([^"]*)"/gm)) {
    const fields = match[2].split('~');
    const price = number(fields[3]);
    if (!(price > 0)) continue;
    const marketTime = fields[30]?.trim().replace(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5:$6');
    result.set(match[1].toLowerCase(), {
      price, name: fields[1]?.trim(), marketTime, readAt: Date.now(),
      listing: fields[2]?.trim(),
      change: number(fields[32]) ?? percentage(price, number(fields[4])),
    });
  }
  return result;
}

async function request(fetch, url, options) {
  const response = await fetch(url, { credentials: 'omit', ...options, signal: AbortSignal.timeout(8500) });
  if (!response.ok) {
    const message = [400, 404].includes(response.status) ? '行情源无此代码' : '行情源暂不可用（HTTP ' + response.status + '）';
    throw new QuoteError(message);
  }
  return response;
}

class QuoteError extends Error {}

function explain(error) {
  if (error instanceof QuoteError) return error.message;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '行情请求超时';
  if (error instanceof SyntaxError) return '行情源返回了无效数据';
  return '无法连接行情源';
}

async function stocks(fetch, items) {
  const keys = items.map(item => item.market === 'cn' ? item.code.toLowerCase() : 'us' + item.code);
  try {
    const response = await request(fetch, 'https://qt.gtimg.cn/q=' + keys.join(','), {
      headers: { Referer: 'https://gu.qq.com/' },
    });
    const data = tencentQuotes(new TextDecoder('gbk').decode(await response.arrayBuffer()));
    return items.map((item, i) => [item.key, { quote: data.get(keys[i].toLowerCase()), error: '行情源未返回报价' }]);
  } catch (error) {
    return items.map(item => [item.key, { error: explain(error) }]);
  }
}

async function crypto(fetch, item) {
  const usdt = item.currency === 'USDT';
  const url = usdt
    ? 'https://data-api.binance.vision/api/v3/ticker/24hr?symbol=' + item.code.replace('-', '')
    : 'https://api.exchange.coinbase.com/products/' + item.code + '/stats';
  try {
    const data = await (await request(fetch, url)).json();
    const price = number(usdt ? data.lastPrice : data.last);
    if (!(price > 0)) return [item.key, { error: '行情源未返回报价' }];
    const change = (usdt ? number(data.priceChangePercent) : null) ??
      percentage(price, number(usdt ? data.openPrice : data.open));
    return [item.key, { quote: { price, change, readAt: Date.now() } }];
  } catch (error) {
    return [item.key, { error: explain(error) }];
  }
}

async function customQuote(fetch, item, config) {
  try {
    const url = sourceUrl(config.url, item);
    const response = await request(fetch, url, { headers: { Accept: 'application/json' }, redirect: 'error' });
    const data = await response.json();
    const price = number(jsonField(data, config.price));
    if (!(price > 0)) return [item.key, { error: '最新价字段不存在或不是正数' }];
    const name = jsonField(data, config.name);
    const change = number(jsonField(data, config.change)) ?? percentage(price, number(jsonField(data, config.previous)));
    return [item.key, { quote: { price, name: typeof name === 'string' ? name.slice(0, 80) : undefined, change, readAt: Date.now() } }];
  } catch (error) {
    return [item.key, { error: explain(error) }];
  }
}

async function getQuotes(fetch, items, sources = {}) {
  const builtIn = items.filter(item => !sources[sourceGroup(item)]);
  const shares = builtIn.filter(item => item.market !== 'crypto');
  const singles = items.filter(item => item.market === 'crypto' || sources[sourceGroup(item)]);
  const jobs = [];
  for (let i = 0; i < shares.length; i += 30) jobs.push(stocks(fetch, shares.slice(i, i + 30)));
  if (singles.length) {
    jobs.push((async () => {
      const results = [];
      let i = 0;
      const workers = Array.from({ length: Math.min(8, singles.length) }, async () => {
        while (i < singles.length) {
          const item = singles[i++];
          const custom = sources[sourceGroup(item)];
          results.push(await (custom ? customQuote(fetch, item, custom) : crypto(fetch, item)));
        }
      });
      await Promise.all(workers);
      return results;
    })());
  }
  return new Map((await Promise.all(jobs)).flat());
}

module.exports = { symbol, defaults, names, getQuotes };
