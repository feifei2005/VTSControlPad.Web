/* VTube Studio 官方 WebSocket API 的最小实现。
   原版用 VTS 的 C# SDK + websocket-sharp，这里直接用浏览器原生 WebSocket。 */
(function () {
  'use strict';

  var API_NAME = 'VTubeStudioPublicAPI';
  var API_VERSION = '1.0';

  /* VTS 与 SDK 都会把参数名收敛为 [A-Za-z0-9_]，超过 31 字符截断。 */
  function sanitizeParameterName(name) {
    return String(name).replace(/[^A-Za-z0-9_]/g, '').slice(0, 31);
  }

  /* "192.168.1.5:8001" / "127.0.0.1" -> {host, port}，缺省端口 8001。 */
  function parseEndpoint(endpoint) {
    var m = String(endpoint || '').trim().match(/^([^:/\s]+)(?::(\d+))?$/);
    if (!m || !m[1]) throw new Error('地址格式应为 IP:端口');
    return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 8001 };
  }

  function VTSClient(options) {
    var o = options || {};
    this.pluginName = o.pluginName || 'ControlPad_Web';
    this.pluginDeveloper = o.pluginDeveloper || 'feifei2005';
    this.log = o.log || function () {};
    this.ws = null;
    this.pending = {};
    this.seq = 0;
    this.authenticated = false;
    this.closedByUser = false;
    this.onClose = null;
  }

  VTSClient.prototype.open = function (endpoint) {
    var self = this;
    var target = parseEndpoint(endpoint);
    var url = 'ws://' + target.host + ':' + target.port;

    this.closedByUser = false;

    return new Promise(function (resolve, reject) {
      var ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new Error('无法创建 WebSocket: ' + e.message));
        return;
      }

      var settled = false;
      var opened = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error('连接 ' + url + ' 超时'));
          try { ws.close(); } catch (e) {}
        }
      }, 8000);

      ws.onopen = function () {
        opened = true;
        settled = true;
        clearTimeout(timer);
        self.ws = ws;
        self.log('WebSocket 已连接 ' + url);
        resolve();
      };

      ws.onerror = function () {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('无法连接到 ' + url));
        }
      };

      ws.onclose = function () {
        clearTimeout(timer);
        if (!opened) {
          if (!settled) {
            settled = true;
            reject(new Error('无法连接到 ' + url));
          }
          return;
        }
        self.ws = null;
        self.authenticated = false;
        self.failPending('连接已断开');
        if (!self.closedByUser && self.onClose) self.onClose();
      };

      ws.onmessage = function (ev) { self.handleMessage(ev.data); };
    });
  };

  VTSClient.prototype.close = function () {
    this.closedByUser = true;
    this.authenticated = false;
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.failPending('连接已关闭');
  };

  VTSClient.prototype.isOpen = function () {
    return !!this.ws && this.ws.readyState === 1;
  };

  VTSClient.prototype.failPending = function (reason) {
    var keys = Object.keys(this.pending);
    for (var i = 0; i < keys.length; i++) {
      var p = this.pending[keys[i]];
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending = {};
  };

  VTSClient.prototype.handleMessage = function (raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!msg || !msg.requestID) return;
    var p = this.pending[msg.requestID];
    if (!p) return;
    delete this.pending[msg.requestID];
    clearTimeout(p.timer);
    if (msg.messageType === 'APIError') {
      p.reject(new Error((msg.data && msg.data.message) || 'API 返回错误'));
      return;
    }
    p.resolve(msg);
  };

  /* 发送一条请求并等待同 requestID 的响应。 */
  VTSClient.prototype.send = function (messageType, data, timeoutMs) {
    var self = this;
    if (!this.isOpen()) return Promise.reject(new Error('未连接到 VTube Studio'));

    var requestID = 'req-' + (++this.seq);
    var payload = {
      apiName: API_NAME,
      apiVersion: API_VERSION,
      requestID: requestID,
      messageType: messageType,
      data: data || {}
    };

    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete self.pending[requestID];
        reject(new Error(messageType + ' 响应超时'));
      }, timeoutMs || 10000);
      self.pending[requestID] = { resolve: resolve, reject: reject, timer: timer };
      try {
        self.ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        delete self.pending[requestID];
        reject(e);
      }
    });
  };

  /* 鉴权：先复用已保存 token，失效或没有 token 时向 VTS 申请新的。
     getToken/saveToken 由调用方提供，用来读写宿主里的持久化存储。 */
  VTSClient.prototype.authenticate = function (getToken, saveToken) {
    var self = this;
    this.authenticated = false;

    return this.send('APIStateRequest', {}, 5000).then(function (state) {
      if (!state.data || !state.data.active) {
        throw new Error('VTube Studio 的 API 未开启');
      }

      var token = (getToken && getToken()) || '';
      if (!token) return self.requestNewToken(saveToken);

      return self.send('AuthenticationRequest', {
        pluginName: self.pluginName,
        pluginDeveloper: self.pluginDeveloper,
        authenticationToken: token
      }, 15000).then(function (res) {
        if (res.data && res.data.authenticated) {
          self.authenticated = true;
          self.log('已用保存的 token 完成鉴权');
          return null;
        }
        self.log('保存的 token 已失效，重新申请');
        if (saveToken) saveToken('');
        return self.requestNewToken(saveToken);
      });
    });
  };

  /* 申请 token：VTS 会弹窗，需要用户在 VTS 里手动点「允许」。 */
  VTSClient.prototype.requestNewToken = function (saveToken) {
    var self = this;
    self.log('向 VTS 申请新 token，请在 VTube Studio 弹窗中点击允许');
    return self.send('AuthenticationTokenRequest', {
      pluginName: self.pluginName,
      pluginDeveloper: self.pluginDeveloper
    }, 120000).then(function (res) {
      var token = res.data && res.data.authenticationToken;
      if (!token) throw new Error('未取得 authenticationToken');
      if (saveToken) saveToken(token);
      return self.send('AuthenticationRequest', {
        pluginName: self.pluginName,
        pluginDeveloper: self.pluginDeveloper,
        authenticationToken: token
      }, 15000).then(function (r) {
        if (!r.data || !r.data.authenticated) {
          throw new Error((r.data && r.data.reason) || '鉴权被拒绝');
        }
        self.authenticated = true;
        self.log('鉴权成功');
        return null;
      });
    });
  };

  /* ---- 业务请求 ---- */

  VTSClient.prototype.getCurrentModel = function () {
    return this.send('CurrentModelRequest', {}, 5000);
  };

  VTSClient.prototype.getHotkeys = function (modelID) {
    return this.send('HotkeysInCurrentModelRequest', modelID ? { modelID: modelID } : {}, 5000);
  };

  VTSClient.prototype.triggerHotkey = function (hotkeyID) {
    return this.send('HotkeyTriggerRequest', { hotkeyID: hotkeyID }, 5000);
  };

  VTSClient.prototype.getExpressions = function () {
    return this.send('ExpressionStateRequest', { details: false }, 5000);
  };

  VTSClient.prototype.activateExpression = function (expressionFile, active) {
    return this.send('ExpressionActivationRequest', {
      expressionFile: expressionFile,
      active: !!active
    }, 8000);
  };

  VTSClient.prototype.getInputParameterList = function () {
    return this.send('InputParameterListRequest', {}, 8000);
  };

  /* mode = "add"（叠加到追踪输入上）或 "set"，与原版一致使用 add。 */
  VTSClient.prototype.injectParameters = function (values, mode) {
    return this.send('InjectParameterDataRequest', {
      faceFound: false,
      mode: mode || 'add',
      parameterValues: values
    }, 5000);
  };

  window.VTSClient = VTSClient;
  window.sanitizeParameterName = sanitizeParameterName;
})();
