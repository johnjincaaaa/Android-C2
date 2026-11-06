/* totp-unbind-dropdown.js — TOTP 解绑下拉入口
 * 后端未提供 /m/totp/* 端点时静默不渲染，避免 index.html 引用 404。 */
(function () {
  'use strict';
  if (window.__totpUnbind) return;
  window.__totpUnbind = 1;
  function boot() {
    try {
      if (!document.querySelector('[data-totp-unbind]')) return;
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();