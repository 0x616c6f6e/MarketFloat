const { app, BrowserWindow, Tray, Menu, ipcMain, screen, net, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { symbol, defaults, getQuotes } = require('./quotes.cjs');

const iconPath = path.join(__dirname, 'MarketFloat.ico');
const iconSize = 62;
const panelWidth = 464;
const panelHeight = 670;
const intervals = [15, 30, 60];
let panel, orb, tray, state, drag, timer, statePath;
let view = 'panel';
let closing = false;
let refreshing = false;
let pending = false;
let updatedAt = 0;
let saveFailed = false;
const errors = new Map();
const current = new Set();
const history = new Map();

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
  return {
    watchlist, cached, interval: intervals.includes(saved?.interval) ? saved.interval : 30,
    pinned: saved?.pinned !== false, redUp: saved?.redUp !== false,
    panel: saved?.panel, orb: saved?.orb,
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
      ...item, quote: state.cached[item.key] ?? null, samples: history.get(item.key) ?? [],
      cached: !current.has(item.key) && Boolean(state.cached[item.key]), error: errors.get(item.key),
    })),
    interval: state.interval, pinned: state.pinned, redUp: state.redUp, refreshing, updatedAt,
    errors: errors.size, current: current.size, saveFailed,
  };
}

function publish() {
  if (panel && !panel.isDestroyed()) panel.webContents.send('state', snapshot());
}

async function refresh({ forceAgain = false } = {}) {
  if (refreshing) { pending ||= forceAgain; return; }
  if (!state.watchlist.length || closing) return;
  refreshing = true;
  publish();
  try {
    const requested = state.watchlist.slice();
    const result = await getQuotes(net.fetch, requested);
    if (closing) return;
    let received = false;
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
      const series = history.get(item.key) ?? [];
      history.set(item.key, [...series.slice(-31), response.quote.price]);
    }
    if (received) { updatedAt = Date.now(); save(); }
  } finally {
    refreshing = false;
    if (!closing) publish();
    if (pending) { pending = false; void refresh(); }
  }
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
    { label: '退出浮窗看盘', click: () => app.quit() },
  ]));
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
    Menu.buildFromTemplate([{ label: '移出自选 · ' + item.code, click: () => {
      state.watchlist = state.watchlist.filter(entry => entry !== item);
      delete state.cached[key];
      current.delete(key);
      errors.delete(key);
      history.delete(key);
      save();
      publish();
    } }]).popup({ window: panel });
  }));
  ipcMain.on('setting', (event, key, value) => fromPanel(event, () => {
    if (key === 'interval' && intervals.includes(value)) { state.interval = value; schedule(); }
    else if (key === 'pinned' && typeof value === 'boolean') { state.pinned = value; panel.setAlwaysOnTop(value); }
    else if (key === 'redUp' && typeof value === 'boolean') state.redUp = value;
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
    if (state) {
      if (panel?.isVisible()) remember(panel, 'panel');
      save();
    }
    tray?.destroy();
  });
  app.whenReady().then(() => {
    statePath = path.join(app.getPath('userData'), 'marketfloat.json');
    state = load();
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
    registerIpc();
    positionPanel(false);
    if (panel.webContents.isLoading()) panel.once('ready-to-show', showPanel);
    else showPanel();
    schedule();
    void refresh();
  }).catch(error => { console.error(error); app.exit(1); });
}
