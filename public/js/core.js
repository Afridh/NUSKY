'use strict';
// Shared pieces: DOM helper, server calls, formatting, dialogs, sign-in, navigation, live updates.
const NJ = {
  state: { me: null, settings: {}, rates: [], branches: [], users: [], karats: [24, 22, 21, 18], unread: 0 },
  pages: {},
  FINENESS: { 24: '999', 22: '916', 21: '875', 18: '750' },
};

(function () {
  const BOOLEAN_PROPS = ['checked', 'disabled', 'selected', 'readOnly', 'required', 'autofocus', 'multiple'];

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') value = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (BOOLEAN_PROPS.includes(k)) el[k] = true;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    if (value !== undefined) el.value = value; // after children, so <select> can find its option
    return el;
  }

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('Cannot reach the shop server. Check that the server computer is on and connected.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no JSON body */
    }
    if (res.status === 401 && url !== '/api/login') {
      showSignIn();
      throw new Error('Sign in to continue.');
    }
    if (!res.ok) throw new Error((data && data.error) || `The server refused that (${res.status}).`);
    return data;
  }

  // ----- formatting -----
  const twoDp = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const plain = (n) => Number(n || 0).toLocaleString('en-US', twoDp);
  const money = (n) => `${NJ.state.settings.currency || ''} ${plain(n)}`.trim();
  const grams = (n) => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} g`;
  const dateTime = (iso) =>
    new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const timeOnly = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const val = (input) => {
    const n = Number(input.value);
    return Number.isFinite(n) ? n : 0;
  };
  const rateFor = (karat) => NJ.state.rates.find((r) => r.karat === Number(karat)) || { sell_rate: 0, buy_rate: 0 };
  const branchName = (id) => (NJ.state.branches.find((b) => b.id === id) || { name: 'Unknown branch' }).name;
  const canManage = () => NJ.state.me && NJ.state.me.role !== 'cashier';
  const canEditRate = () => canManage() || NJ.state.settings.cashier_edit_rate === '1';

  function hallmark(karat) {
    return h('span', { class: `hallmark k${karat}`, title: `${karat} karat, ${NJ.FINENESS[karat]} fineness` },
      h('b', { text: `${karat}K` }), h('i', { text: NJ.FINENESS[karat] }));
  }

  function karatSelect(value, onchange) {
    return h('select', { value: String(value || 22), onchange, 'aria-label': 'Karat' },
      NJ.state.karats.map((k) => h('option', { value: String(k), text: `${k}K` })));
  }

  function field(label, control, hint) {
    // Only a single input may sit inside a <label>: a label forwards clicks to its first control,
    // which would press the wrong button in a composite control such as the customer picker.
    const simple = control instanceof HTMLElement && control.matches('input, select, textarea');
    if (!simple && control instanceof HTMLElement) {
      control.setAttribute('role', 'group');
      control.setAttribute('aria-label', label);
    }
    return h(simple ? 'label' : 'div', { class: 'field' }, h('span', { text: label }), control, hint ? h('small', { text: hint }) : null);
  }

  // ----- feedback -----
  function toast(message, kind) {
    const life = kind === 'bad' ? 7000 : 3800;
    const el = h('div', { class: `toast ${kind || ''}`, role: 'status', style: `--life:${life}ms` },
      h('span', { class: 'toast-mark', 'aria-hidden': 'true', text: kind === 'bad' ? '!' : kind === 'good' ? '✓' : 'i' }),
      h('span', { text: message }));
    document.getElementById('toasts').append(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }, life);
  }

  const calmMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Rolls a figure from its old value to the new one, so a changed total catches the eye.
  function rollTo(el, value, format) {
    const from = typeof el.njValue === 'number' ? el.njValue : value;
    el.njValue = value;
    cancelAnimationFrame(el.njFrame);
    if (from === value || calmMotion()) {
      el.textContent = format(value);
      return;
    }
    const began = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - began) / 380);
      el.textContent = format(from + (value - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) el.njFrame = requestAnimationFrame(step);
    };
    el.njFrame = requestAnimationFrame(step);
  }

  // Restarts a CSS animation class on an element.
  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  // Line icons for the side rail. Fixed markup, never built from user input.
  const ICONS = {
    today: '<rect x="3" y="3" width="7" height="7" rx="1.500"/><rect x="14" y="3" width="7" height="7" rx="1.500"/><rect x="3" y="14" width="7" height="7" rx="1.500"/><rect x="14" y="14" width="7" height="7" rx="1.500"/>',
    sell: '<path d="M6 8h12l1 13H5L6 8z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
    buy: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7l-3 6h6L5 7zM19 7l-3 6h6l-3-6z"/>',
    stock: '<path d="M6 3h12l4 6-10 12L2 9l4-6z"/><path d="M2 9h20M9 3L7 9l5 12 5-12-2-6"/>',
    customers: '<circle cx="9" cy="8" r="3.500"/><path d="M2.500 20c.600-3.500 3.200-5.500 6.500-5.500s5.900 2 6.500 5.500M16 4.600a3.500 3.500 0 0 1 0 6.800M18.500 14.800c1.700.800 2.800 2.500 3.100 5.200"/>',
    bills: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6"/>',
    rates: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    messages: '<path d="M4 5h16v11H9l-5 4V5z"/>',
    tv: '<rect x="3" y="5" width="18" height="12" rx="1.500"/><path d="M8 21h8"/>',
    reports: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-7"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.900 4.900L7 7M17 17l2.100 2.100M4.900 19.100L7 17M17 7l2.100-2.100"/>',
  };
  function icon(name) {
    const span = h('span', { class: 'ico', 'aria-hidden': 'true' });
    span.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
    return span;
  }
  const fail = (err) => toast(err.message || String(err), 'bad');

  function modal(title, body, footer, opts = {}) {
    const d = h('dialog', { class: opts.wide ? 'wide' : '' },
      h('header', null, h('h2', { text: title }),
        h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Close', onclick: () => d.close() }, '✕')),
      h('div', { class: 'body' }, body),
      footer && footer.length ? h('footer', null, footer) : null);
    d.addEventListener('close', () => {
      d.remove();
      if (opts.onClose) opts.onClose();
    });
    document.body.append(d);
    d.showModal();
    return d;
  }

  function confirmBox(message, okLabel, danger) {
    return new Promise((resolve) => {
      let answer = false;
      const d = modal('Please confirm', h('p', { text: message }), [
        h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Go back'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => { answer = true; d.close(); } }, okLabel),
      ], { onClose: () => resolve(answer) });
    });
  }

  function printNode(node) {
    const root = document.getElementById('print-root');
    root.replaceChildren(node.cloneNode(true));
    window.print();
  }

  // Runs an async action from a button, blocking double clicks and showing failures.
  function busy(button, action) {
    return async (event) => {
      if (event) event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      try {
        await action();
      } catch (err) {
        fail(err);
      } finally {
        button.disabled = false;
      }
    };
  }

  // ----- customers (shared by the counter and the customers page) -----
  function customerForm(existing) {
    return new Promise((resolve) => {
      let saved = null;
      const c = existing || {};
      const name = h('input', { type: 'text', value: c.name || '', required: true, maxlength: 120 });
      const phone = h('input', { type: 'tel', value: c.phone || '', maxlength: 30 });
      const idNumber = h('input', { type: 'text', value: c.id_number || '', maxlength: 40 });
      const address = h('input', { type: 'text', value: c.address || '', maxlength: 300 });
      const notes = h('textarea', { value: c.notes || '', maxlength: 500 });
      const save = h('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save customer' : 'Add customer');
      const form = h('form', null,
        field('Name', name),
        h('div', { class: 'row' }, field('Phone', phone), field('NIC or passport number', idNumber, 'Needed when you buy gold from this customer.')),
        field('Address', address), field('Notes', notes));
      const d = modal(existing ? 'Edit customer' : 'New customer', form, [
        h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel'), save,
      ], { onClose: () => resolve(saved) });
      const submit = busy(save, async () => {
        const body = { name: name.value, phone: phone.value, id_number: idNumber.value, address: address.value, notes: notes.value };
        saved = existing ? await api('PUT', `/api/customers/${existing.id}`, body) : await api('POST', '/api/customers', body);
        toast(existing ? 'Customer saved' : 'Customer added', 'good');
        d.close();
      });
      form.addEventListener('submit', submit);
      save.addEventListener('click', submit);
      name.focus();
    });
  }

  function customerPicker(onChange) {
    let chosen = null;
    let timer = null;
    const wrap = h('div');
    function set(customer) {
      chosen = customer;
      render();
      if (onChange) onChange(chosen);
    }
    function render() {
      wrap.replaceChildren();
      if (chosen) {
        wrap.append(h('div', { class: 'chosen' },
          h('div', null, h('b', { text: chosen.name }),
            h('div', { class: 'small muted', text: [chosen.phone, chosen.id_number].filter(Boolean).join(', ') || 'No phone or ID saved' })),
          h('button', { class: 'btn', type: 'button', onclick: () => set(null) }, 'Change')));
        return;
      }
      const list = h('ul', { class: 'hidden' });
      const input = h('input', {
        type: 'search', placeholder: 'Search by name, phone or ID number', 'aria-label': 'Find a customer',
        oninput: () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            const q = input.value.trim();
            if (!q) return list.classList.add('hidden');
            try {
              const found = await api('GET', `/api/customers?q=${encodeURIComponent(q)}`);
              list.replaceChildren(...(found.length
                ? found.slice(0, 8).map((c) => h('li', { onclick: () => set(c) }, h('b', { text: c.name }), ' ', h('span', { class: 'muted small', text: c.phone })))
                : [h('li', { class: 'muted', text: 'No customer matches. Add them as a new customer.' })]));
              list.classList.remove('hidden');
            } catch (err) {
              fail(err);
            }
          }, 200);
        },
      });
      wrap.append(h('div', { class: 'row' },
        h('div', { class: 'picker' }, input, list),
        h('button', { class: 'btn fit', type: 'button', onclick: async () => { const c = await customerForm(); if (c) set(c); } }, 'New customer')));
    }
    render();
    return { el: wrap, get: () => chosen, set };
  }

  // ----- navigation -----
  const NAV = [
    { path: '/', label: 'Today', icon: 'today' },
    { path: '/sell', label: 'Sell', icon: 'sell' },
    { path: '/buy', label: 'Buy gold', icon: 'buy' },
    { path: '/stock', label: 'Stock', icon: 'stock' },
    { path: '/customers', label: 'Customers', icon: 'customers' },
    { path: '/bills', label: 'Bills and vouchers', icon: 'bills' },
    { path: '/rates', label: 'Gold rates', icon: 'rates' },
    { path: '/messages', label: 'Messages', icon: 'messages' },
    { path: '/tv', label: 'Shop TV', icon: 'tv', roles: ['admin', 'manager'] },
    { path: '/reports', label: 'Reports', icon: 'reports', roles: ['admin', 'manager'] },
    { path: '/settings', label: 'Settings', icon: 'settings', roles: ['admin'] },
  ];
  let leaveHandlers = [];
  let stream = null;

  const allowed = (item) => !item.roles || item.roles.includes(NJ.state.me.role);
  function onLeave(fn) {
    leaveHandlers.push(fn);
  }
  function listen(name, fn) {
    document.addEventListener(name, fn);
    onLeave(() => document.removeEventListener(name, fn));
  }

  let shownRates = {};
  function renderRateStrip() {
    const changed = (r) => shownRates[r.karat] !== undefined && shownRates[r.karat] !== r.sell_rate;
    for (const strip of document.querySelectorAll('.ratestrip')) {
      strip.replaceChildren(...NJ.state.rates.map((r) =>
        h('div', { class: changed(r) ? 'tick' : '', title: `Selling ${money(r.sell_rate)} per gram, buying ${money(r.buy_rate)}` },
          hallmark(r.karat), h('span', { text: plain(r.sell_rate) }))));
    }
    shownRates = Object.fromEntries(NJ.state.rates.map((r) => [r.karat, r.sell_rate]));
  }

  function renderPresence() {
    const online = NJ.state.online || [];
    for (const box of document.querySelectorAll('.presence')) {
      box.replaceChildren(
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { text: `${online.length} online` }),
        ...online.slice(0, 6).map((u) => h('span', { class: `chipname ${u.id === NJ.state.me.id ? 'me' : ''}`, title: u.name, text: initials(u.name) })));
    }
  }

  function setUnread(n) {
    NJ.state.unread = Math.max(0, n);
    const link = document.querySelector('.rail nav a[href="#/messages"]');
    if (!link) return;
    const old = link.querySelector('.badge');
    if (old) old.remove();
    if (NJ.state.unread) link.append(h('span', { class: 'badge', text: String(NJ.state.unread), 'aria-label': `${NJ.state.unread} unread` }));
  }

  function changePassword() {
    const current = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', autocomplete: 'new-password' });
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Change password');
    const d = modal('Change your password', h('div', null, field('Current password', current), field('New password', next, 'At least 6 characters.')), [
      h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel'), save,
    ]);
    save.addEventListener('click', busy(save, async () => {
      await api('POST', '/api/me/password', { current: current.value, next: next.value });
      toast('Password changed', 'good');
      d.close();
    }));
  }

  function renderShell() {
    const me = NJ.state.me;
    document.title = NJ.state.settings.shop_name || 'Nusky Jewellers';
    const [first, ...rest] = (NJ.state.settings.shop_name || 'Nusky Jewellers').split(' ');
    document.getElementById('app').replaceChildren(
      h('div', { class: 'shell' },
        h('aside', { class: 'rail' },
          h('a', { class: 'brand', href: '#/', 'aria-label': NJ.state.settings.shop_name },
            h('span', { class: 'monogram', text: initials(NJ.state.settings.shop_name) }),
            h('span', { class: 'lbl' }, h('strong', { text: first }), h('span', { text: rest.join(' ') }))),
          h('nav', { 'aria-label': 'Main' }, NAV.filter(allowed).map((item) =>
            h('a', { href: `#${item.path}`, title: item.label }, icon(item.icon), h('span', { class: 'lbl', text: item.label })))),
          h('div', { class: 'who' },
            h('span', { class: 'avatar', title: me.name, text: initials(me.name) }),
            h('div', { class: 'lbl' },
              h('b', { text: me.name }), h('span', { text: `${me.role[0].toUpperCase()}${me.role.slice(1)}, ${branchName(me.branch_id)}` }),
              h('div', null,
                h('button', { class: 'btn link', type: 'button', onclick: changePassword }, 'Change password'),
                h('button', { class: 'btn link', type: 'button', onclick: async () => { try { await api('POST', '/api/logout'); } catch { /* signed out anyway */ } showSignIn(); history.replaceState(null, '', '#/'); } }, 'Sign out'))))),
        h('main', null,
          h('header', { class: 'top' }, h('h1', { id: 'page-title' }),
            h('div', { class: 'topright' },
              h('div', { class: 'ratestrip', 'aria-label': 'Selling rates per gram' }),
              h('div', { class: 'presence', 'aria-label': 'Staff online now' }))),
          h('div', { id: 'page' }))));
    shownRates = {};
    renderRateStrip();
    renderPresence();
    setUnread(NJ.state.unread);
  }

  async function route() {
    if (!NJ.state.me) return;
    for (const fn of leaveHandlers) {
      try { fn(); } catch { /* page is going away */ }
    }
    leaveHandlers = [];
    const path = location.hash.slice(1) || '/';
    const item = NAV.find((n) => n.path === path && allowed(n)) || NAV[0];
    for (const a of document.querySelectorAll('.rail nav a')) a.classList.toggle('active', a.getAttribute('href') === `#${item.path}`);
    document.getElementById('page-title').textContent = item.label;
    document.body.classList.toggle('pos-mode', item.path === '/sell'); // the counter takes the whole screen
    const page = document.getElementById('page');
    page.replaceChildren();
    replay(page, 'enter');
    try {
      await NJ.pages[item.path](page);
    } catch (err) {
      page.replaceChildren(h('div', { class: 'notice bad' }, h('b', { text: 'This page could not load. ' }), err.message || String(err)));
    }
  }

  // ----- live updates -----
  function connect() {
    if (stream) stream.close();
    stream = new EventSource('/api/events');
    stream.addEventListener('rates', (e) => {
      NJ.state.rates = JSON.parse(e.data);
      renderRateStrip();
      document.dispatchEvent(new CustomEvent('nj:rates'));
    });
    stream.addEventListener('presence', (e) => {
      NJ.state.online = JSON.parse(e.data);
      renderPresence();
    });
    stream.addEventListener('tv', (e) => {
      const tv = JSON.parse(e.data);
      NJ.state.settings.tv_message = tv.message;
      NJ.state.settings.tv_show_pavan = tv.show_pavan ? '1' : '0';
    });
    stream.addEventListener('message', (e) => {
      const message = JSON.parse(e.data);
      const onMessages = (location.hash.slice(1) || '/') === '/messages';
      if (message.from_user !== NJ.state.me.id && !onMessages) {
        setUnread(NJ.state.unread + 1);
        toast(`${message.from_name}: ${message.body.slice(0, 90)}`);
      }
      document.dispatchEvent(new CustomEvent('nj:message', { detail: message }));
    });
  }

  // ----- sign in -----
  function showSignIn() {
    if (stream) stream.close();
    stream = null;
    NJ.state.me = null;
    document.body.classList.remove('pos-mode');
    for (const d of document.querySelectorAll('dialog')) d.remove();
    const username = h('input', { type: 'text', autocomplete: 'username', autofocus: true });
    const password = h('input', { type: 'password', autocomplete: 'current-password' });
    const err = h('div', { class: 'err', role: 'alert' });
    const go = h('button', { class: 'btn primary big', type: 'submit' }, 'Sign in');
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        go.disabled = true;
        err.textContent = '';
        try {
          await api('POST', '/api/login', { username: username.value, password: password.value });
          await boot(password.value);
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          go.disabled = false;
        }
      },
    },
      h('div', { class: 'brand' }, h('strong', { text: 'Nusky' }), h('span', { text: 'Jewellers' })),
      field('Username', username), field('Password', password), err, go);
    document.getElementById('app').replaceChildren(h('div', { class: 'signin' }, form));
    username.focus();
  }

  // An account on the starter password must choose its own before anything else opens.
  function showNewPassword(account, knownPassword) {
    const current = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', autocomplete: 'new-password' });
    const again = h('input', { type: 'password', autocomplete: 'new-password' });
    const err = h('div', { class: 'err', role: 'alert' });
    const go = h('button', { class: 'btn primary big', type: 'submit' }, 'Save password and continue');
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (next.value !== again.value) {
          err.textContent = 'The two new passwords are not the same. Type them again.';
          return;
        }
        go.disabled = true;
        try {
          await api('POST', '/api/me/password', { current: knownPassword || current.value, next: next.value });
          await boot();
          toast('Password saved. Use it from now on.', 'good');
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          go.disabled = false;
        }
      },
    },
      h('div', { class: 'brand' }, h('strong', { text: 'Nusky' }), h('span', { text: 'Jewellers' })),
      h('h2', { text: 'Choose your own password' }),
      h('p', { class: 'muted', style: 'margin:.4rem 0 1rem', text: `${account.name}, this account is still on the starter password. Choose a new one that only you know. Nothing else opens until you do.` }),
      knownPassword ? null : field('Starter password', current),
      field('New password', next, 'At least 6 characters.'), field('New password again', again), err, go,
      h('p', { style: 'margin:.9rem 0 0; text-align:center' },
        h('button', { class: 'btn link', type: 'button', onclick: async () => { try { await api('POST', '/api/logout'); } catch { /* signed out anyway */ } showSignIn(); } }, 'Sign out')));
    document.getElementById('app').replaceChildren(h('div', { class: 'signin' }, form));
    (knownPassword ? next : current).focus();
  }

  async function boot(knownPassword) {
    const data = await api('GET', '/api/bootstrap');
    if (data.must_change_password) {
      showNewPassword(data.me, knownPassword);
      return;
    }
    Object.assign(NJ.state, {
      me: data.me, settings: data.settings, rates: data.rates, branches: data.branches, users: data.users,
      karats: data.karats, unread: 0,
    });
    renderShell();
    connect();
    route();
    try {
      const threads = await api('GET', '/api/messages/threads');
      setUnread(threads.reduce((sum, t) => sum + t.unread, 0));
    } catch { /* badge is optional */ }
  }

  async function start() {
    window.addEventListener('hashchange', route);
    try {
      await boot();
    } catch {
      if (!NJ.state.me) showSignIn();
    }
  }

  Object.assign(NJ, {
    h, api, plain, money, grams, dateTime, timeOnly, today, r2, val, rateFor, branchName, canManage, canEditRate,
    hallmark, karatSelect, field, toast, fail, modal, confirmBox, printNode, busy, customerForm, customerPicker,
    onLeave, listen, setUnread, renderShell, route, start, rollTo, replay, initials, calmMotion, renderRateStrip, renderPresence,
  });
})();
