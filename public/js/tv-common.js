'use strict';
// Shared by every TV design: the board's data and live updates, prices, clock, ticker and slideshow.
// Plain ES5 so that smart TV browsers can run it.
(function () {
  var FINENESS = { 24: '999', 22: '916', 21: '875', 18: '750' };
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var raf = window.requestAnimationFrame;

  function make(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function price(n) {
    n = Number(n);
    if (!(n > 0)) return '—';
    if (n >= 1000) n = Math.round(n); // cents are noise on a price board
    var s = (Math.round(n * 100) / 100).toFixed(2).split('.');
    s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return s[1] === '00' ? s[0] : s[0] + '.' + s[1];
  }
  // Signed difference, for "up 1,200" style figures.
  function diff(n) {
    n = Math.round(Number(n) * 100) / 100;
    if (!n) return '';
    return (n > 0 ? '+' : '−') + price(Math.abs(n));
  }
  function unitValue(rate, data) { return Math.round(Number(rate || 0) * (data.show_pavan ? 8 : 1) * 100) / 100; }
  function unitLabel(data) { return (data.currency ? data.currency + ' ' : '') + (data.show_pavan ? 'per pavan (8 g)' : 'per gram'); }

  // Counts a number from one value to another inside a text node.
  function roll(node, from, to, ms) {
    node.rollId = (node.rollId || 0) + 1;
    var id = node.rollId;
    if (!raf || calm || !(to > 0) || from === to) { node.textContent = price(to); return; }
    var began = null;
    function step(t) {
      if (node.rollId !== id) return;
      if (began === null) began = t;
      var p = Math.min(1, (t - began) / (ms || 1500));
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = p < 1 ? price(Math.round(from + (to - from) * eased)) : price(to);
      if (p < 1) raf(step);
    }
    raf(step);
  }

  // Loads the board's data, then keeps it fresh: instant through the live stream, every 20 s as a safety net.
  // When the shop saves a different design, a TV showing this one reloads and the server sends the new page.
  // A ?theme= preview never switches away.
  function start(render, offlineEl, designName) {
    var previewing = /[?&]theme=/.test(window.location.search);
    function load() {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/tv?t=' + new Date().getTime(), true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200) {
          if (offlineEl) offlineEl.style.display = 'none';
          try {
            var data = JSON.parse(xhr.responseText);
            if (designName && !previewing && data.theme && data.theme !== designName) { window.location.replace('/tv'); return; }
            render(data);
          } catch (e) { if (window.console) console.error(e); }
        } else if (offlineEl) {
          offlineEl.style.display = 'block';
        }
      };
      xhr.send();
    }
    load();
    setInterval(load, 20000);
    if (window.EventSource) {
      var stream = new EventSource('/api/tv/events');
      stream.addEventListener('rates', load);
      stream.addEventListener('tv', load);
      // Let go of the connection the moment the page is left, so the next page is not kept waiting for it.
      window.addEventListener('pagehide', function () { stream.close(); });
    }
  }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  // Calls fn every second with a ready-made set of strings.
  function clock(fn) {
    function tick() {
      var d = new Date();
      var h = d.getHours();
      fn({
        date: d,
        hh: pad2(h % 12 || 12), mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()), h24: pad2(h),
        ampm: h < 12 ? 'A.M' : 'P.M',
        day: DAYS[d.getDay()], dayShort: DAYS[d.getDay()].slice(0, 3),
        dom: d.getDate(), dom2: pad2(d.getDate()),
        month: MONTHS[d.getMonth()], monthShort: MONTHS[d.getMonth()].slice(0, 3), year: d.getFullYear()
      });
    }
    tick();
    setInterval(tick, 1000);
  }

  // A line that scrolls forever: two identical halves, moved left by exactly one half.
  // The page defines @keyframes tvmarquee { from { transform: translateX(0) } to { transform: translateX(-50%) } }.
  function marquee(box, run, text, screensPerSecondInverse) {
    if (box.marqueeText === text) return;
    box.marqueeText = text;
    run.innerHTML = '';
    if (!text) { box.className += ' hide'; return; }
    box.className = box.className.replace(/ ?\bhide\b/g, '');
    var unit = text + '      ◆      ';
    var inner = make('div', '');
    var half = make('span', '', unit);
    inner.appendChild(half);
    run.appendChild(inner);
    var repeats = Math.max(1, Math.ceil(run.clientWidth / Math.max(1, half.offsetWidth)) + 1);
    var all = '';
    for (var i = 0; i < repeats; i++) all += unit;
    half.textContent = all;
    inner.appendChild(make('span', '', all));
    var seconds = Math.max(10, Math.round(half.offsetWidth / (run.clientWidth / (screensPerSecondInverse || 16))));
    inner.style.animation = 'tvmarquee ' + seconds + 's linear infinite';
  }

  // Two stacked layers cross-fading through a list of pictures. Each layer has the class "slide",
  // becomes "slide on" (and optionally a variant class from variantOf(index)) when shown, "slide out" when leaving.
  function slideshow(a, b, every, onChange, variantOf) {
    var urls = [];
    var at = -1;
    var layer = 0;
    var timer = null;
    var key = null;
    function next() {
      if (!urls.length) return;
      at = (at + 1) % urls.length;
      var url = urls[at];
      var index = at;
      var img = new Image();
      img.onload = function () {
        var incoming = layer ? b : a;
        var outgoing = layer ? a : b;
        incoming.style.backgroundImage = 'url("' + url + '")';
        incoming.className = 'slide';
        void incoming.offsetWidth;
        incoming.className = 'slide on' + (variantOf ? ' ' + variantOf(index) : '');
        if (outgoing.className.indexOf(' on') >= 0) outgoing.className = 'slide out';
        layer = 1 - layer;
        if (onChange) onChange(url, index);
      };
      img.src = url;
    }
    return {
      set: function (list) {
        var k = list.join('|');
        if (k === key) return;
        key = k;
        urls = list;
        at = -1;
        clearInterval(timer);
        if (!urls.length) {
          a.className = 'slide';
          b.className = 'slide';
          if (onChange) onChange(null, -1);
          return;
        }
        next();
        timer = setInterval(next, every || 8000);
      }
    };
  }

  function imageUrls(data) {
    var out = [];
    var list = data.images || [];
    for (var i = 0; i < list.length; i++) out.push(list[i].url);
    return out;
  }

  // "Updated 4:43 pm" from the newest rate change.
  function updatedAt(data) {
    var latest = null;
    for (var i = 0; i < data.rates.length; i++) {
      var u = data.rates[i].updated_at;
      if (u && (!latest || u > latest)) latest = u;
    }
    if (!latest) return '';
    var d = new Date(latest);
    var h = d.getHours();
    return pad2(h % 12 || 12) + ':' + pad2(d.getMinutes()) + (h < 12 ? ' am' : ' pm');
  }

  window.TV = {
    FINENESS: FINENESS, calm: calm, raf: raf, make: make, price: price, diff: diff, unitValue: unitValue, unitLabel: unitLabel,
    roll: roll, start: start, clock: clock, marquee: marquee, slideshow: slideshow, imageUrls: imageUrls, updatedAt: updatedAt, pad2: pad2
  };
})();
