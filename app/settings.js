(() => {
  const api = window.marketFloat;
  const $ = id => document.getElementById(id);
  const tabs = [...document.querySelectorAll('[data-setting-tab]')];
  const sources = {
    cn: { example: '600519', description: '腾讯财经 · 涨跌幅相对昨收。' },
    us: { example: 'AAPL', description: '腾讯财经 · 涨跌幅相对昨收，报价可能延迟。' },
    usd: { example: 'BTC-USD', description: 'Coinbase · 24 小时涨跌幅。' },
    usdt: { example: 'BTC-USDT', description: 'Binance · 24 小时涨跌幅。' },
  };
  const fields = ['url', 'price', 'change', 'previous', 'name'];
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  let state;
  let selectedTab = 'source';
  let editing = '';
  let lastSource, lastProxy, lastMonitors;

  function status(id, message, error = false) {
    const element = $(id);
    element.textContent = message;
    element.classList.toggle('error', error);
  }

  async function action(buttons, statusId, operation, success) {
    buttons.forEach(button => { button.disabled = true; });
    status(statusId, '正在处理…');
    try {
      const result = await operation();
      if (result?.error) status(statusId, result.error, true);
      else status(statusId, success(result));
      return !result?.error;
    } catch {
      status(statusId, '操作未完成，请重试。', true);
      return false;
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  function selectTab(tab) {
    selectedTab = tab;
    for (const button of tabs) {
      const name = button.dataset.settingTab;
      button.setAttribute('aria-pressed', String(name === tab));
      $('settings-' + name).hidden = name !== tab;
    }
    $('settings-page').querySelector('.settings-body').scrollTop = 0;
  }

  function open(tab = selectedTab) {
    $('watch-page').hidden = true;
    $('watch-footer').hidden = true;
    $('settings-page').hidden = false;
    $('settings-button').setAttribute('aria-expanded', 'true');
    selectTab(tab);
  }

  function close(focus = false) {
    if ($('settings-page').hidden) return;
    $('settings-page').hidden = true;
    $('watch-page').hidden = false;
    $('watch-footer').hidden = false;
    $('settings-button').setAttribute('aria-expanded', 'false');
    if (focus) $('settings-button').focus();
  }

  function renderSourceMode() {
    const custom = $('source-mode').value === 'custom';
    $('source-custom').hidden = !custom;
    $('source-info').hidden = custom;
    $('source-info').textContent = sources[$('source-group').value].description;
  }

  function renderSource() {
    const group = $('source-group').value;
    const source = state?.sources[group];
    const signature = JSON.stringify([group, source]);
    if (signature === lastSource) return;
    lastSource = signature;
    $('source-mode').value = source ? 'custom' : 'builtin';
    fields.forEach(field => { $('source-' + field).value = source?.[field] ?? ''; });
    $('source-test-code').value = '';
    $('source-test-code').placeholder = sources[group].example;
    renderSourceMode();
  }

  function sourceInput() {
    if ($('source-mode').value === 'builtin') return null;
    return Object.fromEntries(fields.map(field => [field, $('source-' + field).value]));
  }

  function proxyMode() {
    $('proxy-manual').hidden = $('proxy-mode').value !== 'fixed_servers';
  }

  function renderProxy() {
    const signature = JSON.stringify(state.proxy);
    if (signature === lastProxy) return;
    lastProxy = signature;
    $('proxy-mode').value = state.proxy.mode;
    $('proxy-address').value = state.proxy.address;
    proxyMode();
  }

  function monitorCurrency() {
    const item = state?.items.find(item => item.key === $('monitor-symbol').value);
    $('monitor-currency').textContent = item?.currency ?? '';
  }

  function resetMonitorForm() {
    editing = '';
    $('monitor-threshold').value = '';
    $('monitor-submit').textContent = '添加提醒';
    $('monitor-cancel').hidden = true;
  }

  function editMonitor(monitor) {
    editing = monitor.id;
    $('monitor-symbol').value = monitor.key;
    $('monitor-direction').value = monitor.direction;
    $('monitor-threshold').value = monitor.threshold;
    $('monitor-submit').textContent = '保存规则';
    $('monitor-cancel').hidden = false;
    status('monitor-status', '');
    monitorCurrency();
    $('monitor-threshold').focus();
  }

  function renderMonitors() {
    const items = state.items.map(item => ({
      key: item.key, code: item.code, currency: item.currency, name: item.name || item.quote?.name,
    }));
    const signature = JSON.stringify([items, state.monitors]);
    if (signature === lastMonitors) return;
    lastMonitors = signature;
    const select = $('monitor-symbol');
    const selected = select.value;
    select.replaceChildren(...items.map(item => {
      const name = item.name && item.name !== item.code ? item.name + ' · ' + item.code : item.code;
      return new Option(name, item.key);
    }));
    if (items.some(item => item.key === selected)) select.value = selected;
    if (!items.length) select.add(new Option('请先添加自选标的', ''));
    select.disabled = !items.length;
    $('monitor-submit').disabled = !items.length;
    monitorCurrency();
    if (editing && !state.monitors.some(monitor => monitor.id === editing)) resetMonitorForm();

    $('monitor-count').textContent = state.monitors.filter(monitor => monitor.enabled).length + ' 条启用';
    const list = $('monitor-list');
    list.replaceChildren();
    if (!state.monitors.length) {
      const empty = document.createElement('li');
      empty.className = 'rule-empty';
      empty.textContent = '暂无提醒规则';
      list.append(empty);
    }
    for (const monitor of state.monitors) {
      const item = items.find(item => item.key === monitor.key);
      if (!item) continue;
      const row = $('monitor-row').content.firstElementChild.cloneNode(true);
      const comparator = monitor.direction === 'above' ? '≥' : '≤';
      row.querySelector('.rule-name').textContent = item.code + ' ' + comparator + ' ' + monitor.threshold + ' ' + item.currency;
      const badge = row.querySelector('.rule-status');
      badge.textContent = !monitor.enabled ? '已停用' : monitor.matched ? '已触发' : '待触发';
      badge.classList.toggle('triggered', monitor.enabled && monitor.matched);
      row.querySelector('.rule-trigger').textContent = monitor.triggeredAt
        ? '最近触发 ' + dateFormat.format(monitor.triggeredAt) + ' · ' + monitor.triggeredPrice + ' ' + item.currency
        : '尚未触发';
      row.querySelector('[data-rule-action="toggle"]').textContent = monitor.enabled ? '停用' : '启用';
      row.querySelector('.rule-actions').addEventListener('click', event => {
        const button = event.target.closest('[data-rule-action]');
        if (!button) return;
        const operation = button.dataset.ruleAction;
        if (operation === 'edit') { editMonitor(monitor); return; }
        const change = operation === 'remove' ? 'remove' : monitor.enabled ? 'disable' : 'enable';
        void action([button], 'monitor-status', () => api.updateMonitor(monitor.id, change),
          () => ({ remove: '规则已删除。', disable: '规则已停用。', enable: '规则已启用。' })[change]);
      });
      list.append(row);
    }
  }

  function update(value) {
    state = value;
    renderSource();
    renderProxy();
    renderMonitors();
  }

  $('settings-button').addEventListener('click', () => $('settings-page').hidden ? open() : close(true));
  $('settings-back').addEventListener('click', () => close(true));
  tabs.forEach(button => button.addEventListener('click', () => selectTab(button.dataset.settingTab)));
  $('source-group').addEventListener('change', () => { renderSource(); status('source-status', ''); });
  $('source-mode').addEventListener('change', () => { renderSourceMode(); status('source-status', ''); });
  const sourceButtons = [$('source-test'), $('source-form').querySelector('[type="submit"]'), $('source-group'), $('source-mode')];
  $('source-test').addEventListener('click', () => void action(sourceButtons, 'source-status',
    () => api.testSource($('source-group').value, sourceInput(), $('source-test-code').value),
    result => result.code + ' · ' + result.price + ' ' + result.currency +
      (Number.isFinite(result.change) ? ' · ' + result.change.toFixed(2) + '%' : '')));
  $('source-form').addEventListener('submit', event => {
    event.preventDefault();
    if (sourceButtons[1].disabled) return;
    void action(sourceButtons, 'source-status', () => api.saveSource($('source-group').value, sourceInput()), () => '来源已保存。');
  });
  $('proxy-mode').addEventListener('change', () => { proxyMode(); status('proxy-status', ''); });
  $('proxy-form').addEventListener('submit', event => {
    event.preventDefault();
    const submit = $('proxy-form').querySelector('[type="submit"]');
    if (submit.disabled) return;
    void action([submit, $('proxy-mode'), $('proxy-address')], 'proxy-status',
      () => api.saveProxy({ mode: $('proxy-mode').value, address: $('proxy-address').value }), () => '代理已保存。');
  });
  $('monitor-symbol').addEventListener('change', monitorCurrency);
  $('monitor-cancel').addEventListener('click', () => { resetMonitorForm(); status('monitor-status', ''); });
  $('monitor-form').addEventListener('submit', async event => {
    event.preventDefault();
    if ($('monitor-submit').disabled) return;
    const saved = await action([$('monitor-submit')], 'monitor-status', () => api.saveMonitor({
      id: editing, key: $('monitor-symbol').value, direction: $('monitor-direction').value, threshold: $('monitor-threshold').value,
    }), () => '提醒规则已保存。');
    if (saved) resetMonitorForm();
  });
  $('settings-general').addEventListener('change', event => {
    if (event.target.id === 'pinned') api.setting('pinned', event.target.checked);
    if (event.target.id === 'red-up') api.setting('redUp', event.target.checked);
    if (event.target.id === 'interval') api.setting('interval', Number(event.target.value));
  });
  api.onOpenSettings(tab => open(tab));
  window.marketFloatSettings = { update, close };
})();
