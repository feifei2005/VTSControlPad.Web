/* 界面逻辑：连接管理、三块列表渲染、参数注入、多语言、关于页。 */
(function () {
  'use strict';

  var APP_HOMEPAGE = 'https://github.com/feifei2005';
  var POLL_INTERVAL = 1000;    // 原版每 0.5s 轮询一次，这里放宽到 1s
  var INJECT_INTERVAL = 33;    // 约 30Hz，替代原版跟随渲染帧（60/120fps）发送
  var RECONNECT_DELAY = 3000;
  var MAX_RECONNECT = 5;

  var ORIGINAL_LINKS = [
    ['Bilibili', 'https://space.bilibili.com/1306433'],
    ['Twitter', 'https://mobile.twitter.com/xiaoye1997'],
    ['GitHub', 'https://github.com/xiaoye97'],
    ['Afdian', 'https://afdian.net/@xiaoye97'],
    ['itch.io', 'https://xiaoye1997.itch.io/']
  ];

  var el = function (id) { return document.getElementById(id); };
  var content = function (name) { return document.querySelector('[data-content="' + name + '"]'); };

  var state = {
    settings: null,
    client: null,
    conn: 'disconnected',      // disconnected | connecting | connected | error
    endpoint: '',
    model: null,
    lastModelID: null,
    folds: { hotkey: true, expression: true, parameter: true },
    hotkeys: [],
    expressions: [],
    params: [],
    injectBusy: false,
    pollBusy: false,
    pollTimer: null,
    injectTimer: null,
    reconnectTimer: null,
    reconnectLeft: 0,
    connecting: false,
    notice: '',
    lastError: ''
  };

  var hotkeyNodes = {};   // hotkeyID -> element
  var exprNodes = {};     // file -> {row, nameEl, sw, active}
  var paramNodes = {};    // name -> {row, nameEl, sw, rangeEl, minEl, maxEl, min, max, value, send}

  /* ---------------- 基础工具 ---------------- */

  function log(msg) {
    try { console.log('[vts] ' + msg); } catch (e) {}
    var fn = window.hostLog;
    if (typeof fn === 'function') { try { fn(String(msg)); } catch (e) {} }
  }

  /* 调用宿主绑定；宿主若报错，promise 会以字符串原因被 reject。 */
  function hostCall(name) {
    var fn = window[name];
    if (typeof fn !== 'function') return Promise.resolve(null);
    var args = Array.prototype.slice.call(arguments, 1);
    return fn.apply(null, args).catch(function (err) {
      log('宿主调用 ' + name + ' 失败: ' + ((err && err.message) || String(err)));
      return null;
    });
  }

  function fmt(n) {
    var v = Number(n);
    if (!isFinite(v)) return '0';
    return Math.abs(v) < 1 ? v.toFixed(2) : String(Math.round(v * 100) / 100);
  }

  function clamp(v, min, max) {
    if (!isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  /* ---------------- 连接状态 ---------------- */

  function setConn(next) {
    state.conn = next;
    var colors = { disconnected: 'gray', connecting: 'yellow', connected: 'green', error: 'red' };
    el('light').className = 'light ' + (colors[next] || 'gray');
    el('connText').textContent = t('conn.' + next);
    el('btnConnect').textContent = (next === 'disconnected' || next === 'error') ? t('btn.connect') : t('btn.disconnect');
    refreshChrome();
  }

  function refreshChrome() {
    var connected = state.conn === 'connected';
    var modelLoaded = !!(state.model && state.model.modelLoaded);

    el('blocks').classList.toggle('hidden', !(connected && modelLoaded));

    var tip = el('waitTip');
    if (connected && modelLoaded) {
      tip.classList.add('hidden');
      return;
    }
    tip.classList.remove('hidden');
    tip.textContent = tipText();
  }

  function tipText() {
    if (state.notice) return state.notice;
    if (state.conn === 'error') return t('tip.error') + '：' + (state.lastError || '');
    if (state.conn === 'connected') return t('tip.noModel');
    return t('tip.wait');
  }

  /* ---------------- 连接流程 ---------------- */

  function connect(endpoint) {
    if (state.connecting) return;
    clearTimeout(state.reconnectTimer);
    state.connecting = true;
    state.notice = '';
    state.lastError = '';
    state.endpoint = endpoint;
    el('endpoint').value = endpoint;
    setConn('connecting');

    teardownClient().then(function () {
      var c = new VTSClient({
        pluginName: state.settings.pluginName,
        pluginDeveloper: state.settings.developer,
        log: log
      });
      c.onClose = function () {
        log('与 VTS 的连接已断开');
        stopPolling();
        setConn('disconnected');
        scheduleReconnect();
      };
      state.client = c;

      return c.open(endpoint).then(function () {
        return c.authenticate(
          function () { return state.settings.token; },
          function (token) { state.settings.token = token; saveSettings(); }
        );
      }).then(function () {
        if (state.client !== c) return;
        state.reconnectLeft = MAX_RECONNECT;
        state.settings.endpoint = endpoint;
        saveSettings();
        setConn('connected');
        startPolling();
        return poll();
      }).catch(function (err) {
        var message = (err && err.message) || String(err);
        log('连接失败: ' + message);
        state.lastError = message;
        state.notice = '';
        c.close();
        if (state.client === c) state.client = null;
        setConn('error');
      });
    }).then(function () {
      state.connecting = false;
    });
  }

  function teardownClient() {
    stopPolling();
    stopInjection();
    var c = state.client;
    state.client = null;
    if (!c) return Promise.resolve();
    c.onClose = null;
    c.close();
    return Promise.resolve();
  }

  function disconnect() {
    state.reconnectLeft = 0;
    clearTimeout(state.reconnectTimer);
    log('用户主动断开');
    return teardownClient().then(function () {
      state.model = null;
      state.lastModelID = null;
      state.notice = '';
      state.lastError = '';
      setConn('disconnected');
    });
  }

  function scheduleReconnect() {
    if (state.reconnectLeft <= 0 || state.connecting) return;
    state.reconnectLeft -= 1;
    log('将在 ' + (RECONNECT_DELAY / 1000) + 's 后重连（剩余 ' + state.reconnectLeft + ' 次）');
    state.reconnectTimer = setTimeout(function () {
      connect(state.endpoint);
    }, RECONNECT_DELAY);
  }

  /* ---------------- 轮询 ---------------- */

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(poll, POLL_INTERVAL);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function poll() {
    var c = state.client;
    if (!c || !c.authenticated || state.pollBusy) return Promise.resolve();
    state.pollBusy = true;

    return c.getCurrentModel().then(function (res) {
      var d = res.data || {};
      state.model = d;
      el('modelName').textContent = d.modelLoaded ? (d.modelName || d.modelID || '--') : t('conn.noModel');

      var changed = d.modelID !== state.lastModelID;
      state.lastModelID = d.modelID;
      refreshChrome();
      if (!d.modelLoaded) return null;

      if (changed) expandAll();

      var jobs = [];
      if (state.folds.hotkey) jobs.push(refreshHotkeys(d.modelID));
      if (state.folds.expression) jobs.push(refreshExpressions());
      if (state.folds.parameter) jobs.push(refreshParams());
      return Promise.all(jobs);
    }).catch(function () {
      /* 单次轮询失败不改变连接状态，等下一轮 */
      return null;
    }).then(function () {
      state.pollBusy = false;
    });
  }

  function refreshHotkeys(modelID) {
    return state.client.getHotkeys(modelID).then(function (res) {
      var list = (res.data && res.data.availableHotkeys) || [];
      state.hotkeys = list;
      renderHotkeys(list);
    }).catch(function () { return null; });
  }

  function refreshExpressions() {
    return state.client.getExpressions().then(function (res) {
      var list = (res.data && res.data.expressions) || [];
      state.expressions = list;
      renderExpressions(list);
    }).catch(function () { return null; });
  }

  function refreshParams() {
    return state.client.getInputParameterList().then(function (res) {
      var d = res.data || {};
      var list = (d.defaultParameters || []).concat(d.customParameters || []);
      state.params = list;
      renderParams(list);
    }).catch(function () { return null; });
  }

  function expandAll() {
    state.folds.hotkey = true;
    state.folds.expression = true;
    state.folds.parameter = true;
    var blocks = document.querySelectorAll('.block');
    for (var i = 0; i < blocks.length; i++) blocks[i].classList.remove('closed');
  }

  /* ---------------- 列表渲染（增量，避免整表重建） ---------------- */

  function setCount(name, n) {
    var node = document.querySelector('[data-count="' + name + '"]');
    if (node) node.textContent = n > 0 ? String(n) : '';
  }

  function setEmpty(box, isEmpty, key) {
    var exist = box.querySelector('.empty');
    if (!isEmpty) {
      if (exist) exist.remove();
      return;
    }
    if (!exist) {
      var node = document.createElement('div');
      node.className = 'empty';
      box.appendChild(node);
    }
    box.querySelector('.empty').textContent = t(key);
  }

  function hotkeyLabel(h) {
    if (h.name && String(h.name).trim()) return String(h.name);
    if (h.file && String(h.file).trim()) return String(h.file);
    return h.hotkeyID;
  }

  function renderHotkeys(list) {
    var box = content('hotkey');
    var seen = {};
    list.forEach(function (h) {
      var id = h.hotkeyID;
      seen[id] = true;
      if (hotkeyNodes[id]) {
        hotkeyNodes[id].textContent = hotkeyLabel(h);
        return;
      }
      var btn = document.createElement('button');
      btn.className = 'item';
      btn.textContent = hotkeyLabel(h);
      btn.onclick = function () {
        btn.disabled = true;
        state.client.triggerHotkey(id).catch(function (err) {
          log('触发热键失败: ' + ((err && err.message) || String(err)));
        }).then(function () { btn.disabled = false; });
      };
      hotkeyNodes[id] = btn;
      box.appendChild(btn);
    });
    Object.keys(hotkeyNodes).forEach(function (id) {
      if (!seen[id]) {
        hotkeyNodes[id].remove();
        delete hotkeyNodes[id];
      }
    });
    setCount('hotkey', list.length);
    setEmpty(box, list.length === 0, 'empty.hotkey');
  }

  function renderExpressions(list) {
    var box = content('expression');
    var seen = {};
    list.forEach(function (e) {
      var file = e.file || e.name;
      if (!file || seen[file]) return;
      seen[file] = true;

      var node = exprNodes[file];
      if (!node) {
        var row = document.createElement('div');
        row.className = 'item';
        var nameEl = document.createElement('span');
        nameEl.className = 'item-name';
        var sw = document.createElement('button');
        sw.className = 'switch';
        row.appendChild(nameEl);
        row.appendChild(sw);
        node = { row: row, nameEl: nameEl, sw: sw, active: false };
        sw.onclick = function () {
          var target = !node.active;
          node.active = target;
          sw.classList.toggle('on', target);
          state.client.activateExpression(file, target).catch(function (err) {
            node.active = !target;
            sw.classList.toggle('on', node.active);
            log('切换表情失败: ' + ((err && err.message) || String(err)));
          });
        };
        exprNodes[file] = node;
        box.appendChild(row);
      }
      node.nameEl.textContent = e.name || file;
      node.active = !!e.active;
      node.sw.classList.toggle('on', node.active);
    });
    Object.keys(exprNodes).forEach(function (file) {
      if (!seen[file]) {
        exprNodes[file].row.remove();
        delete exprNodes[file];
      }
    });
    setCount('expression', Object.keys(seen).length);
    setEmpty(box, Object.keys(seen).length === 0, 'empty.expression');
  }

  function renderParams(list) {
    var box = content('parameter');
    var seen = {};
    list.forEach(function (p) {
      var name = p.name;
      if (!name || seen[name]) return;
      seen[name] = true;

      var node = paramNodes[name];
      if (!node) {
        var row = document.createElement('div');
        row.className = 'param';

        var head = document.createElement('div');
        head.className = 'param-head';
        var nameEl = document.createElement('span');
        nameEl.className = 'param-name';
        var sw = document.createElement('button');
        sw.className = 'switch';
        head.appendChild(nameEl);
        head.appendChild(sw);

        var body = document.createElement('div');
        body.className = 'param-body';
        var minEl = document.createElement('span');
        minEl.className = 'param-range';
        var rangeEl = document.createElement('input');
        rangeEl.type = 'range';
        var maxEl = document.createElement('span');
        maxEl.className = 'param-range';
        body.appendChild(minEl);
        body.appendChild(rangeEl);
        body.appendChild(maxEl);

        row.appendChild(head);
        row.appendChild(body);

        node = {
          row: row, nameEl: nameEl, sw: sw, rangeEl: rangeEl, minEl: minEl, maxEl: maxEl,
          min: 0, max: 1, value: 0, send: false
        };
        sw.onclick = function () {
          node.send = !node.send;
          sw.classList.toggle('on', node.send);
        };
        rangeEl.oninput = function () {
          node.value = Number(rangeEl.value);
        };
        paramNodes[name] = node;
        box.appendChild(row);
      }

      node.nameEl.textContent = name;
      node.min = Number(p.min);
      node.max = Number(p.max);
      node.rangeEl.min = String(p.min);
      node.rangeEl.max = String(p.max);
      node.rangeEl.step = String((node.max - node.min) / 1000 || 0.001);
      node.minEl.textContent = fmt(p.min);
      node.maxEl.textContent = fmt(p.max);

      /* 与原版一致：开关打开时不再被服务端刷新，避免把用户拖动的值覆盖掉。 */
      if (!node.send) {
        node.value = clamp(Number(p.value), node.min, node.max);
        node.rangeEl.value = String(node.value);
      }

      if (!node.sw.title) node.sw.title = '';
    });
    Object.keys(paramNodes).forEach(function (name) {
      if (!seen[name]) {
        paramNodes[name].row.remove();
        delete paramNodes[name];
      }
    });
    setCount('parameter', Object.keys(seen).length);
    setEmpty(box, Object.keys(seen).length === 0, 'empty.parameter');
  }

  /* ---------------- 参数注入 ---------------- */

  function startInjection() {
    stopInjection();
    state.injectTimer = setInterval(injectTick, INJECT_INTERVAL);
  }

  function stopInjection() {
    if (state.injectTimer) {
      clearInterval(state.injectTimer);
      state.injectTimer = null;
    }
    state.injectBusy = false;
  }

  function injectTick() {
    var c = state.client;
    if (!c || !c.authenticated || state.injectBusy) return;

    var values = [];
    Object.keys(paramNodes).forEach(function (name) {
      var node = paramNodes[name];
      if (!node.send) return;
      values.push({ id: sanitizeParameterName(name), value: node.value, weight: 1 });
    });
    if (values.length === 0) return;

    state.injectBusy = true;
    c.injectParameters(values, 'add').catch(function (err) {
      log('参数注入失败: ' + ((err && err.message) || String(err)));
    }).then(function () {
      state.injectBusy = false;
    });
  }

  /* ---------------- 多语言 / 关于 ---------------- */

  function applyLang() {
    document.documentElement.lang = LANG;
    applyI18n(document);
    el('btnLang').textContent = LANG === 'zh' ? 'EN' : '中';
    buildAbout();
    setConn(state.conn);
    rebuildLists();
  }

  /* 列表项里有需要翻译的文案（触发按钮、空态），切语言时清空重建。 */
  function rebuildLists() {
    ['hotkey', 'expression', 'parameter'].forEach(function (name) {
      var box = content(name);
      box.textContent = '';
    });
    hotkeyNodes = {};
    exprNodes = {};
    paramNodes = {};
    state.hotkeys = [];
    state.expressions = [];
    state.params = [];
    setCount('hotkey', 0);
    setCount('expression', 0);
    setCount('parameter', 0);
    poll();
  }

  function buildAbout() {
    el('aboutDesc').textContent = t('about.desc');

    var wrap = el('aboutLinks');
    wrap.textContent = '';

    wrap.appendChild(groupLabel(t('about.originalAuthor')));
    ORIGINAL_LINKS.forEach(function (pair) { wrap.appendChild(link(pair[0], pair[1])); });

    wrap.appendChild(groupLabel(t('about.rewrittenBy')));
    wrap.appendChild(link('GitHub · feifei2005', APP_HOMEPAGE));

    var note = document.createElement('div');
    note.className = 'link-group';
    note.textContent = t('about.rewriteNote');
    wrap.appendChild(note);
  }

  function groupLabel(text) {
    var node = document.createElement('div');
    node.className = 'link-group';
    node.textContent = text;
    return node;
  }

  function link(text, url) {
    var a = document.createElement('a');
    a.textContent = text;
    a.onclick = function () {
      hostCall('hostOpenURL', url);
      return false;
    };
    return a;
  }

  /* ---------------- 设置 ---------------- */

  function saveSettings() {
    return hostCall('hostSaveSettings', state.settings);
  }

  function mergeSettings(loaded) {
    var base = {
      token: '',
      endpoint: '',
      language: 'zh',
      pluginName: 'ControlPad_Web',
      developer: 'feifei2005'
    };
    var src = loaded || {};
    Object.keys(base).forEach(function (k) {
      if (src[k]) base[k] = src[k];
    });
    return base;
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    el('btnConnect').onclick = function () {
      if (state.conn === 'disconnected' || state.conn === 'error' || state.conn === 'connecting') {
        state.reconnectLeft = MAX_RECONNECT;
        connect(el('endpoint').value.trim() || '127.0.0.1:8001');
      } else {
        disconnect();
      }
    };

    el('btnDiscover').onclick = function () {
      state.notice = t('tip.wait');
      var btn = el('btnDiscover');
      btn.disabled = true;
      btn.textContent = '…';
      hostCall('hostDiscover').then(function (list) {
        btn.disabled = false;
        btn.textContent = t('btn.discover');
        var found = (list || []).filter(function (x) { return x && x.port; });
        if (found.length === 0) {
          state.notice = t('tip.notFound');
          refreshChrome();
          return;
        }
        var target = found[0].ip + ':' + found[0].port;
        log('发现 VTS 实例: ' + target + '（' + (found[0].windowTitle || '') + '）');
        state.reconnectLeft = MAX_RECONNECT;
        connect(target);
      });
    };

    el('endpoint').onkeydown = function (ev) {
      if (ev.key === 'Enter') el('btnConnect').click();
    };

    var folds = document.querySelectorAll('.fold');
    for (var i = 0; i < folds.length; i++) {
      folds[i].onclick = function () {
        var name = this.getAttribute('data-fold');
        var block = this.parentElement;
        state.folds[name] = block.classList.contains('closed');
        block.classList.toggle('closed');
        if (state.folds[name]) {
          if (name === 'hotkey') refreshHotkeys(state.lastModelID);
          if (name === 'expression') refreshExpressions();
          if (name === 'parameter') refreshParams();
        }
      };
    }

    el('btnAbout').onclick = function () { el('about').classList.remove('hidden'); };
    el('btnCloseAbout').onclick = function () { el('about').classList.add('hidden'); };
    el('about').onclick = function (ev) { if (ev.target === this) el('about').classList.add('hidden'); };

    el('btnLang').onclick = function () {
      LANG = LANG === 'zh' ? 'en' : 'zh';
      state.settings.language = LANG;
      saveSettings();
      applyLang();
    };
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    hostCall('hostAppInfo').then(function (info) {
      if (info && info.version) el('appVersion').textContent = 'v' + info.version;
    });

    hostCall('hostLoadSettings').then(function (loaded) {
      state.settings = mergeSettings(loaded);
      LANG = state.settings.language === 'en' ? 'en' : 'zh';
      el('endpoint').value = state.settings.endpoint || '127.0.0.1:8001';
      applyLang();
      bindEvents();
      startInjection();
      autoConnect();
    });
  }

  /* 与原版 TryAutoConnent 一致：优先用上次的地址，其次 UDP 发现，最后兜底 8001。 */
  function autoConnect() {
    state.reconnectLeft = MAX_RECONNECT;
    var saved = (state.settings.endpoint || '').trim();
    if (saved) {
      connect(saved);
      return;
    }
    state.notice = t('tip.wait');
    setConn('connecting');
    hostCall('hostDiscover').then(function (list) {
      var found = (list || []).filter(function (x) { return x && x.port; });
      var target = found.length ? (found[0].ip + ':' + found[0].port) : '127.0.0.1:8001';
      connect(target);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
