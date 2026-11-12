const sourceGroups = ['cn', 'us', 'usd', 'usdt', 'perp'];
const defaultProxy = { mode: 'system', address: '' };
const jsonFields = ['price', 'change', 'previous', 'name'];
const token = /\{(code|symbol|base|quote)\}/g;
const fieldPattern = /^(?:[\p{L}\p{N}_$-]+|\[\d+\])(?:\.[\p{L}\p{N}_$-]+|\[\d+\])*$/u;

function sourceGroup(item) {
  return item.market === 'crypto' ? item.currency.toLowerCase() : item.market;
}

function sourceUrl(template, item) {
  const [base, quote] = item.code.split('-');
  const values = {
    code: item.code,
    symbol: item.market === 'perp' ? item.base + item.currency : item.market === 'cn' ? item.code.toLowerCase() : item.code.replace('-', ''),
    base: item.base ?? base,
    quote: quote ?? item.currency,
  };
  return template.replace(token, (_match, name) => encodeURIComponent(values[name]));
}

function parseSource(input) {
  if (input === null) return { value: null };
  const url = typeof input?.url === 'string' ? input.url.trim() : '';
  const example = url.replace(token, 'sample');
  if (!/^https?:\/\//i.test(url) || url.length > 2000 || /[{}\s]/.test(example) || /\{/.test(url.split('/').slice(0, 3).join('/'))) {
    return { error: '请输入有效的接口地址，变量只能放在路径或查询参数中。' };
  }
  try {
    const parsed = new URL(example);
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
      return { error: '接口须为 HTTP 或 HTTPS 地址，且不能包含登录信息或片段。' };
    }
  } catch { return { error: '请输入完整的 HTTP 或 HTTPS 接口地址。' }; }

  const value = { url };
  for (const field of jsonFields) {
    const text = typeof input[field] === 'string' ? input[field].trim() : '';
    if (field === 'price' && !text) return { error: '请输入最新价字段。' };
    if (text && (text.length > 160 || !fieldPattern.test(text))) {
      return { error: '字段路径格式无效，例如 data.price 或 data[0].price。' };
    }
    value[field] = text;
  }
  return { value };
}

function jsonField(data, field) {
  if (!field) return undefined;
  let value = data;
  const keys = field.replaceAll(/\[(\d+)\]/g, '.$1').replace(/^\./, '').split('.');
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function parseProxy(input) {
  if (input?.mode === 'system' || input?.mode === 'direct') return { value: { mode: input.mode, address: '' } };
  if (input?.mode !== 'fixed_servers') return { error: '请选择代理模式。' };
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  const parts = /^(https?|socks5):\/\/(\[[a-f\d:.]+\]|[a-z\d.-]+):(\d{1,5})\/?$/i.exec(address);
  if (!parts || +parts[3] < 1 || +parts[3] > 65535 || address.length > 260) {
    return { error: '请输入代理协议、主机和端口，例如 socks5://127.0.0.1:1080。' };
  }
  try { new URL(address); } catch { return { error: '代理地址无效。' }; }
  return { value: { mode: input.mode, address: parts[1].toLowerCase() + '://' + parts[2] + ':' + +parts[3] } };
}

async function setNetworkProxy(network, proxy) {
  const config = { mode: proxy.mode };
  if (proxy.mode === 'fixed_servers') config.proxyRules = proxy.address;
  await network.setProxy(config);
  await network.closeAllConnections();
}

function decimalInput(amount) {
  return typeof amount === 'number' || typeof amount === 'string' && /^\d*\.?\d+(?:e[+-]?\d+)?$/i.test(amount.trim())
    ? Number(amount) : NaN;
}

function parsePosition(input) {
  if (!['long', 'short'].includes(input?.side)) return { error: '请选择多空方向。' };
  const entryPrice = decimalInput(input.entryPrice);
  const quantity = decimalInput(input.quantity);
  const leverage = decimalInput(input.leverage);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { error: '开仓价必须大于零。' };
  if (!Number.isFinite(quantity) || quantity <= 0) return { error: '数量必须大于零。' };
  if (!Number.isFinite(leverage) || leverage < 1) return { error: '杠杆至少为 1 倍。' };
  return { value: { side: input.side, entryPrice, quantity, leverage } };
}

function positionMetrics(position, price) {
  if (!position || !Number.isFinite(price) || price <= 0) return null;
  const move = (price - position.entryPrice) * (position.side === 'long' ? 1 : -1);
  const roi = move / position.entryPrice * position.leverage * 100;
  const pnl = move * position.quantity;
  return { roi: Number.isFinite(roi) ? roi : null, pnl: Number.isFinite(pnl) ? pnl : null };
}

function parseMonitor(input, items) {
  if (!items.some(item => item.key === input?.key)) return { error: '请选择一个自选标的。' };
  if (!['above', 'below'].includes(input.direction)) return { error: '请选择价格条件。' };
  const threshold = decimalInput(input.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) return { error: '目标价格必须大于零。' };
  return { value: { key: input.key, direction: input.direction, threshold } };
}

function loadMonitors(saved, items) {
  const ids = new Set();
  const monitors = [];
  for (const input of Array.isArray(saved) ? saved.slice(0, 100) : []) {
    const { value } = parseMonitor(input, items);
    if (!value || typeof input.id !== 'string' || !/^[a-f\d-]{36}$/i.test(input.id) || ids.has(input.id)) continue;
    ids.add(input.id);
    monitors.push({
      ...value, id: input.id, enabled: input.enabled !== false, matched: input.matched === true,
      triggeredAt: Number.isFinite(input.triggeredAt) && input.triggeredAt > 0 && input.triggeredAt <= 8.64e15 ? input.triggeredAt : 0,
      triggeredPrice: Number.isFinite(input.triggeredPrice) ? input.triggeredPrice : null,
    });
  }
  return monitors;
}

function evaluateMonitors(monitors, item, quote) {
  const hits = [];
  for (const monitor of monitors) {
    if (!monitor.enabled || monitor.key !== item.key) continue;
    const matched = monitor.direction === 'above' ? quote.price >= monitor.threshold : quote.price <= monitor.threshold;
    if (matched && !monitor.matched) {
      monitor.triggeredAt = quote.readAt;
      monitor.triggeredPrice = quote.price;
      hits.push({ code: item.code, currency: item.currency, direction: monitor.direction, threshold: monitor.threshold, price: quote.price });
    }
    monitor.matched = matched;
  }
  return hits;
}

module.exports = { sourceGroups, sourceGroup, sourceUrl, parseSource, jsonField, defaultProxy, parseProxy, setNetworkProxy, parseMonitor, loadMonitors, evaluateMonitors, parsePosition, positionMetrics };
