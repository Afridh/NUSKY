'use strict';
// Stock, customers, past bills and vouchers, gold rates. The Today page is in today.js.
(function () {
  const { h, api, plain, money, grams, dateTime, today, r2, val, rateFor, branchName, canManage, hallmark, karatSelect,
    field, toast, fail, modal, confirmBox, busy, customerForm, listen } = NJ;

  const branchSelect = (value, withAll) => h('select', { value: String(value || '') },
    withAll ? h('option', { value: '', text: 'All branches' }) : null,
    NJ.state.branches.map((b) => h('option', { value: String(b.id), text: b.name })));

  // ----- stock -----
  function itemForm(existing) {
    return new Promise((resolve) => {
      let saved = null;
      const it = existing || {};
      const name = h('input', { type: 'text', value: it.name || '', maxlength: 120 });
      const sku = h('input', { type: 'text', value: it.sku || '', maxlength: 40 });
      const category = h('input', { type: 'text', value: it.category || '', maxlength: 60, list: 'categories' });
      const karat = karatSelect(it.karat || 22);
      const weight = h('input', { type: 'number', step: '0.001', min: '0', value: it.weight_g || '' });
      const making = h('input', { type: 'number', step: '0.01', min: '0', value: it.making_charge || '' });
      const qty = h('input', { type: 'number', step: '1', min: '0', value: it.qty === undefined ? 1 : it.qty });
      const branch = branchSelect(it.branch_id || NJ.state.me.branch_id);
      const notes = h('textarea', { value: it.notes || '', maxlength: 500 });
      const save = h('button', { class: 'btn primary', type: 'button' }, existing ? 'Save item' : 'Add item');
      const remove = existing ? h('button', { class: 'btn danger', type: 'button' }, 'Delete item') : null;
      const d = modal(existing ? `Edit ${it.sku}` : 'Add stock', h('div', null,
        h('datalist', { id: 'categories' }, ['Ring', 'Necklace', 'Chain', 'Bangle', 'Bracelet', 'Earrings', 'Pendant', 'Anklet', 'Coin', 'Bar'].map((c) => h('option', { value: c }))),
        field('Item name', name),
        h('div', { class: 'row' }, field('Tag number', sku, existing ? '' : 'Leave empty to get one automatically.'), field('Category', category)),
        h('div', { class: 'row' }, field('Karat', karat), field('Weight (g)', weight), field('Making charge', making)),
        h('div', { class: 'row' }, field('Quantity', qty, 'Pieces of this exact weight.'), field('Branch', branch, existing ? 'Change this to transfer the item.' : '')),
        field('Notes', notes)),
      [remove, h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel'), save],
      { onClose: () => resolve(saved) });
      save.addEventListener('click', busy(save, async () => {
        const body = { name: name.value, sku: sku.value, category: category.value, karat: karat.value, weight_g: weight.value,
          making_charge: making.value, qty: qty.value, branch_id: branch.value, notes: notes.value };
        saved = existing ? await api('PUT', `/api/items/${existing.id}`, body) : await api('POST', '/api/items', body);
        toast(existing ? 'Item saved' : `Item added with tag ${saved.sku}`, 'good');
        d.close();
      }));
      if (remove) {
        remove.addEventListener('click', busy(remove, async () => {
          if (!(await confirmBox(`Delete ${it.name} (${it.sku}) from stock?`, 'Delete item', true))) return;
          await api('DELETE', `/api/items/${existing.id}`);
          saved = { deleted: true };
          toast('Item deleted', 'good');
          d.close();
        }));
      }
      name.focus();
    });
  }

  NJ.pages['/stock'] = async (page) => {
    const q = h('input', { type: 'search', placeholder: 'Tag number, name or category' });
    const karat = h('select', null, h('option', { value: '', text: 'All karats' }), NJ.state.karats.map((k) => h('option', { value: String(k), text: `${k}K` })));
    const branch = branchSelect('', true);
    const stock = h('select', null, h('option', { value: 'in', text: 'In stock' }), h('option', { value: 'out', text: 'Sold out' }), h('option', { value: '', text: 'Everything' }));
    const body = h('tbody');
    const totals = h('div', { class: 'figures' });
    let timer = null;
    let rows = [];

    function render() {
      const byKarat = new Map();
      for (const it of rows) {
        const t = byKarat.get(it.karat) || { pieces: 0, weight: 0 };
        t.pieces += it.qty;
        t.weight += it.weight_g * it.qty;
        byKarat.set(it.karat, t);
      }
      totals.replaceChildren(...NJ.state.karats.map((k) => {
        const t = byKarat.get(k) || { pieces: 0, weight: 0 };
        return h('div', null, h('span', null, hallmark(k), ` ${t.pieces} ${t.pieces === 1 ? 'piece' : 'pieces'}`), h('b', { text: grams(t.weight) }));
      }));
      if (!rows.length) {
        body.replaceChildren(h('tr', null, h('td', { colspan: '8', class: 'empty', text: canManage() ? 'Nothing matches. Add stock to see it here.' : 'Nothing matches.' })));
        return;
      }
      body.replaceChildren(...rows.map((it) => h('tr', {
        class: canManage() ? 'click' : '',
        onclick: canManage() ? async () => { if (await itemForm(it)) load(); } : null,
      },
        h('td', { class: 'nowrap', text: it.sku }), h('td', null, h('b', { text: it.name }), it.category ? h('div', { class: 'small muted', text: it.category }) : null),
        h('td', null, hallmark(it.karat)), h('td', { class: 'right nowrap', text: grams(it.weight_g) }),
        h('td', { class: 'right', text: plain(it.making_charge) }),
        h('td', { class: 'right nowrap', text: plain(it.weight_g * rateFor(it.karat).sell_rate + it.making_charge) }),
        h('td', { class: 'right', text: String(it.qty) }), h('td', { text: branchName(it.branch_id) }))));
    }
    async function load() {
      const params = new URLSearchParams({ q: q.value.trim(), karat: karat.value, branch_id: branch.value, stock: stock.value });
      rows = await api('GET', `/api/items?${params}`);
      render();
    }
    const reload = () => load().catch(fail);
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(reload, 250); });
    for (const el of [karat, branch, stock]) el.addEventListener('change', reload);
    listen('nj:rates', render);

    page.append(
      h('div', { class: 'toolbar' }, h('div', { class: 'field grow' }, q), h('div', { class: 'field' }, karat), h('div', { class: 'field' }, branch), h('div', { class: 'field' }, stock),
        canManage() ? h('button', { class: 'btn primary', type: 'button', onclick: async () => { if (await itemForm()) load(); } }, 'Add stock') : null),
      totals,
      h('div', { class: 'panel scroll' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Tag'), h('th', null, 'Item'), h('th', null, 'Karat'), h('th', { class: 'right' }, 'Weight'),
          h('th', { class: 'right' }, 'Making'), h('th', { class: 'right' }, 'Price today'), h('th', { class: 'right' }, 'Qty'), h('th', null, 'Branch'))),
        body)));
    await load();
  };

  // ----- customers -----
  async function customerDetail(id, onChange) {
    const data = await api('GET', `/api/customers/${id}`);
    const c = data.customer;
    const list = (rows, label, open) => rows.length
      ? h('table', null, h('tbody', null, rows.map((r) => h('tr', { class: `click ${r.status === 'void' ? 'void' : ''}`, onclick: () => open(r.id) },
        h('td', { text: r.invoice_no || r.voucher_no }), h('td', { text: dateTime(r.created_at) }), h('td', { class: 'right', text: plain(r.total) })))))
      : h('p', { class: 'muted', text: label });
    const d = modal(c.name, h('div', null,
      h('p', null, [c.phone, c.id_number && `ID ${c.id_number}`, c.address].filter(Boolean).join(', ') || 'No contact details saved.'),
      c.notes ? h('p', { class: 'muted', text: c.notes }) : null,
      h('h3', { text: 'Bought from us' }), list(data.sales, 'No purchases yet.', async (sid) => NJ.showSale(await api('GET', `/api/sales/${sid}`))),
      h('h3', { style: 'margin-top:1rem', text: 'Sold to us' }), list(data.purchases, 'Has not sold us any gold.', async (pid) => NJ.showPurchase(await api('GET', `/api/purchases/${pid}`)))),
    [h('button', { class: 'btn', type: 'button', onclick: async () => { d.close(); if (await customerForm(c)) onChange(); } }, 'Edit details')],
    { wide: true });
  }

  NJ.pages['/customers'] = async (page) => {
    const q = h('input', { type: 'search', placeholder: 'Name, phone or ID number' });
    const body = h('tbody');
    let timer = null;
    async function load() {
      const rows = await api('GET', `/api/customers?q=${encodeURIComponent(q.value.trim())}`);
      body.replaceChildren(...(rows.length
        ? rows.map((c) => h('tr', { class: 'click', onclick: () => customerDetail(c.id, load).catch(fail) },
          h('td', null, h('b', { text: c.name })), h('td', { text: c.phone }), h('td', { text: c.id_number }), h('td', { text: c.address })))
        : [h('tr', null, h('td', { colspan: '4', class: 'empty', text: q.value.trim() ? 'No customer matches that.' : 'No customers yet. Add your first one.' }))]));
    }
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(fail), 250); });
    page.append(
      h('div', { class: 'toolbar' }, h('div', { class: 'field grow' }, q),
        h('button', { class: 'btn primary', type: 'button', onclick: async () => { if (await customerForm()) load(); } }, 'New customer')),
      h('div', { class: 'panel scroll' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Phone'), h('th', null, 'ID number'), h('th', null, 'Address'))), body)));
    await load();
  };

  // ----- bills and vouchers -----
  NJ.pages['/bills'] = async (page) => {
    let tab = 'sales';
    const from = h('input', { type: 'date', value: today() });
    const to = h('input', { type: 'date', value: today() });
    const branch = branchSelect('', true);
    const head = h('thead');
    const body = h('tbody');
    const foot = h('tfoot');
    const tabs = h('div', { class: 'tabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', onclick: () => pick('sales') }, 'Sales'),
      h('button', { type: 'button', role: 'tab', onclick: () => pick('purchases') }, 'Gold bought'));

    async function load() {
      const params = new URLSearchParams({ from: from.value, to: to.value, branch_id: branch.value });
      const rows = await api('GET', `/api/${tab}?${params}`);
      const live = rows.filter((r) => r.status !== 'void');
      if (tab === 'sales') {
        head.replaceChildren(h('tr', null, h('th', null, 'Invoice'), h('th', null, 'Time'), h('th', null, 'Customer'), h('th', null, 'Served by'), h('th', null, 'Branch'), h('th', { class: 'right' }, 'Total')));
        body.replaceChildren(...rows.map((s) => h('tr', { class: `click ${s.status === 'void' ? 'void' : ''}`, onclick: async () => { try { NJ.showSale(await api('GET', `/api/sales/${s.id}`), load); } catch (err) { fail(err); } } },
          h('td', { text: s.invoice_no }), h('td', { class: 'nowrap', text: dateTime(s.created_at) }), h('td', { text: s.customer_name || 'Walk-in' }),
          h('td', { text: s.user_name }), h('td', { text: branchName(s.branch_id) }), h('td', { class: 'right', text: plain(s.total) }))));
      } else {
        head.replaceChildren(h('tr', null, h('th', null, 'Voucher'), h('th', null, 'Time'), h('th', null, 'Customer'), h('th', null, 'Bought by'), h('th', null, 'Paid by'), h('th', { class: 'right' }, 'Weight'), h('th', { class: 'right' }, 'Total')));
        body.replaceChildren(...rows.map((p) => h('tr', { class: `click ${p.status === 'void' ? 'void' : ''}`, onclick: async () => { try { NJ.showPurchase(await api('GET', `/api/purchases/${p.id}`), load); } catch (err) { fail(err); } } },
          h('td', { text: p.voucher_no }), h('td', { class: 'nowrap', text: dateTime(p.created_at) }), h('td', { text: p.customer_name || '' }),
          h('td', { text: p.user_name }), h('td', { text: p.payment_method === 'bank' ? 'Bank transfer' : p.payment_method === 'exchange' ? 'Exchange' : 'Cash' }),
          h('td', { class: 'right nowrap', text: grams(p.weight_g) }), h('td', { class: 'right', text: plain(p.total) }))));
      }
      const span = tab === 'sales' ? 5 : 6;
      if (!rows.length) {
        body.replaceChildren(h('tr', null, h('td', { colspan: String(span + 1), class: 'empty', text: tab === 'sales' ? 'No bills in these dates.' : 'No gold bought in these dates.' })));
        foot.replaceChildren();
      } else {
        foot.replaceChildren(h('tr', null, h('td', { colspan: String(span), text: `${live.length} ${tab === 'sales' ? 'bills' : 'vouchers'}, cancelled ones left out` }),
          h('td', { class: 'right', text: money(r2(live.reduce((sum, r) => sum + r.total, 0))) })));
      }
    }
    function pick(next) {
      tab = next;
      [...tabs.children].forEach((b, i) => {
        const on = (i === 0) === (tab === 'sales');
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      load().catch(fail);
    }
    for (const el of [from, to, branch]) el.addEventListener('change', () => load().catch(fail));
    page.append(tabs,
      h('div', { class: 'toolbar' }, field('From', from), field('To', to), field('Branch', branch)),
      h('div', { class: 'panel scroll' }, h('table', null, head, body, foot)));
    pick('sales');
  };

  // ----- gold rates -----
  NJ.pages['/rates'] = async (page) => {
    const editable = canManage();
    const inputs = {};
    const body = h('tbody', null, NJ.state.rates.map((r) => {
      inputs[r.karat] = {
        sell: h('input', { type: 'number', step: '0.01', min: '0', value: r.sell_rate || '', disabled: !editable, 'aria-label': `${r.karat}K selling rate` }),
        buy: h('input', { type: 'number', step: '0.01', min: '0', value: r.buy_rate || '', disabled: !editable, 'aria-label': `${r.karat}K buying rate` }),
      };
      return h('tr', null, h('td', null, hallmark(r.karat)), h('td', null, inputs[r.karat].sell), h('td', null, inputs[r.karat].buy),
        h('td', { class: 'muted small', text: r.updated_at ? `Changed ${dateTime(r.updated_at)}` : 'Not set yet' }));
    }));
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Update rates');
    const history = h('tbody');

    async function loadHistory() {
      const rows = await api('GET', '/api/rates/history');
      history.replaceChildren(...(rows.length
        ? rows.map((r) => h('tr', null, h('td', { class: 'nowrap', text: dateTime(r.created_at) }), h('td', null, hallmark(r.karat)),
          h('td', { class: 'right', text: plain(r.sell_rate) }), h('td', { class: 'right', text: plain(r.buy_rate) }), h('td', { text: r.user_name || '' })))
        : [h('tr', null, h('td', { colspan: '5', class: 'empty', text: 'No rate changes yet.' }))]));
    }
    function fillFrom24() {
      const sell = val(inputs[24].sell);
      const buy = val(inputs[24].buy);
      if (!(sell > 0)) return toast('Enter the 24K selling rate first.', 'bad');
      for (const k of [22, 21, 18]) {
        inputs[k].sell.value = Math.round((sell * k) / 24);
        if (buy > 0) inputs[k].buy.value = Math.round((buy * k) / 24);
      }
      toast('Filled 22K, 21K and 18K by purity, rounded to whole numbers. Adjust them if your prices differ, then update.');
    }
    save.addEventListener('click', busy(save, async () => {
      await api('PUT', '/api/rates', {
        rates: NJ.state.karats.map((k) => ({ karat: k, sell_rate: val(inputs[k].sell), buy_rate: val(inputs[k].buy) })),
      });
      toast('Rates updated on every counter and the shop TV', 'good');
      loadHistory().catch(fail);
    }));

    page.append(
      h('div', { class: 'panel', style: 'max-width:760px' },
        h('p', { class: 'muted', text: `Rates are per gram (${NJ.state.settings.currency}). Every counter and the shop TV change the moment you update.` }),
        h('div', { class: 'scroll' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Karat'), h('th', null, 'We sell at'), h('th', null, 'We buy at'), h('th'))), body)),
        editable
          ? h('div', { class: 'row', style: 'margin-top:1rem' },
            h('button', { class: 'btn fit', type: 'button', onclick: fillFrom24 }, 'Work out 22K, 21K and 18K from 24K'), h('span'), h('div', { class: 'fit' }, save))
          : h('p', { class: 'muted', style: 'margin-top:1rem', text: 'Only managers and admins can change rates.' })),
      h('div', { class: 'panel scroll', style: 'max-width:760px' }, h('h2', { text: 'Rate changes' }), h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Karat'), h('th', { class: 'right' }, 'Sell'), h('th', { class: 'right' }, 'Buy'), h('th', null, 'Changed by'))), history)));
    await loadHistory();
  };

  NJ.branchSelect = branchSelect;
})();
