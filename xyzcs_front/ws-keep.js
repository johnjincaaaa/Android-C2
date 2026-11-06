/* 面板 /e WebSocket 自动重连 shim
 * 现状：前端 onclose 只标记断开不重连（服务器重启/网络闪断/心跳竞态后，控制页永久失联——
 * 命令静默丢失、画面冻结，必须手动刷新页面）。
 * 方案：代理 WebSocket 构造，/e 通道断开（1006 异常 / 4000 心跳超时）后 2s 自动重建，
 * 复用 app 已挂的 onopen/onmessage 处理器 → onopen 触发 app 自身重新 subscribe + device_focus。
 * app 主动 close()（1000 正常关闭，如组件卸载）不重连。
 */
(function () {
  if (window.__wsKeep) return; window.__wsKeep = 1;

  /* 禁用第三方遥测（react-admin / shadcn-admin-kit → marmelab.com）：加载时跨国外发请求，
   * 慢网络下拖慢页面且泄露面板域名——拦截后直接返回空响应 */
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      if (/marmelab\.com|admin-kit-telemetry|react-admin-telemetry/.test(u))
        return Promise.resolve(new Response('{}', {status: 200, headers: {'Content-Type': 'application/json'}}));
      /* build_dl_shim (2026-09-29): 构建产物下载改原生导航。
       * 前端 fetch+blob+a.click() 在 Safari/部分浏览器不触发保存 (实测 blob 假下载)。
       * 拦截 /m/build/<id>/download 的 fetch → location.href 直链 + token 参数:
       * 浏览器原生下载管理器 100% 触发, 支持断点续传; attachment 响应不会离开当前页面。
       * 返回 forever-pending Promise: React onClick 的 await fetch 挂起即可 (原生下载已在进行)。 */
      if (/\/m\/build\/\d{1,18}\/download/.test(u)) {
        try {
          var tok = localStorage.getItem('token') || '';
          var sep = u.indexOf('?') >= 0 ? '&' : '?';
          location.href = u + sep + 'token=' + encodeURIComponent(tok);
        } catch (e) {}
        return new Promise(function () {});
      }
    } catch (e) {}
    return _fetch.apply(this, arguments);
  };

  var RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    var real = protocols !== undefined ? new RealWS(url, protocols) : new RealWS(url);
    if (!/\/e\?/.test(String(url))) return real;   // 只代理面板 /e 通道，其余直通
    var state = { handlers: {}, listeners: {}, real: real, closed: false, binaryType: null };
    function fire(type, ev) {
      var h = state.handlers['on' + type];
      if (h) { try { h(ev); } catch (e) {} }
      (state.listeners[type] || []).forEach(function (fn) { try { fn(ev); } catch (e) {} });
    }
    function attach(r) {
      if (state.zTimer) clearInterval(state.zTimer);
      var lastMsgAt = Date.now();
      r.onopen = function (ev) { lastMsgAt = Date.now(); fire('open', ev); };
      r.onmessage = function (ev) { lastMsgAt = Date.now(); fire('message', ev); };
      r.onerror = function (ev) { fire('error', ev); };
      r.onclose = function (ev) {
        if (state.zTimer) { clearInterval(state.zTimer); state.zTimer = null; }
        if (r !== state.real && state.real) return;    // 旧 socket 的迟到 close（已被替换）忽略
        if (state.closed) { fire('close', ev); return; }
        fire('close', ev);                          // app 标记断开（UI 显示离线，诚实状态）
        setTimeout(function () {                    // 2s 后自动重建 → onopen → app 重新订阅
          if (state.closed) return;
          try {
            var nr = new RealWS(url);
            state.real = nr;
            if (state.binaryType) nr.binaryType = state.binaryType;
            attach(nr);
          } catch (e) {}
        }, 2000);
      };
      // 僵尸连接检测：Safari 切后台时连接可能悄悄死掉（无 close 事件、readyState 仍 OPEN），
      // 命令会全部发进黑洞。服务器 /e 心跳 20s 一条——45s 无任何消息 = 僵尸 → 强制重建。
      state.zTimer = setInterval(function () {
        if (state.closed || r !== state.real) { clearInterval(state.zTimer); state.zTimer = null; return; }
        if (Date.now() - lastMsgAt > 45000) {
          clearInterval(state.zTimer); state.zTimer = null;
          try { r.close(4000, 'zombie'); } catch (e) {}
          setTimeout(function () {                   // 僵尸 TCP 上 close 事件可能不来 → 3s 后兜底手动触发
            if (r === state.real && !state.closed) {
              try { r.onclose && r.onclose({code: 4000, reason: 'zombie', wasClean: false}); } catch (e) {}
            }
          }, 3000);
        }
      }, 15000);
      if (state.binaryType) r.binaryType = state.binaryType;
    }
    attach(real);
    return new Proxy({}, {
      get: function (t, prop) {
        if (prop === 'send') return function (data) { try { if (state.real.readyState === 1) state.real.send(data); } catch (e) {} };
        if (prop === 'close') return function (c, r) { if (c !== 4000) state.closed = true; try { state.real.close(c, r); } catch (e) {} };
        if (prop === 'addEventListener') return function (type, fn) { (state.listeners[type] = state.listeners[type] || []).push(fn); };
        if (prop === 'removeEventListener') return function (type, fn) { var a = state.listeners[type] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
        if (prop === 'readyState') return state.real.readyState;
        if (prop === 'url') return state.real.url;
        if (prop === 'binaryType') return state.real.binaryType;
        if (prop === 'bufferedAmount') return state.real.bufferedAmount;
        if (prop === 'extensions') return state.real.extensions;
        if (prop === 'protocol') return state.real.protocol;
        if (prop === 'dispatchEvent') return function () { return true; };
        if (prop === 'CONNECTING') return 0;
        if (prop === 'OPEN') return 1;
        if (prop === 'CLOSING') return 2;
        if (prop === 'CLOSED') return 3;
        return t[prop];
      },
      set: function (t, prop, v) {
        if (prop === 'onopen' || prop === 'onmessage' || prop === 'onclose' || prop === 'onerror') { state.handlers[prop] = v; return true; }
        if (prop === 'binaryType') { state.binaryType = v; try { state.real.binaryType = v; } catch (e) {} return true; }
        t[prop] = v; return true;
      }
    });
  };
  window.WebSocket.prototype = RealWS.prototype;
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
})();

/* ===== 手势诊断探针（临时）：上报画面容器上的鼠标/拖拽/触屏事件到服务器 =====
 * 目的：定位 Safari 滑动失灵——看到底哪些事件在浏览器里真实触发。
 * document 捕获阶段监听（不依赖 app 代码挂载），独立 /e WS 上报。 */
(function () {
  function boot() {
    if (window.__gdiag) return; window.__gdiag = 1;
    var ws = null;
    function connect() {
      try {
        var tok = localStorage.getItem('token');
        if (!tok) return;
        ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/e?token=' + tok);
        ws.onopen = function () { send({ev: 'diag_hello', ua: navigator.userAgent.slice(0, 80)}); };
        ws.onclose = function () { ws = null; setTimeout(connect, 8000); };
        ws.onerror = function () {};
      } catch (e) {}
    }
    function send(d) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({type: 'gesture_diag', data: d})); } catch (e) {} }
    connect();
    function pic() { var v = document.querySelector('video'); return (v && v.parentElement) || null; }
    var imgN = 0, lastSrc = '';
    setInterval(function () { try { var im = document.querySelector('img'); var cur = im ? im.src.length : 0; if (cur && cur !== lastSrc) { imgN++; lastSrc = cur; } } catch (e) {} }, 500);
    function rec(ev, x, y, extra) {
      var c = pic();
      if (!c) return;
      var r = c.getBoundingClientRect();
      var d = {ev: ev, x: x, y: y, inRect: x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
               dragCSS: (c.style.webkitUserDrag || '') + '/' + (c.style.touchAction || ''),
               ltA: window.__ltA || 0, imgN: imgN, ts: Date.now()};
      if (extra) for (var k in extra) d[k] = extra[k];
      send(d);
    }
    var lastWh = 0;
    document.addEventListener('wheel', function (e) {
      var c = pic();
      if (!c) return;
      if (!(e.target === c || c.contains(e.target))) return;
      var now = Date.now();
      if (now - lastWh < 200) return;
      lastWh = now;
      rec('wheel', e.clientX, e.clientY, {dx: e.deltaX, dy: e.deltaY});
    }, true);
    ['mousedown', 'mouseup', 'dragstart', 'touchstart', 'touchend', 'mouseleave', 'click'].forEach(function (t) {
      document.addEventListener(t, function (e) {
        var c = pic();
        if (!c) return;
        if (!(e.target === c || c.contains(e.target))) return;
        rec(t, e.clientX, e.clientY, {btn: e.button});
      }, true);
    });
    var lastMv = 0;
    document.addEventListener('mousemove', function (e) {
      var now = Date.now();
      if (now - lastMv < 150) return;
      lastMv = now;
      var c = pic();
      if (!c || !(e.target === c || c.contains(e.target))) return;
      rec('mousemove', e.clientX, e.clientY);
    }, true);
    document.addEventListener('touchmove', function (e) {
      var now = Date.now();
      if (now - lastMv < 150) return;
      lastMv = now;
      var t0 = e.touches[0] || {};
      rec('touchmove', t0.clientX, t0.clientY);
    }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/* ===== 触控板/滚轮手势 → 手机 SWIPE =====
 * 根因（探针实证）：Mac 触控板双指滑动不产生 mousedown，只有 wheel 事件——app 的
 * onMouseDown 手势链永远不启动。此处在 document 捕获阶段接管画面区域的 wheel，
 * 累积 delta 静默 180ms 后发射一次 swipe（方向映射：滚下=手指上扫，与自然/经典滚动都兼容）。 */
(function () {
  function boot() {
    if (window.__wheelSwipe) return; window.__wheelSwipe = 1;
    var ws = null;
    function connect() {
      try {
        var tok = localStorage.getItem('token');
        if (!tok) return;
        ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/e?token=' + tok);
        ws.onclose = function () { ws = null; setTimeout(connect, 5000); };
        ws.onerror = function () {};
      } catch (e) {}
    }
    connect();
    function devId() { var m = location.hash.match(/devices\/([A-Za-z0-9_-]+)/); return m ? m[1] : null; }
    function pic() { var v = document.querySelector('video'); return (v && v.parentElement) || null; }
    function map(c, cx, cy) {
      var img = c.querySelector('img');
      var r = c.getBoundingClientRect();
      var o = (img && img.naturalWidth > 0) ? img.naturalWidth : 1080;
      var i2 = (img && img.naturalHeight > 0) ? img.naturalHeight : 2400;
      var f = Math.min(r.width / o, r.height / i2);
      var p = o * f, g = i2 * f;
      var x0 = (r.width - p) / 2, y0 = (r.height - g) / 2;
      var v = Math.max(0, Math.min(p, cx - r.left - x0));
      var y = Math.max(0, Math.min(g, cy - r.top - y0));
      return {x: Math.round(v / p * o), y: Math.round(y / g * i2), w: o, h: i2};
    }
    var st = {dx: 0, dy: 0, x: 0, y: 0, t: 0, timer: null};
    function fire() {
      st.timer = null;
      var dx = st.dx, dy = st.dy, px = st.x, py = st.y, had = st.t > 0;
      st.dx = 0; st.dy = 0; st.t = 0;
      var dev = devId(), c = pic();
      if (!had || !dev || !c) return;
      if (Math.abs(dx) + Math.abs(dy) < 8) return;             // 抖动忽略
      var s = map(c, px, py), k = 5;
      // 最小滑动距离保底：触控板平稳滑动的 delta 很小（实测 -2/-8/-4），不放大手机上只动二三十像素=看不见
      var magX = Math.abs(dx) * k, magY = Math.abs(dy) * k;
      if (Math.max(magX, magY) < 250) { var sc = 250 / Math.max(1, Math.max(magX, magY)); magX *= sc; magY *= sc; }
      var ex = Math.max(0, Math.min(s.w, s.x - Math.sign(dx) * Math.round(magX)));
      var ey = Math.max(0, Math.min(s.h, s.y - Math.sign(dy) * Math.round(magY)));
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({type: 'vnc_touch', device_id: dev,
          data: {cmd: 'swipe', startX: s.x, startY: s.y, endX: ex, endY: ey, duration: 280}}));
      } catch (e) {}
    }
    document.addEventListener('wheel', function (e) {
      var c = pic();
      if (!c || !(e.target === c || c.contains(e.target))) return;
      e.preventDefault();                                       // non-passive：阻止页面跟着滚
      var now = Date.now();
      if (st.t && now - st.t > 250) fire();                     // 上一轮已静默：先清算再开新手势
      st.t = now;
      st.dx += (e.deltaX || 0);
      st.dy += (e.deltaY || 0);
      st.x = e.clientX || st.x; st.y = e.clientY || st.y;
      clearTimeout(st.timer);
      st.timer = setTimeout(fire, 250);                         // 静默 250ms 发射
    }, {passive: false, capture: true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
/* ===== 前端全局错误上报（注入）
 * 目的：浏览器出现 react-admin「发生错误」页时，把真实 JS 错误/堆栈上报到服务器日志
 * （[client-error] 行），无需用户手动展开错误详情。独立 /e WS 通道：
 * 未就绪先进缓冲，同错误连续出现只带 dup 计数，单页最多上报 20 条防刷屏。 */
(function () {
  function boot() {
    if (window.__errReport) return; window.__errReport = 1;
    var ws = null, buf = [], sent = 0, lastMsg = '', lastN = 0;
    function connect() {
      try {
        var tok = localStorage.getItem('token');
        if (!tok) { setTimeout(connect, 5000); return; }
        ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/e?token=' + tok);
        ws.onopen = function () { buf.splice(0).forEach(send); };
        ws.onclose = function () { ws = null; setTimeout(connect, 8000); };
        ws.onerror = function () {};
      } catch (e) { setTimeout(connect, 8000); }
    }
    function send(d) {
      if (sent >= 20) return;
      if ((d.msg || '') === lastMsg) lastN++; else { lastMsg = d.msg || ''; lastN = 1; }
      d.dup = lastN;
      try {
        if (ws && ws.readyState === 1) { ws.send(JSON.stringify({type: 'client_error', data: d})); sent++; }
        else buf.push(d);
      } catch (e) {}
    }
    function report(kind, ev) {
      var e = (ev && (ev.error || ev.reason)) || null;
      send({kind: kind,
            msg: (e && (e.message || String(e))) || (ev && ev.message) || 'unknown',
            src: (ev && ev.filename) || '', line: (ev && ev.lineno) || 0, col: (ev && ev.colno) || 0,
            stack: e && e.stack ? String(e.stack).slice(0, 1200) : '',
            href: location.href.slice(0, 200), ts: Date.now()});
    }
    window.addEventListener('error', function (ev) { report('error', ev); });
    window.addEventListener('unhandledrejection', function (ev) { report('rejection', ev); });
    /* React 错误边界捕获的错误不触发 window.onerror，React 会用 console.error 打出 Error 对象——
     * 钩住 console.error，只上报带 .stack 的真错误（过滤字符串型 dev 警告），复用同一 send 通道 */
    var _ce = console.error;
    console.error = function () {
      try {
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          if (a && typeof a === 'object' && a.stack) {
            send({kind: 'console', msg: String(a.message || a).slice(0, 300),
                  stack: String(a.stack).slice(0, 1000),
                  href: location.href.slice(0, 200), ts: Date.now()});
            break;
          }
        }
      } catch (e) {}
      return _ce.apply(this, arguments);
    };
    connect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
/* deploy-script test marker */
