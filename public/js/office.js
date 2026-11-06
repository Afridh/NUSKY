'use strict';
// Messages, reports and settings. The Shop TV page is in tvsetup.js.
(function () {
  const { h, api, plain, money, grams, dateTime, timeOnly, today, rateFor, branchName, hallmark, field, toast, fail, modal, busy, listen } = NJ;

  // ----- messages -----
  NJ.pages['/messages'] = async (page) => {
    const me = NJ.state.me;
    let tab = 'staff';
    let active = 'all';
    let threads = [];
    const shown = new Set();
    const pane = h('div');
    const tabs = h('div', { class: 'tabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', onclick: () => pick('staff') }, 'Staff'),
      h('button', { type: 'button', role: 'tab', onclick: () => pick('customers') }, 'Customers'));

    // staff chat
    const threadList = h('div', { class: 'threads' });
    const log = h('div', { class: 'log', 'aria-live': 'polite' });
    const text = h('input', { type: 'text', placeholder: 'Write a message', maxlength: 2000, 'aria-label': 'Message' });
    const send = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
    const form = h('form', null, text, send);
    const chat = h('div', { class: 'chat' }, threadList, h('div', { class: 'talk' }, log, form));

    function bubble(m) {
      if (shown.has(m.id)) return;
      shown.add(m.id);
      const empty = log.querySelector('.empty');
      if (empty) empty.remove();
      const mine = m.from_user === me.id;
      log.append(h('div', { class: `bubble ${mine ? 'mine' : ''}` },
        h('small', { text: `${mine ? 'You' : m.from_name}, ${timeOnly(m.created_at)}` }), m.body));
      log.scrollTop = log.scrollHeight;
    }
    function renderThreads() {
      threadList.replaceChildren(...threads.map((t) => h('button', { type: 'button', class: t.key === active ? 'active' : '', onclick: () => open(t.key).catch(fail) },
        h('span', null, t.name, t.unread ? h('span', { class: 'badge', text: String(t.unread) }) : null),
        h('small', { text: t.last ? t.last.body : t.key === 'all' ? 'Seen by all staff at every branch' : 'No messages yet' }))));
    }
    async function loadThreads() {
      threads = await api('GET', '/api/messages/threads');
      renderThreads();
      NJ.setUnread(threads.reduce((sum, t) => sum + t.unread, 0));
    }
    async function open(key) {
      active = key;
      const messages = await api('GET', `/api/messages?with=${key}`);
      shown.clear();
      log.replaceChildren();
      if (!messages.length) log.append(h('div', { class: 'empty', text: 'No messages here yet. Say something.' }));
      messages.forEach(bubble);
      await loadThreads();
      text.focus();
    }
    form.addEventListener('submit', busy(send, async () => {
      const body = text.value.trim();
      if (!body) return;
      const m = await api('POST', '/api/messages', { to: active, body });
      text.value = '';
      bubble(m);
      loadThreads().catch(fail);
    }));
    listen('nj:message', async (e) => {
      const m = e.detail;
      const key = m.to_user === null ? 'all' : String(m.from_user === me.id ? m.to_user : m.from_user);
      try {
        if (tab === 'staff' && key === active) {
          bubble(m);
          if (m.from_user !== me.id) await api('POST', '/api/messages/read', { with: active });
        }
        await loadThreads();
      } catch (err) { fail(err); }
    });

    // customer messages
    async function customerPane() {
      const s = NJ.state.settings;
      const template = h('textarea', { maxlength: 1000, value: `Dear {name}, today's 22K rate at {shop} is {rate22} per gram.` });
      const channel = h('select', null, h('option', { value: 'whatsapp', text: 'WhatsApp' }),
        s.sms_gateway_url ? h('option', { value: 'sms', text: 'SMS' }) : null);
      const filter = h('input', { type: 'search', placeholder: 'Filter the list' });
      const list = h('div', { class: 'picklist' });
      const results = h('div');
      const go = h('button', { class: 'btn primary', type: 'button' }, 'Prepare messages');
      const customers = (await api('GET', '/api/customers')).filter((c) => c.phone);
      const picked = new Set();

      function renderList() {
        const q = filter.value.trim().toLowerCase();
        const visible = customers.filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q));
        list.replaceChildren(...(visible.length
          ? visible.map((c) => h('label', null,
            h('input', { type: 'checkbox', checked: picked.has(c.id), onchange: (e) => { if (e.target.checked) picked.add(c.id); else picked.delete(c.id); count(); } }),
            h('span', null, c.name, ' ', h('span', { class: 'muted small', text: c.phone }))))
          : [h('div', { class: 'empty', text: customers.length ? 'No customer matches that filter.' : 'No customers with a phone number yet. Add phone numbers under Customers.' })]));
        return visible;
      }
      const count = () => { go.textContent = channel.value === 'sms' ? `Send SMS to ${picked.size}` : `Prepare ${picked.size} WhatsApp messages`; };
      filter.addEventListener('input', renderList);
      channel.addEventListener('change', count);
      go.addEventListener('click', busy(go, async () => {
        if (!picked.size) throw new Error('Tick at least one customer.');
        const sent = await api('POST', '/api/customer-messages', { customer_ids: [...picked], body: template.value, channel: channel.value });
        results.replaceChildren(h('div', { class: 'panel' },
          h('h2', { text: channel.value === 'sms' ? 'SMS results' : 'Ready to send' }),
          channel.value === 'whatsapp' ? h('p', { class: 'muted', text: 'Each button opens WhatsApp with the message already typed. Press send there. WhatsApp must be set up on this computer or phone.' }) : null,
          h('table', null, h('tbody', null, sent.map((r) => h('tr', null, h('td', null, h('b', { text: r.name }), h('div', { class: 'small muted', text: r.text })),
            h('td', { class: 'right nowrap' }, r.link ? h('a', { class: 'btn', href: r.link, target: '_blank', rel: 'noopener' }, 'Open in WhatsApp') : r.status)))))));
        results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }));
      renderList();
      count();
      return h('div', null,
        h('div', { class: 'cols' },
          h('div', { class: 'panel' }, h('h2', { text: 'Message' }),
            field('What to say', template, 'Write {name} for the customer’s name, {shop} for the shop name, and {rate24}, {rate22}, {rate21} or {rate18} for today’s selling rate.'),
            field('Send by', channel, s.sms_gateway_url ? '' : 'SMS appears here once an admin adds an SMS gateway under Settings.'),
            go),
          h('div', { class: 'panel' }, h('h2', { text: 'Send to' }),
            h('div', { class: 'row', style: 'margin-bottom:.6rem' }, filter,
              h('button', { class: 'btn fit', type: 'button', onclick: () => { for (const c of renderList()) picked.add(c.id); renderList(); count(); } }, 'Tick everyone shown'),
              h('button', { class: 'btn fit', type: 'button', onclick: () => { picked.clear(); renderList(); count(); } }, 'Clear')),
            list)),
        results);
    }

    async function pick(next) {
      tab = next;
      [...tabs.children].forEach((b, i) => {
        const on = (i === 0) === (tab === 'staff');
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      try {
        if (tab === 'staff') {
          pane.replaceChildren(chat);
          await open(active);
        } else {
          pane.replaceChildren(await customerPane());
        }
      } catch (err) { fail(err); }
    }
    page.append(tabs, pane);
    await pick('staff');
  };

  // ----- reports -----
  NJ.pages['/reports'] = async (page) => {
    const from = h('input', { type: 'date', value: today() });
    const to = h('input', { type: 'date', value: today() });
    const branch = NJ.branchSelect('', true);
    const out = h('div');
    let report = null;

    const table = (heads, rows, emptyText) => rows.length
      ? h('div', { class: 'scroll' }, h('table', null,
        h('thead', null, h('tr', null, heads.map((t, i) => h('th', { class: i ? 'right' : '' }, t)))),
        h('tbody', null, rows.map((cells) => h('tr', null, cells.map((c, i) => h('td', { class: i ? 'right nowrap' : '' }, c)))))))
      : h('p', { class: 'muted', text: emptyText });

    function downloadCsv() {
      const lines = [['Date', 'Sales', 'Gold bought'], ...report.days.map((d) => [d.date, d.sales, d.purchases])];
      const blob = new Blob([lines.map((l) => l.join(',')).join('\r\n')], { type: 'text/csv' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `nusky-${report.from}-to-${report.to}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    async function load() {
      const params = new URLSearchParams({ from: from.value, to: to.value, branch_id: branch.value });
      const r = (report = await api('GET', `/api/reports/summary?${params}`));
      out.replaceChildren(
        h('div', { class: 'figures' },
          h('div', null, h('span', { text: 'Sales' }), h('b', { text: plain(r.sales.total) })),
          h('div', null, h('span', { text: 'Bills' }), h('b', { text: String(r.sales.count) })),
          h('div', null, h('span', { text: 'Gold bought' }), h('b', { text: plain(r.purchases.total) })),
          h('div', null, h('span', { text: 'Net cash into the drawer' }), h('b', { text: plain(r.cash_drawer) }))),
        h('div', { class: 'cols' },
          h('div', { class: 'panel' }, h('h2', { text: 'Money' }), table(['', 'Amount'], [
            ['Cash from sales (after change and exchange payouts)', plain(r.sales.cash)],
            ['Card', plain(r.sales.card)],
            ['Bank transfer', plain(r.sales.bank)],
            ['Old gold taken against bills', plain(r.sales.old_gold_value)],
            ['Discounts given', plain(r.sales.discount)],
            ['Tax collected', plain(r.sales.tax)],
            ['Gold bought with cash', plain(r.purchases.cash)],
            ['Gold bought by bank transfer', plain(r.purchases.bank)],
          ])),
          h('div', { class: 'panel' }, h('h2', { text: 'Gold sold' }), table(['Karat', 'Pieces', 'Weight', 'Amount'],
            r.sold_by_karat.map((k) => [hallmark(k.karat), String(k.pieces), grams(k.weight_g), plain(k.amount)]), 'Nothing sold in these dates.')),
          h('div', { class: 'panel' }, h('h2', { text: 'Gold bought' }), table(['Karat', 'Lines', 'Weight', 'Amount'],
            r.bought_by_karat.map((k) => [hallmark(k.karat), String(k.pieces), grams(k.weight_g), plain(k.amount)]), 'No gold bought in these dates.')),
          h('div', { class: 'panel' }, h('h2', { text: 'Sales by staff' }), table(['Name', 'Bills', 'Total'],
            r.by_user.map((u) => [u.name, String(u.count), plain(u.total)]), 'No sales in these dates.')),
          h('div', { class: 'panel' }, h('h2', { text: 'Day by day' }), table(['Date', 'Sales', 'Gold bought'],
            r.days.map((d) => [d.date, plain(d.sales), plain(d.purchases)]), 'Nothing in these dates.'),
            r.days.length ? h('p', { style: 'margin-top:.7rem' }, h('button', { class: 'btn', type: 'button', onclick: downloadCsv }, 'Download as a spreadsheet file')) : null),
          h('div', { class: 'panel' }, h('h2', { text: 'Stock on hand now' }), table(['Karat', 'Pieces', 'Weight', 'Gold value today'],
            r.stock.map((k) => [hallmark(k.karat), String(k.pieces), grams(k.weight_g), plain(k.weight_g * rateFor(k.karat).sell_rate)]), 'No stock recorded.'))));
    }
    for (const el of [from, to, branch]) el.addEventListener('change', () => load().catch(fail));
    page.append(h('div', { class: 'toolbar' }, field('From', from), field('To', to), field('Branch', branch)), out);
    await load();
  };

  // ----- settings -----
  function branchForm(existing) {
    return new Promise((resolve) => {
      let saved = null;
      const b = existing || {};
      const name = h('input', { type: 'text', value: b.name || '', maxlength: 80 });
      const address = h('input', { type: 'text', value: b.address || '', maxlength: 300 });
      const phone = h('input', { type: 'tel', value: b.phone || '', maxlength: 30 });
      const save = h('button', { class: 'btn primary', type: 'button' }, existing ? 'Save branch' : 'Add branch');
      const d = modal(existing ? 'Edit branch' : 'New branch', h('div', null, field('Branch name', name), field('Address', address), field('Phone', phone)),
        [h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel'), save], { onClose: () => resolve(saved) });
      save.addEventListener('click', busy(save, async () => {
        const body = { name: name.value, address: address.value, phone: phone.value };
        saved = existing ? await api('PUT', `/api/branches/${existing.id}`, body) : await api('POST', '/api/branches', body);
        toast(existing ? 'Branch saved' : 'Branch added', 'good');
        d.close();
      }));
      name.focus();
    });
  }

  function userForm(existing) {
    return new Promise((resolve) => {
      let saved = null;
      const u = existing || {};
      const name = h('input', { type: 'text', value: u.name || '', maxlength: 80 });
      const username = h('input', { type: 'text', value: u.username || '', maxlength: 40, disabled: !!existing, autocomplete: 'off' });
      const password = h('input', { type: 'password', autocomplete: 'new-password' });
      const role = h('select', { value: u.role || 'cashier' },
        h('option', { value: 'cashier', text: 'Cashier: sells, buys gold, messages' }),
        h('option', { value: 'manager', text: 'Manager: also rates, stock, cancelling, reports' }),
        h('option', { value: 'admin', text: 'Admin: everything, including staff and settings' }));
      const branch = NJ.branchSelect(u.branch_id || NJ.state.me.branch_id);
      const active = h('input', { type: 'checkbox', checked: existing ? !!u.active : true });
      const save = h('button', { class: 'btn primary', type: 'button' }, existing ? 'Save account' : 'Add account');
      const d = modal(existing ? `Edit ${u.name}` : 'New staff account', h('div', null,
        h('div', { class: 'row' }, field('Name', name), field('Username', username, existing ? 'Usernames cannot be changed.' : '')),
        field(existing ? 'New password' : 'Password', password, existing ? 'Leave empty to keep the current password.' : 'At least 6 characters.'),
        h('div', { class: 'row' }, field('Role', role), field('Branch', branch)),
        existing ? h('label', { class: 'check' }, active, h('span', null, 'This person can sign in')) : null),
      [h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel'), save], { onClose: () => resolve(saved) });
      save.addEventListener('click', busy(save, async () => {
        const body = { name: name.value, username: username.value, password: password.value, role: role.value, branch_id: branch.value, active: active.checked };
        saved = existing ? await api('PUT', `/api/users/${existing.id}`, body) : await api('POST', '/api/users', body);
        toast(existing ? 'Account saved' : 'Account added', 'good');
        d.close();
      }));
      name.focus();
    });
  }

  NJ.pages['/settings'] = async (page) => {
    const s = NJ.state.settings;
    const input = (key, max) => h('input', { type: 'text', value: s[key] || '', maxlength: max || 120 });
    const f = {
      shop_name: input('shop_name'), shop_address: input('shop_address', 300), shop_phone: input('shop_phone'),
      currency: input('currency', 10), tax_percent: h('input', { type: 'number', step: '0.01', min: '0', max: '100', value: s.tax_percent || '0' }),
      receipt_footer: input('receipt_footer', 300), country_code: input('country_code', 5), sms_gateway_url: input('sms_gateway_url', 500),
    };
    const cashierRate = h('input', { type: 'checkbox', checked: s.cashier_edit_rate === '1' });
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save shop details');
    save.addEventListener('click', busy(save, async () => {
      const body = { cashier_edit_rate: cashierRate.checked ? '1' : '0' };
      for (const [key, el] of Object.entries(f)) body[key] = el.value;
      NJ.state.settings = await api('PUT', '/api/settings', body);
      toast('Shop details saved', 'good');
      NJ.renderShell();
      NJ.route();
    }));

    const branchBody = h('tbody');
    const userBody = h('tbody');
    async function loadBranches() {
      const data = await api('GET', '/api/bootstrap');
      NJ.state.branches = data.branches;
      NJ.state.users = data.users;
      branchBody.replaceChildren(...data.branches.map((b) => h('tr', { class: 'click', onclick: async () => { if (await branchForm(b)) refresh(); } },
        h('td', null, h('b', { text: b.name })), h('td', { text: b.address }), h('td', { text: b.phone }))));
    }
    async function loadUsers() {
      const users = await api('GET', '/api/users');
      userBody.replaceChildren(...users.map((u) => h('tr', { class: 'click', onclick: async () => { if (await userForm(u)) refresh(); } },
        h('td', null, h('b', { text: u.name })), h('td', { text: u.username }), h('td', { text: u.role[0].toUpperCase() + u.role.slice(1) }), h('td', { text: branchName(u.branch_id) }),
        h('td', { text: u.active ? 'Can sign in' : 'Blocked' }))));
    }
    async function refresh() {
      try {
        await loadBranches();
        await loadUsers();
      } catch (err) { fail(err); }
    }

    page.append(h('div', { class: 'cols' },
      h('div', null,
        h('div', { class: 'panel' }, h('h2', { text: 'Shop details' }),
          field('Shop name', f.shop_name, 'Shown on bills and on the TV.'),
          field('Address', f.shop_address), field('Phone', f.shop_phone),
          h('div', { class: 'row' }, field('Currency', f.currency, 'For example Rs. or QAR'), field('Tax on sales (%)', f.tax_percent, '0 for no tax.')),
          field('Line at the bottom of bills', f.receipt_footer),
          field('Country calling code', f.country_code, 'Used for WhatsApp links. 94 is Sri Lanka, 974 Qatar, 971 UAE.'),
          field('SMS gateway address (optional)', f.sms_gateway_url, 'From your SMS provider. Put {to} where the phone number goes and {message} where the text goes.'),
          h('label', { class: 'check' }, cashierRate, h('span', null, 'Cashiers can change the rate on a bill or voucher. When off, only managers and admins can.')),
          save),
        h('div', { class: 'panel' }, h('h2', { text: 'Backup' }),
          h('p', null, 'Download a copy of all shop data. Do this every day and keep it somewhere other than this computer, such as a USB drive.'),
          h('a', { class: 'btn', href: '/api/backup' }, 'Download backup'))),
      h('div', null,
        h('div', { class: 'panel' },
          h('div', { class: 'toolbar', style: 'justify-content:space-between' }, h('h2', { text: 'Staff accounts' }),
            h('button', { class: 'btn', type: 'button', onclick: async () => { if (await userForm()) refresh(); } }, 'Add account')),
          h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Username'), h('th', null, 'Role'), h('th', null, 'Branch'), h('th', null, 'Status'))), userBody))),
        h('div', { class: 'panel' },
          h('div', { class: 'toolbar', style: 'justify-content:space-between' }, h('h2', { text: 'Branches' }),
            h('button', { class: 'btn', type: 'button', onclick: async () => { if (await branchForm()) refresh(); } }, 'Add branch')),
          h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Address'), h('th', null, 'Phone'))), branchBody))))));
    await loadBranches();
    await loadUsers();
  };
})();
