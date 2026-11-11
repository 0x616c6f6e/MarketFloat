(() => {
  const api = window.marketFloat;
  const preview = document.getElementById('chart-preview');
  const title = preview.querySelector('strong');
  const subtitle = preview.querySelector('.preview-subtitle');
  const message = preview.querySelector('.preview-message');
  const canvas = preview.querySelector('canvas');
  const summary = preview.querySelector('.preview-ohlc');
  const quoteDetails = preview.querySelector('.preview-quote');
  const prices = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });
  const pause = 700;
  let timer;
  let active;

  function hide(row) {
    if (row && active?.row !== row) return;
    clearTimeout(timer);
    active = undefined;
    preview.hidden = true;
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
    const plot = { left: 3, right: width - 54, top: 8, bottom: height - 19 };
    const step = (plot.right - plot.left) / candles.length;
    const bodyWidth = Math.min(10, Math.max(2, step * 0.62));
    const rawHigh = Math.max(...candles.map(item => item.high));
    const rawLow = Math.min(...candles.map(item => item.low));
    const padding = (rawHigh - rawLow || rawHigh * 0.005) * 0.12;
    const max = rawHigh + padding;
    const min = Math.max(0, rawLow - padding);
    const y = price => plot.top + (max - price) / (max - min) * (plot.bottom - plot.top);
    g.font = '10px Inter, "Segoe UI", sans-serif';
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
    }
    g.fillStyle = '#a5b5cc';
    const dateY = height - 6;
    const last = candles.at(-1).date.slice(5);
    if (candles.length > 1) g.fillText(candles[0].date.slice(5), plot.left, dateY);
    g.fillText(last, plot.right - g.measureText(last).width, dateY);
  }

  async function show(request) {
    if (active !== request || !request.row.isConnected || !request.row.getClientRects().length) return;
    const { item, redUp } = request.read();
    if (!item) return;
    title.textContent = (item.name || item.quote?.name || item.code) + ' · 日 K';
    subtitle.textContent = item.code + ' · ' + item.currency;
    const quoteTime = item.quote?.marketTime || (item.quote?.readAt ? new Date(item.quote.readAt).toLocaleString('zh-CN') : '');
    quoteDetails.textContent = [
      '报价 · ' + item.source, item.error || quoteTime,
    ].filter(Boolean).join(' · ');
    quoteDetails.classList.toggle('preview-error', Boolean(item.error));
    quoteDetails.hidden = false;
    canvas.hidden = summary.hidden = true;
    message.hidden = false;
    message.textContent = '正在加载日 K…';
    preview.hidden = false;
    place(request.row);
    const result = await api.chartPreview(item.key).catch(() => ({ error: '暂时无法加载日 K。' }));
    if (active !== request) return;
    if (!result?.candles?.length) {
      message.textContent = result?.error ?? '暂无日 K 数据。';
      place(request.row);
      return;
    }
    subtitle.textContent = [
      item.code, item.currency, result.source, result.adjusted && '前复权', result.candles.length + ' 根',
    ].filter(Boolean).join(' · ');
    quoteDetails.hidden = !item.error && !quoteTime;
    message.hidden = true;
    canvas.hidden = summary.hidden = false;
    const last = result.candles.at(-1);
    const values = [last.open, last.high, last.low, last.close].map(prices.format);
    for (const [i, label] of [...summary.children].entries()) {
      label.textContent = ['开', '高', '低', '收'][i] + ' ' + values[i];
    }
    canvas.setAttribute('aria-label', last.date + ' 日 K。' + [...summary.children].map(label => label.textContent).join('，'));
    place(request.row);
    draw(result.candles, redUp);
  }

  function attach(row, read) {
    const start = event => {
      if (event.pointerType === 'touch' || document.querySelector('dialog[open]')) return;
      hide();
      const request = { row, read };
      active = request;
      timer = setTimeout(() => void show(request), pause);
    };
    const open = () => {
      hide();
      const { item } = read();
      if (item) api.openChart(item.key);
    };
    row.tabIndex = 0;
    row.addEventListener('pointerenter', start);
    row.addEventListener('pointerleave', () => hide(row));
    row.addEventListener('dblclick', event => { if (!event.target.closest('button')) open(); });
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target === row) { event.preventDefault(); open(); }
    });
  }

  document.getElementById('watchlist').addEventListener('scroll', () => hide());
  document.addEventListener('pointerdown', () => hide());
  window.addEventListener('blur', () => hide());
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  window.chartPreview = { attach, hide };
})();
