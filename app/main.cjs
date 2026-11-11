const { app, BrowserWindow, Tray, Menu, ipcMain, screen, session, nativeImage, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { symbol, defaults, getQuotes } = require('./quotes.cjs');
const { getHistory, usListing, tradingViewUrl, isChartPeriod } = require('./charts.cjs');
const {
  sourceGroups, sourceGroup, parseSource, defaultProxy, parseProxy, setNetworkProxy,
  parseMonitor, loadMonitors, evaluateMonitors,
} = require('./preferences.cjs');

const iconPath = path.join(__dirname, 'MarketFloat.ico');
const iconSize = 62;
const panelWidth = 464;
const panelHeight = 670;
const intervals = [15, 30, 60];
let panel, orb, tray, state, drag, timer, statePath, quoteNetwork, chartNetwork, activeRefresh;
let view = 'panel';
let closing = false;
let refreshing = false;
let pending = false;
let updatedAt = 0;
let saveFailed = false;
let proxyChanging = false;
let quoteRevision = 0;
const errors = new Map();
const current = new Set();
const history = new Map();
const chartHistory = new Map();
const chartWindows = new Map();

app.setAppUserModelId('MarketFloat.Desktop');

function safeJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

function load() {
  let saved = safeJson(statePath);
  const legacy = !saved && process.env.LOCALAPPDATA &&
    safeJson(path.join(process.env.LOCALAPPDATA, 'MarketFloat', 'settings.json'));
  if (Array.isArray(legacy?.Watchlist)) {
    saved = {
      pinned: legacy.Pinned, interval: legacy.Interval, redUp: legacy.RedUp,
      panel: { x: legacy.Left, y: legacy.Top }, cached: {},
      watchlist: legacy.Watchlist.map(item => ({
        market: ['cn', 'us', 'crypto'][item?.Market], code: item?.Code, name: item?.Name,
      })),
    };
  }
  const entries = Array.isArray(saved?.watchlist) ? saved.watchlist : defaults.map(args => symbol(...args));
  const unique = new Map();
  for (const item of entries.slice(0, 40)) {
    const parsed = symbol(item?.market, item?.code, item?.name);
    if (parsed) unique.set(parsed.key, parsed);
  }
  const watchlist = [...unique.values()];
  const cached = {};
  for (const item of watchlist) {
    const quote = saved?.cached?.[item.key];
    if (Number.isFinite(quote?.price) && quote.price > 0) cached[item.key] = quote;
  }
  const sources = {};
  for (const group of sourceGroups) {
    const { value } = parseSource(saved?.sources?.[group]);
    if (value) sources[group] = value;
  }
  return {
    watchlist, cached, interval: intervals.includes(saved?.interval) ? saved.interval : 30,
    pinned: saved?.pinned !== false, redUp: saved?.redUp !== false,
    panel: saved?.panel, orb: saved?.orb, sources,
    proxy: parseProxy(saved?.proxy).value ?? defaultProxy,
    monitors: loadMonitors(saved?.monitors, watchlist),
    chartPeriod: isChartPeriod(saved?.chartPeriod) ? saved.chartPeriod : 'day',
  };
}

function save() {
  try {
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(state));
    fs.renameSync(statePath + '.tmp', statePath);
    saveFailed = false;
  } catch { saveFailed = true; }
}

function snapshot() {
  return {
    items: state.watchlist.map(item => ({
      ...item, source: state.sources[sourceGroup(item)] ? '自定义行情源' : item.source,
      quote: state.cached[item.key] ?? null, samples: history.get(item.key) ?? [],
      cached: !current.has(item.key) && Boolean(state.cached[item.key]), error: errors.get(item.key),
    })),
    interval: state.interval, pinned: state.pinned, redUp: state.redUp, refreshing, updatedAt,
    errors: errors.size, current: current.size, saveFailed,
    sources: state.sources, proxy: state.proxy, monitors: state.monitors, chartPeriod: state.chartPeriod,
  };
}

function publish() {
  if (panel && !panel.isDestroyed()) panel.webContents.send('state', snapshot());
}

async function refresh({ forceAgain = false } = {}) {
  if (refreshing || proxyChanging) { pending ||= forceAgain; return; }
  if (!state.watchlist.length || closing) return;
  refreshing = true;
  const controller = new AbortController();
  activeRefresh = controller;
  publish();
  try {
    const requested = state.watchlist.slice();
    const revision = quoteRevision;
    const fetch = (url, options) => quoteNetwork.fetch(url, {
      ...options, signal: AbortSignal.any([options.signal, controller.signal]),
    });
    const result = await getQuotes(fetch, requested, state.sources);
    if (closing || revision !== quoteRevision) return;
    let received = false;
    const alerts = [];
    for (const item of state.watchlist) {
      if (!requested.includes(item)) continue;
      const response = result.get(item.key);
      if (!response?.quote) {
        errors.set(item.key, response?.error ?? '未获取报价');
        current.delete(item.key);
        continue;
      }
      received = true;
      errors.delete(item.key);
      current.add(item.key);
      state.cached[item.key] = response.quote;
      alerts.push(...evaluateMonitors(state.monitors, item, response.quote));
      const series = history.get(item.key) ?? [];
      history.set(item.key, [...series.slice(-31), response.quote.price]);
    }
    if (received) { updatedAt = Date.now(); save(); }
    if (alerts.length) announceAlerts(alerts);
  } finally {
    activeRefresh = null;
    refreshing = false;
    if (!closing) publish();
    if (pending && !proxyChanging) { pending = false; void refresh(); }
  }
}

function announceAlerts(alerts) {
  const lines = alerts.slice(0, 3).map(alert => {
    const direction = alert.direction === 'above' ? '≥' : '≤';
    return alert.code + ' ' + direction + ' ' + alert.threshold + '，现价 ' + alert.price + ' ' + alert.currency;
  });
  if (alerts.length > lines.length) lines.push('另有 ' + (alerts.length - lines.length) + ' 条提醒');
  if (process.platform !== 'win32') return;
  try { tray.displayBalloon({ title: '浮窗看盘 · 价格提醒', content: lines.join('\n') }); }
  catch { /* The monitor still keeps the latest trigger if Windows suppresses tray notifications. */ }
}

function clearQuote(key) {
  delete state.cached[key];
  current.delete(key);
  errors.delete(key);
  history.delete(key);
}

function chartListing(key) {
  if (state.cached[key]?.listing) return state.cached[key].listing;
  for (const entry of chartHistory.get(key)?.values() ?? []) {
    if (entry.result?.listing) return entry.result.listing;
  }
  return '';
}

function chartPreview(key, period = state.chartPeriod) {
  const item = state.watchlist.find(entry => entry.key === key);
  if (!item) return { error: '此标的已移出自选。' };
  if (!isChartPeriod(period)) return { error: 'K 线周期无效。' };
  if (proxyChanging) return { error: '代理正在切换，请稍后再试。' };
  let periods = chartHistory.get(key);
  if (!periods) {
    periods = new Map();
    chartHistory.set(key, periods);
  }
  const existing = periods.get(period);
  if (existing && existing.until > Date.now()) return existing.promise;
  const entry = { until: Infinity, result: null };
  entry.promise = getHistory(quoteNetwork.fetch.bind(quoteNetwork), item, chartListing(key), period).then(result => {
    entry.result = result;
    entry.until = Date.now() + (result.error ? 8000 : 120000);
    return result;
  });
  periods.set(period, entry);
  return entry.promise;
}

function isTradingViewUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'tradingview.com' || url.hostname.endsWith('.tradingview.com'));
  } catch { return false; }
}

async function showTradingView(item, period = state.chartPeriod) {
  if (closing) return;
  let entry = chartWindows.get(item.key);
  if (!entry) {
    const area = screen.getDisplayMatching(panel.getBounds()).workArea;
    const width = Math.min(1220, area.width);
    const height = Math.min(800, area.height);
    const chart = new BrowserWindow({
      x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
      width, height, title: item.code + ' · TradingView', icon: iconPath, backgroundColor: '#131722',
      autoHideMenuBar: true,
      webPreferences: { session: chartNetwork, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    chart.setMenu(null);
    chart.once('closed', () => chartWindows.delete(item.key));
    chart.on('page-title-updated', event => event.preventDefault());
    chart.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    entry = { chart, period: null, request: null, listing: '' };
    chartWindows.set(item.key, entry);
  }
  const { chart } = entry;
  if (chart.isMinimized()) chart.restore();
  chart.show();
  chart.focus();
  if (entry.period === period) return;
  entry.period = period;
  const request = Symbol();
  entry.request = request;
  let listing = entry.listing || chartListing(item.key);
  if (item.market === 'us') {
    const fetch = (url, options) => quoteNetwork.fetch(url, {
      ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(3000)]),
    });
    listing = await usListing(fetch, item, listing).catch(() => '');
  }
  if (chart.isDestroyed() || entry.request !== request) return;
  entry.listing = listing;
  const url = tradingViewUrl(item, listing, period);
  try {
    await chart.loadURL(url);
  } catch {
    if (chart.isDestroyed() || closing || entry.request !== request) return;
    const result = await dialog.showMessageBox(chart, {
      type: 'info', title: 'TradingView', message: '暂时无法加载 TradingView 图表。',
      buttons: ['在默认浏览器打开', '关闭'], defaultId: 0, cancelId: 1,
    }).catch(() => null);
    if (chart.isDestroyed() || closing || entry.request !== request) return;
    if (result?.response === 0) await shell.openExternal(url).catch(() => {});
    if (!chart.isDestroyed() && entry.request === request) chart.close();
  }
}

function changeSource(group, input) {
  if (!sourceGroups.includes(group)) return { error: '请选择行情市场。' };
  const { value, error } = parseSource(input);
  if (error) return { error };
  if (JSON.stringify(state.sources[group] ?? null) === JSON.stringify(value)) {
    save();
    publish();
    return saveFailed ? { error: '写入本地设置失败。' } : {};
  }
  const sources = { ...state.sources };
  if (value) sources[group] = value;
  else delete sources[group];
  state.sources = sources;
  quoteRevision++;
  activeRefresh?.abort();
  for (const item of state.watchlist) {
    if (sourceGroup(item) === group) clearQuote(item.key);
  }
  save();
  publish();
  void refresh({ forceAgain: true });
  return saveFailed ? { error: '已应用，写入本地设置失败。' } : {};
}

async function testSource(group, input, code) {
  if (!sourceGroups.includes(group)) return { error: '请选择行情市场。' };
  if (proxyChanging) return { error: '代理正在切换，请稍后再试。' };
  const { value, error } = parseSource(input);
  if (error) return { error };
  const samples = { cn: 'SH600519', us: 'AAPL', usd: 'BTC-USD', usdt: 'BTC-USDT' };
  const market = group === 'cn' || group === 'us' ? group : 'crypto';
  const item = symbol(market, typeof code === 'string' && code.trim() ? code : samples[group]);
  if (!item || sourceGroup(item) !== group) return { error: '测试代码与选定市场不匹配。' };
  const result = await getQuotes(quoteNetwork.fetch.bind(quoteNetwork), [item], value ? { [group]: value } : {});
  const entry = result.get(item.key);
  if (!entry?.quote) return { error: entry?.error ?? '未获取报价' };
  return { code: item.code, currency: item.currency, price: entry.quote.price, change: entry.quote.change };
}

async function changeProxy(input) {
  const { value, error } = parseProxy(input);
  if (error) return { error };
  if (proxyChanging) return { error: '代理正在切换，请稍后再试。' };
  if (value.mode === state.proxy.mode && value.address === state.proxy.address) {
    save();
    publish();
    return saveFailed ? { error: '写入本地设置失败。' } : {};
  }
  proxyChanging = true;
  quoteRevision++;
  activeRefresh?.abort();
  chartHistory.clear();
  try {
    await applyProxy(value);
    state.proxy = value;
    save();
    publish();
    return saveFailed ? { error: '代理已应用，写入本地设置失败。' } : {};
  } catch {
    await applyProxy(state.proxy).catch(() => {});
    return { error: '无法应用此代理设置。' };
  } finally {
    proxyChanging = false;
    pending = false;
    void refresh({ forceAgain: true });
  }
}

async function applyProxy(proxy) {
  await setNetworkProxy(quoteNetwork, proxy);
  await setNetworkProxy(chartNetwork, proxy);
}

function saveMonitor(input) {
  const { value, error } = parseMonitor(input, state.watchlist);
  if (error) return { error };
  const existing = state.monitors.find(monitor => monitor.id === input.id);
  if (input.id && !existing) return { error: '此规则已不存在。' };
  if (state.monitors.some(monitor => monitor !== existing && monitor.key === value.key &&
      monitor.direction === value.direction && monitor.threshold === value.threshold)) {
    return { error: '已存在相同的提醒规则。' };
  }
  if (!existing && state.monitors.length >= 100) return { error: '最多可添加 100 条提醒规则。' };
  if (existing) {
    const changed = Object.keys(value).some(key => value[key] !== existing[key]);
    if (changed) Object.assign(existing, value, { matched: false, triggeredAt: 0, triggeredPrice: null });
  } else {
    state.monitors.push({ ...value, id: randomUUID(), enabled: true, matched: false, triggeredAt: 0, triggeredPrice: null });
  }
  save();
  publish();
  void refresh({ forceAgain: true });
  return saveFailed ? { error: '规则已应用，写入本地设置失败。' } : {};
}

function updateMonitor(id, action) {
  const monitor = state.monitors.find(item => item.id === id);
  if (!monitor) return { error: '此规则已不存在。' };
  if (action === 'remove') state.monitors = state.monitors.filter(item => item !== monitor);
  else if (action === 'enable' || action === 'disable') {
    monitor.enabled = action === 'enable';
    monitor.matched = false;
  } else return { error: '规则操作无效。' };
  save();
  publish();
  if (action === 'enable') void refresh({ forceAgain: true });
  return saveFailed ? { error: '规则已应用，写入本地设置失败。' } : {};
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => void refresh(), state.interval * 1000);
}

function areaFor(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? screen.getDisplayNearestPoint(point).workArea : screen.getPrimaryDisplay().workArea;
}

function boundsFor(point, area, width, height) {
  return {
    x: Math.round(Math.max(area.x, Math.min(point.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(point.y, area.y + area.height - height))),
    width, height,
  };
}

function positionPanel(nearOrb) {
  const point = nearOrb ? orb.getBounds() : state.panel;
  const area = areaFor(point);
  const width = Math.min(panelWidth, area.width);
  const height = Math.min(panelHeight, area.height);
  const fallback = { x: area.x + area.width - width - 20, y: area.y + 22 };
  let target = Number.isFinite(point?.x) && Number.isFinite(point?.y) ? point : fallback;
  if (nearOrb) {
    const left = point.x - width - 10;
    target = { x: left >= area.x ? left : point.x + iconSize + 10, y: point.y };
  }
  panel.setBounds(boundsFor(target, area, width, height));
}

function positionOrb() {
  const point = state.orb ?? state.panel;
  const area = areaFor(point);
  const fallback = { x: area.x + area.width - iconSize - 18, y: area.y + 20 };
  const target = Number.isFinite(state.orb?.x) && Number.isFinite(state.orb?.y) ? state.orb : fallback;
  orb.setBounds(boundsFor(target, area, iconSize, iconSize));
}

function remember(win, key) {
  const { x, y } = win.getBounds();
  state[key] = { x, y };
}

function showPanel() {
  if (closing) return;
  positionPanel(view === 'orb');
  view = 'panel';
  orb.hide();
  panel.show();
  panel.focus();
}

function showOrb() {
  if (closing) return;
  if (panel.isVisible()) remember(panel, 'panel');
  view = 'orb';
  panel.hide();
  positionOrb();
  orb.showInactive();
  save();
}

function hideAll() {
  if (panel.isVisible()) remember(panel, 'panel');
  view = 'tray';
  panel.hide();
  orb.hide();
  save();
}

function trayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示看盘面板', click: showPanel },
    { label: '显示悬浮图标', click: showOrb },
    { label: '隐藏到托盘', click: hideAll },
    { type: 'separator' },
    { label: '刷新行情', click: () => void refresh() },
    { label: '价格监控', click: showMonitors },
    { label: '退出浮窗看盘', click: () => app.quit() },
  ]));
}

function showMonitors() {
  showPanel();
  panel.webContents.send('open-settings', 'monitor');
}

function makeWindow(options, html) {
  const window = new BrowserWindow({
    frame: false, show: false, icon: iconPath, title: '浮窗看盘',
    resizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true,
    ...options,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  void window.loadFile(path.join(__dirname, html));
  return window;
}

function registerIpc() {
  const fromPanel = (event, action) => event.sender === panel.webContents && action();
  const fromOrb = (event, action) => event.sender === orb.webContents && action();
  ipcMain.handle('snapshot', event => fromPanel(event, snapshot));
  ipcMain.handle('chart:preview', (event, key, period) => fromPanel(event, () => chartPreview(key, period)));
  ipcMain.on('chart:open', (event, key, period) => fromPanel(event, () => {
    const item = state.watchlist.find(entry => entry.key === key);
    if (item) void showTradingView(item, isChartPeriod(period) ? period : state.chartPeriod);
  }));
  ipcMain.handle('source:save', (event, group, input) => fromPanel(event, () => changeSource(group, input)));
  ipcMain.handle('source:test', (event, group, input, code) => fromPanel(event, () => testSource(group, input, code)));
  ipcMain.handle('proxy:save', (event, input) => fromPanel(event, () => changeProxy(input)));
  ipcMain.handle('monitor:save', (event, input) => fromPanel(event, () => saveMonitor(input)));
  ipcMain.handle('monitor:update', (event, id, action) => fromPanel(event, () => updateMonitor(id, action)));
  ipcMain.handle('add', (event, market, code) => fromPanel(event, () => {
    const item = symbol(market, code);
    if (!item) return '请按示例输入有效代码';
    if (state.watchlist.some(entry => entry.key === item.key)) return '此标的已在自选中';
    if (state.watchlist.length >= 40) return '最多可添加 40 个标的';
    state.watchlist.push(item);
    save();
    publish();
    void refresh({ forceAgain: true });
    return null;
  }));
  ipcMain.on('quote-menu', (event, key) => fromPanel(event, () => {
    const item = state.watchlist.find(entry => entry.key === key);
    if (!item) return;
    const monitorCount = state.monitors.filter(monitor => monitor.key === key).length;
    Menu.buildFromTemplate([
      { label: '打开 TradingView 图表', click: () => void showTradingView(item) },
      { type: 'separator' },
      { label: '移出自选 · ' + item.code + (monitorCount ? '（含 ' + monitorCount + ' 条提醒）' : ''), click: () => {
        state.watchlist = state.watchlist.filter(entry => entry !== item);
        state.monitors = state.monitors.filter(monitor => monitor.key !== key);
        clearQuote(key);
        chartHistory.delete(key);
        save();
        publish();
      } },
    ]).popup({ window: panel });
  }));
  ipcMain.on('setting', (event, key, value) => fromPanel(event, () => {
    if (key === 'interval' && intervals.includes(value)) { state.interval = value; schedule(); }
    else if (key === 'pinned' && typeof value === 'boolean') { state.pinned = value; panel.setAlwaysOnTop(value); }
    else if (key === 'redUp' && typeof value === 'boolean') state.redUp = value;
    else if (key === 'chartPeriod' && isChartPeriod(value)) {
      if (state.chartPeriod === value) return;
      state.chartPeriod = value;
    }
    else return;
    save();
    publish();
  }));
  ipcMain.on('collapse', event => fromPanel(event, showOrb));
  ipcMain.on('hide', event => fromPanel(event, hideAll));
  ipcMain.on('refresh', event => fromPanel(event, () => void refresh()));
  ipcMain.on('orb-open', event => fromOrb(event, showPanel));
  ipcMain.on('orb-menu', event => fromOrb(event, () => Menu.buildFromTemplate([
    { label: '展开看盘面板', click: showPanel },
    { label: '隐藏到托盘', click: hideAll },
    { type: 'separator' },
    { label: '退出浮窗看盘', click: () => app.quit() },
  ]).popup({ window: orb })));
  ipcMain.on('orb-down', (event, x, y) => fromOrb(event, () => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    drag = { cursor: { x, y }, bounds: orb.getBounds() };
  }));
  ipcMain.on('orb-move', event => fromOrb(event, () => {
    if (!drag) return;
    const cursor = screen.getCursorScreenPoint();
    const point = {
      x: drag.bounds.x + cursor.x - drag.cursor.x,
      y: drag.bounds.y + cursor.y - drag.cursor.y,
    };
    orb.setBounds(boundsFor(point, areaFor(cursor), iconSize, iconSize));
  }));
  ipcMain.on('orb-up', (event, moved) => fromOrb(event, () => {
    drag = null;
    if (moved) { remember(orb, 'orb'); save(); }
    else showPanel();
  }));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (panel) showPanel(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    closing = true;
    clearInterval(timer);
    activeRefresh?.abort();
    if (state) {
      if (panel?.isVisible()) remember(panel, 'panel');
      save();
    }
    tray?.destroy();
  });
  app.whenReady().then(async () => {
    statePath = path.join(app.getPath('userData'), 'marketfloat.json');
    state = load();
    quoteNetwork = session.fromPartition('marketfloat-quotes', { cache: false });
    chartNetwork = session.fromPartition('marketfloat-tradingview');
    chartNetwork.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: details.resourceType === 'mainFrame' && !isTradingViewUrl(details.url) });
    });
    chartNetwork.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    chartNetwork.setPermissionCheckHandler(() => false);
    await applyProxy(state.proxy).catch(() => {
      state.proxy = defaultProxy;
      return applyProxy(state.proxy);
    });
    panel = makeWindow({ width: panelWidth, height: panelHeight, backgroundColor: '#101724', alwaysOnTop: state.pinned }, 'panel.html');
    orb = makeWindow({
      width: iconSize, height: iconSize, transparent: true, hasShadow: false,
      skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#00000000',
    }, 'orb.html');
    panel.on('close', event => { if (!closing) { event.preventDefault(); hideAll(); } });
    orb.on('close', event => { if (!closing) { event.preventDefault(); hideAll(); } });
    panel.on('moved', () => { if (view === 'panel' && panel.isVisible()) { remember(panel, 'panel'); save(); } });
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('浮窗看盘');
    trayMenu();
    tray.on('click', showPanel);
    if (process.platform === 'win32') tray.on('balloon-click', showMonitors);
    registerIpc();
    positionPanel(false);
    if (panel.webContents.isLoading()) panel.once('ready-to-show', showPanel);
    else showPanel();
    schedule();
    void refresh();
  }).catch(error => { console.error(error); app.exit(1); });
}
