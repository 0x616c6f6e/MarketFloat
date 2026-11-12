const api = window.marketFloat;
const $ = selector => document.querySelector(selector);
const marketNames = { cn: 'A 股', us: '美股', crypto: '加密货币', perp: 'USDT 永续' };
const examples = { cn: '例如 600519、SH000001、BJ920002', us: '例如 AAPL、BRK.B、SPY', crypto: '例如 BTC-USDT、ETH-USD', perp: '例如 NVDAUSDT.P、BTCUSDT.P' };
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const decimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = new Intl.NumberFormat('en-US', { signDisplay: 'exceptZero', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rows = new Map();
const filters = [...document.querySelectorAll('[data-market]')];
const list = $('#watchlist');
const dialog = $('#add-dialog');
const positionDialog = $('#position-dialog');
let state, filter = 'all', positionKey;

function priceText(value) {
  if (value >= 1) return decimal.format(value);
  if (value >= 0.01) return value.toFixed(4);
  if (value >= 1e-8) return value.toFixed(8);
  return value.toExponential(3);
}

function sparkline(canvas, samples, direction) {
  const g = canvas.getContext('2d');
  const { width, height } = canvas;
  g.clearRect(0, 0, width, height);
  g.strokeStyle = { rise: '#ff899d', fall: '#74dfac' }[direction] ?? '#7185a2';
  g.lineWidth = 2.6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  if (samples.length < 2) {
    g.moveTo(width / 2 - 3, height / 2);
    g.lineTo(width / 2 + 3, height / 2);
  } else {
    const low = Math.min(...samples);
    const range = Math.max(...samples) - low;
    samples.forEach((price, i) => {
      const x = 3 + (width - 6) * i / (samples.length - 1);
      const y = range ? height - 5 - (height - 10) * (price - low) / range : height / 2;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
  }
  g.stroke();
}

function updateRow(row, item) {
  const quote = item.quote;
  const displayCode = item.market === 'cn' ? item.code.slice(2) : item.code;
  const name = item.name || quote?.name || displayCode;
  const context = item.cached ? '缓存' : item.error ? '未获取' : marketNames[item.market];
  const price = quote ? priceText(quote.price) : '—';
  const pct = quote?.change;
  const direction = !pct || item.cached ? '' : (pct > 0) === state.redUp ? 'rise' : 'fall';
  row.classList.toggle('stale', Boolean(item.cached || item.error));
  row.querySelector('.name').textContent = name;
  row.querySelector('.code').textContent = name === displayCode ? context : displayCode + ' · ' + context;
  const priceNode = row.querySelector('.price');
  priceNode.textContent = price;
  priceNode.classList.toggle('long', price.length > 9);
  row.querySelector('.currency').textContent = item.currency;
  const change = row.querySelector('.change');
  change.className = 'change ' + direction;
  change.textContent = Number.isFinite(pct) ? (pct > 0 ? '+' : '') + pct.toFixed(2) + '%' : '—';
  const positionButton = row.querySelector('.position-return');
  positionButton.hidden = !item.position;
  if (item.position) {
    const roi = item.positionMetrics?.roi;
    const pnl = item.positionMetrics?.pnl;
    const side = item.position.side === 'long' ? '多仓' : '空仓';
    const result = Number.isFinite(roi) ? signed.format(roi) + '%' : '—';
    positionButton.textContent = side + ' ' + result;
    positionButton.className = 'position-return' + (!roi || item.cached ? '' : (roi > 0) === state.redUp ? ' rise' : ' fall');
    positionButton.title = side + '估算收益率 ' + result +
      (Number.isFinite(pnl) ? ' · 浮动盈亏 ' + signed.format(pnl) + ' ' + item.currency : '') +
      (item.cached ? ' · 缓存报价' : '');
    positionButton.setAttribute('aria-label', positionButton.title + '，编辑合约仓位');
  }
  row.querySelector('.row-menu').setAttribute('aria-label', name + '选项');
  row.setAttribute('aria-label', name + ' ' + displayCode + ' · ' + price + ' ' + item.currency + ' · 按 Enter 打开 TradingView');
  sparkline(row.querySelector('canvas'), item.samples, direction);
}

function render() {
  if (!state) return;
  filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.market === filter)));
  const visible = state.items.filter(item => filter === 'all' || item.market === filter);
  const keys = new Set(visible.map(item => item.key));
  for (const [key, row] of rows) {
    if (keys.has(key)) continue;
    window.chartPreview.hide(row);
    row.remove();
    rows.delete(key);
  }
  list.querySelector('.empty')?.remove();
  for (const item of visible) {
    let row = rows.get(item.key);
    if (!row) {
      row = $('#row-template').content.firstElementChild.cloneNode(true);
      const showMenu = event => { event.preventDefault(); window.chartPreview.hide(); api.quoteMenu(item.key); };
      row.querySelector('.row-menu').addEventListener('click', showMenu);
      row.querySelector('.position-return').addEventListener('click', () => showPosition(item.key));
      row.addEventListener('contextmenu', showMenu);
      row.dataset.key = item.key;
      window.chartPreview.attach(row, () => ({ item: state.items.find(entry => entry.key === item.key), redUp: state.redUp }));
      rows.set(item.key, row);
      list.append(row);
    }
    updateRow(row, item);
  }
  if (!visible.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '暂无自选，点击「添加」关注标的';
    list.append(empty);
  }
  $('#count').textContent = visible.length + ' 项';
  $('#frequency').textContent = state.interval + ' 秒刷新';
  $('#pinned').checked = state.pinned;
  $('#red-up').checked = state.redUp;
  $('#interval').value = state.interval;
  $('#refresh').textContent = state.refreshing ? '更新中…' : '↻ 刷新';
  let status = '等待获取行情';
  let indicator = '';
  if (state.saveFailed) { status = '本地设置保存失败'; indicator = 'warn'; }
  else if (state.refreshing) status = '正在获取行情…';
  else if (!state.items.length) status = '自选列表为空';
  else if (!state.current && state.errors) {
    status = '行情连接失败 · ' + (state.items.some(item => item.cached) ? '显示缓存' : '等待重试');
    indicator = 'warn';
  } else if (state.updatedAt) {
    status = '更新 ' + timeFormat.format(state.updatedAt) + (state.errors ? ' · ' + state.errors + ' 项未获取' : '');
    indicator = state.errors ? 'warn' : 'ok';
  }
  $('#status').textContent = status;
  $('#indicator').className = 'indicator ' + indicator;
}

function setState(value) {
  state = value;
  window.chartPreview.setPeriod(value.chartPeriod);
  window.marketFloatSettings.update(value);
  render();
}

function chooseMarket(value) {
  window.chartPreview.hide();
  filter = value;
  list.scrollTop = 0;
  render();
}

function hint() {
  $('#add-hint').classList.remove('error');
  $('#add-hint').textContent = examples[$('#new-market').value];
}

function showAdd() {
  if (dialog.open) return;
  window.marketFloatSettings.close();
  window.chartPreview.hide();
  $('#new-market').value = filter === 'all' ? 'cn' : filter;
  $('#new-code').value = '';
  hint();
  dialog.showModal();
  $('#new-code').focus();
}

function showPosition(key) {
  const item = state?.items.find(entry => entry.key === key);
  if (!item || document.querySelector('dialog[open]')) return;
  window.chartPreview.hide();
  positionKey = key;
  $('#position-symbol').textContent = item.code;
  $('#position-currency').textContent = '(' + item.currency + ')';
  const base = item.base ?? (item.market === 'crypto' ? item.code.split('-')[0] : '');
  $('#position-quantity-unit').textContent = base ? '(' + base + ')' : '';
  $('#position-side').value = item.position?.side ?? 'long';
  $('#position-entry').value = item.position?.entryPrice ?? '';
  $('#position-quantity').value = item.position?.quantity ?? '';
  $('#position-leverage').value = item.position?.leverage ?? 1;
  $('#position-remove').hidden = !item.position;
  $('#position-error').hidden = true;
  positionDialog.showModal();
  $('#position-entry').focus();
}

async function savePosition(input) {
  const save = $('#position-save');
  const remove = $('#position-remove');
  if (save.disabled) return;
  save.disabled = remove.disabled = true;
  const error = $('#position-error');
  error.hidden = true;
  try {
    const result = await api.savePosition(positionKey, input);
    if (!result.error) positionDialog.close();
    else { error.textContent = result.error; error.hidden = false; }
  } catch {
    error.textContent = '无法保存仓位，请重试。';
    error.hidden = false;
  } finally {
    save.disabled = remove.disabled = false;
  }
}

filters.forEach(button => button.addEventListener('click', () => chooseMarket(button.dataset.market)));
$('#add').addEventListener('click', showAdd);
$('#new-market').addEventListener('change', hint);
$('#new-code').addEventListener('input', hint);
$('#add-cancel').addEventListener('click', () => dialog.close());
$('#position-cancel').addEventListener('click', () => positionDialog.close());
$('#position-remove').addEventListener('click', () => void savePosition(null));
$('#position-form').addEventListener('submit', event => {
  event.preventDefault();
  void savePosition({
    side: $('#position-side').value, entryPrice: $('#position-entry').value,
    quantity: $('#position-quantity').value, leverage: $('#position-leverage').value,
  });
});
api.onOpenPosition(showPosition);
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  const market = $('#new-market').value;
  try {
    const result = await api.add(market, $('#new-code').value);
    if (typeof result === 'string') {
      $('#add-hint').classList.add('error');
      $('#add-hint').textContent = result;
      $('#new-code').focus();
      return;
    }
    if (filter !== 'all' && filter !== result.market) chooseMarket(result.market);
    list.scrollTop = list.scrollHeight;
    dialog.close();
  } finally { submit.disabled = false; }
});
$('#collapse').addEventListener('click', api.collapse);
$('#hide').addEventListener('click', api.hide);
$('#refresh').addEventListener('click', api.refresh);
document.addEventListener('keydown', event => {
  if (event.key === 'F5') { event.preventDefault(); api.refresh(); }
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') {
    if (window.chartPreview.hide()) return;
    if (!$('#settings-page').hidden) window.marketFloatSettings.close(true);
    else api.collapse();
  }
  if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); showAdd(); }
});
api.subscribe(setState);
api.snapshot().then(setState);
