// Shared by every page: time zone for server-rendered times, confirmations,
// offline guard on forms, and share/copy for private links. No tracking.
(function () {
  'use strict';
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && document.cookie.indexOf('tz=' + encodeURIComponent(tz)) === -1) {
      document.cookie = 'tz=' + encodeURIComponent(tz) + '; path=/; max-age=31536000; samesite=lax';
    }
  } catch (e) { /* time zone stays UTC */ }

  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    var question = form.getAttribute('data-confirm');
    if (question && !window.confirm(question)) { ev.preventDefault(); return; }
    if (form.hasAttribute('data-offline-guard') && navigator.onLine === false) {
      ev.preventDefault();
      var msg = form.querySelector('[data-offline-message]');
      if (msg) { msg.hidden = false; msg.focus && msg.focus(); }
    }
  }, true);

  Array.prototype.forEach.call(document.querySelectorAll('[data-share]'), function (btn) {
    var url = btn.getAttribute('data-share');
    if (navigator.share || (navigator.clipboard && navigator.clipboard.writeText)) btn.hidden = false;
    btn.textContent = navigator.share ? 'Share link' : 'Copy link';
    btn.addEventListener('click', function () {
      if (navigator.share) {
        navigator.share({ title: 'My Agape emergency request', url: url }).catch(function () {});
      } else {
        navigator.clipboard.writeText(url).then(function () { btn.textContent = 'Copied'; }, function () { btn.textContent = 'Copy failed: select the link above'; });
      }
    });
  });
})();
