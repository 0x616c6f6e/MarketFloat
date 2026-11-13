(() => {
  const api = window.marketFloat;
  const preview = document.getElementById('chart-preview');
  const title = preview.querySelector('strong');
  const subtitle = preview.querySelector('.preview-subtitle');
  const message = preview.querySelector('.preview-message');
  const canvas = preview.querySelector('canvas');
  const summary = preview.querySelector('.preview-ohlc');
  const volumeDetails = preview.querySelector('.preview-volume');
  const quoteDetails = preview.querySelector('.preview-quote');
  const buttons = [...preview.querySelectorAll('[data-chart-period]')];
  const periods = { day: '日 K', week: '周 K', month: '月 K' };
  const prices = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });
  const volumes = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
  const pause = 700;
  let period = 'day';
  let openTimer, dismissTimer, pending;
  let active;

  function clearPending(row) {
    if (row && pending?.row !== row) return;
    clearTimeout(openTimer);
    pending = undefined;
  }

  function hide(row) {
    clearPending(row);
    if (row && active?.row !== row) return false;
    clearTimeout(dismissTimer);
    const wasVisible = !preview.hidden;
    active = undefined;
    preview.hidden = true;
    return wasVisible;
  }

  function dismissSoon() {
    if (!active) return;
    const request = active;
    clearTimeout(dismissTimer);
    // Let the pointer cross the gap from the row to the interactive preview.
    dismissTimer = setTimeout(() => {
      if (active === request) {
        active = undefined;
        preview.hidden = true;
      }
    }, 220);
  }

  function setPeriod(value) {
    if (!Object.hasOwn(periods, value) || period === value) return;
    period = value;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.chartPeriod === period));
    if (active) void show(active);
  }

  function place(row) {
    const bounds = row.getBoundingClientRect();
    const { width, height } = preview.getBoundingClientRect();
    const edge = 9;
    const gap = 6;
    const left = Math.min(window.innerWidth - width - edge, Math.max(edge, bounds.right - width));
    const preferred = bounds.bottom + gap + height <= window.innerHeight - edge ? bounds.bottom + gap : bounds.top - height - gap;
    preview.style.left = Math.max(edge, left) + 'px';
    preview.style.top = Math.max(edge, Math.min(preferred, window.innerHeight - height - edge)) + 'px';
  }

  function draw(candles, redUp) {
    const { width, height } = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const g = canvas.getContext('2d');
    g.scale(ratio, ratio);
    const plot = { left: 3, right: width - 54, top: 8, bottom: height - 63 };
    const volumeTop = plot.bottom + 12;
    const volumeBottom = height - 18;
    const maxVolume = Math.max(0, ...candles.map(item => item.volume ?? 0));
    const step = (plot.right - plot.left) / candles.length;
    const bodyWidth = Math.min(10, Math.max(2, step * 0.62));
    const rawHigh = Math.max(...candles.map(item => item.high));
    const rawLow = Math.min(...candles.map(item => item.low));
    const padding = (rawHigh - rawLow || rawHigh * 0.005) * 0.12;
    const max = rawHigh + padding;
    const min = Math.max(0, rawLow - padding);
    const y = price => plot.top + (max - price) / (max - min) * (plot.bottom - plot.top);
    g.font = '10px Inter, "Microsoft YaHei UI", "Segoe UI", sans-serif';
    g.textBaseline = 'middle';
    g.lineWidth = 1;
    for (let line = 0; line < 4; line++) {
      const price = max - (max - min) * line / 3;
      const at = Math.round(y(price)) + 0.5;
      g.strokeStyle = '#304059';
      g.beginPath();
      g.moveTo(plot.left, at);
      g.lineTo(plot.right, at);
      g.stroke();
      g.fillStyle = '#a5b5cc';
      g.fillText(prices.format(price), plot.right + 5, at, 49);
    }
    g.strokeStyle = '#304059';
    g.beginPath();
    g.moveTo(plot.left, volumeBottom + 0.5);
    g.lineTo(plot.right, volumeBottom + 0.5);
    g.stroke();
    for (const [index, bar] of candles.entries()) {
      const x = Math.round(plot.left + (index + 0.5) * step) + 0.5;
      const color = bar.close === bar.open ? '#9aadc8' : (bar.close > bar.open) === redUp ? '#ff899d' : '#74dfac';
      g.strokeStyle = g.fillStyle = color;
      g.beginPath();
      g.moveTo(x, y(bar.high));
      g.lineTo(x, y(bar.low));
      g.stroke();
      const open = y(bar.open);
      const close = y(bar.close);
      g.fillRect(x - bodyWidth / 2, Math.min(open, close), bodyWidth, Math.max(1, Math.abs(open - close)));
      if (maxVolume > 0 && bar.volume > 0) {
        const volumeHeight = Math.max(1, (volumeBottom - volumeTop) * bar.volume / maxVolume);
        g.globalAlpha = 0.65;
        g.fillRect(x - bodyWidth / 2, volumeBottom - volumeHeight, bodyWidth, volumeHeight);
        g.globalAlpha = 1;
      }
    }
    g.fillStyle = '#a5b5cc';
    g.fillText('成交量', plot.right + 5, volumeTop + 5);
    if (maxVolume > 0) g.fillText(volumes.format(maxVolume), plot.right + 5, volumeTop + 19, 49);
    const dateY = height - 6;
    const dateLabel = date => period === 'month' ? date.slice(0, 7) : date.slice(5);
    const last = dateLabel(candles.at(-1).date);
    if (candles.length > 1) g.fillText(dateLabel(candles[0].date), plot.left, dateY);
    g.fillText(last, plot.right - g.measureText(last).width, dateY);
  }

  async function show(request) {
    if (active !== request || !request.row.isConnected || !request.row.getClientRects().length) return;
    const { item, redUp } = request.read();
    if (!item) return;
    const load = { period };
    request.load = load;
    title.textContent = item.name || item.quote?.name || item.code;
    subtitle.textContent = item.code + ' · ' + item.currency;
    const quoteTime = item.quote?.marketTime || (item.quote?.readAt ? new Date(item.quote.readAt).toLocaleString('zh-CN') : '');
    quoteDetails.textContent = [
      '报价 · ' + item.source, item.error || quoteTime,
    ].filter(Boolean).join(' · ');
    quoteDetails.classList.toggle('preview-error', Boolean(item.error));
    canvas.hidden = summary.hidden = true;
    volumeDetails.textContent = '';
    message.hidden = false;
    message.textContent = '正在加载' + periods[period] + '…';
    preview.hidden = false;
    place(request.row);
    const result = await api.chartPreview(item.key, period).catch(() => ({ error: '暂时无法加载 K 线。' }));
    if (active !== request || request.load !== load) return;
    if (!result?.candles?.length) {
      message.textContent = result?.error ?? '暂无 K 线数据。';
      return;
    }
    subtitle.textContent = [
      item.code, item.currency, result.source, result.adjusted && '前复权', result.candles.length + ' 根',
    ].filter(Boolean).join(' · ');
    message.hidden = true;
    canvas.hidden = summary.hidden = false;
    const last = result.candles.at(-1);
    const values = [last.open, last.high, last.low, last.close].map(prices.format);
    for (const [i, label] of [...summary.children].entries()) {
      label.textContent = ['开', '高', '低', '收'][i] + ' ' + values[i];
    }
    const unit = ['股', '手'].includes(result.volumeUnit) ? result.volumeUnit : ' ' + (result.volumeUnit ?? '');
    volumeDetails.textContent = '成交量 ' + (Number.isFinite(last.volume) ? volumes.format(last.volume) + unit : '—');
    canvas.setAttribute('aria-label', last.date + ' ' + periods[period] + '。' +
      [...summary.children].map(label => label.textContent).concat(volumeDetails.textContent).join('，'));
    draw(result.candles, redUp);
  }

  function attach(row, read) {
    const start = event => {
      if (event.pointerType === 'touch' || document.querySelector('dialog[open]')) return;
      clearPending();
      if (active?.row === row) { clearTimeout(dismissTimer); return; }
      const request = { row, read };
      pending = request;
      openTimer = setTimeout(() => {
        if (pending !== request) return;
        pending = undefined;
        clearTimeout(dismissTimer);
        active = request;
        void show(request);
      }, pause);
    };
    row.tabIndex = 0;
    row.addEventListener('pointerenter', start);
    row.addEventListener('pointerleave', () => {
      clearPending(row);
      if (active?.row === row) dismissSoon();
    });
    row.addEventListener('dblclick', event => { if (!event.target.closest('button')) open(read); });
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target === row) { event.preventDefault(); open(read); }
    });
  }

  function open(read) {
    const { item } = read();
    hide();
    if (item) api.openChart(item.key);
  }

  preview.addEventListener('pointerenter', () => { clearPending(); clearTimeout(dismissTimer); });
  preview.addEventListener('pointerleave', () => dismissSoon());
  preview.addEventListener('dblclick', event => {
    if (active && !event.target.closest('button')) open(active.read);
  });
  for (const button of buttons) {
    button.addEventListener('click', () => {
      setPeriod(button.dataset.chartPeriod);
      api.setting('chartPeriod', period);
    });
  }
  document.getElementById('watchlist').addEventListener('scroll', () => hide());
  document.addEventListener('pointerdown', event => { if (!preview.contains(event.target)) hide(); });
  window.addEventListener('blur', () => hide());
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  window.chartPreview = { attach, hide, setPeriod };
})();
