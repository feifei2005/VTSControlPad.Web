/* 中英双语词条。原版使用 I2 Localization，这里用同样含义的键替代。 */
var I18N = {
  zh: {
    'conn.model': '模型',
    'conn.disconnected': '未连接',
    'conn.connecting': '连接中…',
    'conn.connected': '已连接',
    'conn.error': '连接出错',
    'conn.noModel': '未加载模型',
    'btn.connect': '连接',
    'btn.disconnect': '断开',
    'btn.discover': '自动发现',
    'btn.trigger': '触发',
    'tip.wait': '等待连接 VTube Studio…（请确保 VTS 已启动并在设置中开启了 API）',
    'tip.noModel': '已连接 VTS，但当前没有加载 Live2D 模型。',
    'tip.error': '连接失败',
    'tip.notFound': '未发现 VTS 实例，请手动填写「IP:端口」后点击连接。',
    'block.hotkey': '热键',
    'block.expression': '表情',
    'block.parameter': 'Live2D 参数',
    'empty.hotkey': '当前模型没有热键',
    'empty.expression': '当前模型没有表情',
    'empty.parameter': '当前模型没有可注入参数',
    'about.title': '关于',
    'about.desc': '本版本是 VTS Control Pad 的 WebView2 重写版：用 Chromium 内核渲染界面，协议依旧走 VTube Studio 官方 WebSocket API，不再依赖 Unity 运行时。',
    'about.originalAuthor': '原作者',
    'about.rewrittenBy': '重写',
    'about.rewriteNote': '本版由 feifei2005 用 Go + WebView2 重写；原版 VTSControlPad 由 xiaoye97 开发（源码未公开，仅 itch.io 分发）。',
    'about.close': '关闭',
    'footer.rewrite': 'WebView2 重写版 · by feifei2005'
  },
  en: {
    'conn.model': 'Model',
    'conn.disconnected': 'Disconnected',
    'conn.connecting': 'Connecting…',
    'conn.connected': 'Connected',
    'conn.error': 'Connection error',
    'conn.noModel': 'No model loaded',
    'btn.connect': 'Connect',
    'btn.disconnect': 'Disconnect',
    'btn.discover': 'Auto detect',
    'btn.trigger': 'Trigger',
    'tip.wait': 'Waiting for VTube Studio… (make sure VTS is running with the API enabled)',
    'tip.noModel': 'Connected to VTS, but no Live2D model is currently loaded.',
    'tip.error': 'Connection failed',
    'tip.notFound': 'No VTS instance found. Enter "IP:port" manually and hit Connect.',
    'block.hotkey': 'Hotkeys',
    'block.expression': 'Expressions',
    'block.parameter': 'Live2D Parameters',
    'empty.hotkey': 'No hotkeys in current model',
    'empty.expression': 'No expressions in current model',
    'empty.parameter': 'No injectable parameters in current model',
    'about.title': 'About',
    'about.desc': 'This is a WebView2 rewrite of VTS Control Pad: the UI is rendered by Chromium while the protocol still goes through the official VTube Studio WebSocket API. No Unity runtime involved.',
    'about.originalAuthor': 'Original author',
    'about.rewrittenBy': 'Rewrite',
    'about.rewriteNote': 'Rewritten by feifei2005 with Go + WebView2. The original VTSControlPad was made by xiaoye97 (source not public, distributed via itch.io).',
    'about.close': 'Close',
    'footer.rewrite': 'WebView2 rewrite · by feifei2005'
  }
};

var LANG = 'zh';

function t(key) {
  var table = I18N[LANG] || I18N.zh;
  return table[key] || I18N.zh[key] || key;
}

/* 把页面上带 data-i18n 的静态文案换成当前语言。 */
function applyI18n(root) {
  var scope = root || document;
  var nodes = scope.querySelectorAll('[data-i18n]');
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
  }
}
