'use strict';
// Printed bills and vouchers, and the Buy gold page. The selling counter is in pos.js.
(function () {
  const { h, api, plain, money, grams, dateTime, r2, val, rateFor, canManage, canEditRate, hallmark, karatSelect,
    field, toast, fail, modal, confirmBox, printNode, busy, customerPicker, listen } = NJ;

  // ----- printed documents -----
  function shopHead(doc) {
    const s = NJ.state.settings;
    return [
      doc.status === 'void' ? h('div', { class: 'voidmark', text: 'Cancelled' }) : null,
      h('div', { class: 'head' }, h('h2', { text: s.shop_name }),
        s.shop_address ? h('div', { text: s.shop_address }) : null,
        s.shop_phone ? h('div', { text: `Tel ${s.shop_phone}` }) : null),
    ];
  }

  function customerBlock(c) {
    if (!c) return h('div', null, 'Walk-in customer');
    return h('div', null, h('b', { text: c.name }), c.phone ? h('div', { text: c.phone }) : null,
      c.id_number ? h('div', { text: `ID ${c.id_number}` }) : null, c.address ? h('div', { text: c.address }) : null);
  }

  const sumLine = (label, amount, cls) => h('div', { class: cls || '' }, h('span', { text: label }), h('span', { text: amount }));

  function goldTable(items) {
    return h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Description'), h('th', null, 'Karat'), h('th', { class: 'right' }, 'Weight'),
        h('th', { class: 'right' }, 'Rate per g'), h('th', { class: 'right' }, 'Value'))),
      h('tbody', null, items.map((l) => h('tr', null, h('td', { text: l.description }), h('td', { text: `${l.karat}K` }),
        h('td', { class: 'right', text: grams(l.weight_g) }), h('td', { class: 'right', text: plain(l.rate) }), h('td', { class: 'right', text: plain(l.line_total) })))));
  }

  function saleReceipt(s) {
    const net = s.net_payable;
    return h('div', { class: 'receipt' }, shopHead(s),
      h('div', { class: 'meta' },
        h('div', null, h('b', { text: s.title || `Invoice ${s.invoice_no}` }), h('div', { text: dateTime(s.created_at) }), h('div', { text: `${s.branch_name}, served by ${s.user_name}` })),
        customerBlock(s.customer)),
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', null, 'Karat'), h('th', { class: 'right' }, 'Weight'),
          h('th', { class: 'right' }, 'Rate per g'), h('th', { class: 'right' }, 'Making'), h('th', { class: 'right' }, 'Amount'))),
        h('tbody', null, s.items.map((l) => h('tr', null,
          h('td', null, l.description, l.qty > 1 ? ` × ${l.qty}` : '', l.sku ? h('div', { class: 'small', text: l.sku }) : null),
          h('td', { text: `${l.karat}K (${NJ.FINENESS[l.karat]})` }), h('td', { class: 'right', text: grams(l.weight_g) }),
          h('td', { class: 'right', text: plain(l.rate) }), h('td', { class: 'right', text: plain(l.making_charge) }), h('td', { class: 'right', text: plain(l.line_total) }))))),
      s.exchange ? [h('h3', { text: s.exchange.voucher_no ? `Old gold taken in exchange (${s.exchange.voucher_no})` : 'Old gold to be taken in exchange' }), goldTable(s.exchange.items)] : null,
      h('div', { class: 'sum' },
        sumLine('Subtotal', plain(s.subtotal)),
        s.discount ? sumLine('Discount', `− ${plain(s.discount)}`) : null,
        s.tax ? sumLine('Tax', plain(s.tax)) : null,
        sumLine('Total', money(s.total), 'grand'),
        s.old_gold_value ? sumLine('Less old gold', `− ${plain(s.old_gold_value)}`) : null,
        s.old_gold_value ? sumLine(net < 0 ? 'Paid to customer' : 'Amount due', money(Math.abs(net)), 'grand') : null,
        s.cash_tendered ? sumLine('Cash received', plain(s.cash_tendered)) : null,
        s.paid_card ? sumLine('Card', plain(s.paid_card)) : null,
        s.paid_bank ? sumLine('Bank transfer', plain(s.paid_bank)) : null,
        s.change_given ? sumLine('Change', plain(s.change_given)) : null),
      s.note ? h('p', { class: 'small', text: `Note: ${s.note}` }) : null,
      h('div', { class: 'foot', text: NJ.state.settings.receipt_footer || '' }));
  }

  function purchaseReceipt(p) {
    const how = p.payment_method === 'exchange' ? `Exchanged against invoice ${p.sale_invoice_no || ''}`
      : p.payment_method === 'bank' ? 'Paid by bank transfer' : 'Paid in cash';
    return h('div', { class: 'receipt' }, shopHead(p),
      h('div', { class: 'meta' },
        h('div', null, h('b', { text: `Gold purchase voucher ${p.voucher_no}` }), h('div', { text: dateTime(p.created_at) }), h('div', { text: `${p.branch_name}, bought by ${p.user_name}` })),
        customerBlock(p.customer)),
      goldTable(p.items),
      h('div', { class: 'sum' }, sumLine('Total paid', money(p.total), 'grand'), sumLine(how, '')),
      p.note ? h('p', { class: 'small', text: `Note: ${p.note}` }) : null,
      h('div', { class: 'sign' }, h('span', { text: 'Customer signature' }), h('span', { text: `For ${NJ.state.settings.shop_name}` })));
  }

  function showSale(sale, onChange) {
    const doc = saleReceipt(sale);
    const d = modal(`Invoice ${sale.invoice_no}`, doc, [
      canManage() && sale.status !== 'void' ? h('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => {
          if (!(await confirmBox(`Cancel invoice ${sale.invoice_no}? Its items go back into stock${sale.exchange ? ' and the exchanged gold is cancelled too' : ''}.`, 'Cancel this bill', true))) return;
          try {
            const updated = await api('POST', `/api/sales/${sale.id}/void`);
            toast('Bill cancelled', 'good');
            d.close();
            if (onChange) onChange(updated);
          } catch (err) { fail(err); }
        },
      }, 'Cancel this bill') : null,
      h('button', { class: 'btn primary', type: 'button', onclick: () => printNode(doc) }, 'Print'),
    ], { wide: true });
    return d;
  }

  function showPurchase(p, onChange) {
    const doc = purchaseReceipt(p);
    const d = modal(`Voucher ${p.voucher_no}`, doc, [
      canManage() && p.status !== 'void' && !p.sale_id ? h('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => {
          if (!(await confirmBox(`Cancel voucher ${p.voucher_no}?`, 'Cancel this voucher', true))) return;
          try {
            const updated = await api('POST', `/api/purchases/${p.id}/void`);
            toast('Voucher cancelled', 'good');
            d.close();
            if (onChange) onChange(updated);
          } catch (err) { fail(err); }
        },
      }, 'Cancel this voucher') : null,
      h('button', { class: 'btn primary', type: 'button', onclick: () => printNode(doc) }, 'Print'),
    ], { wide: true });
    return d;
  }

  // ----- gold bought from a customer (used on both counter pages) -----
  const newGoldLine = () => ({ description: '', karat: 22, weight_g: '', rate: rateFor(22).buy_rate, rateEdited: false });
  const goldValue = (l) => r2((Number(l.weight_g) || 0) * (Number(l.rate) || 0));
  const goldTotal = (lines) => r2(lines.reduce((sum, l) => sum + goldValue(l), 0));
  const goldPayload = (lines) => lines.map((l) => ({
    description: l.description, karat: l.karat, weight_g: l.weight_g, rate: l.rateEdited ? l.rate : undefined,
  }));

  function goldRows(lines, tbody, changed) {
    tbody.replaceChildren(...lines.map((ln, i) => {
      const value = h('td', { class: 'right nowrap' });
      const show = () => { value.textContent = plain(goldValue(ln)); };
      const rate = h('input', {
        type: 'number', step: '0.01', min: '0', value: ln.rate, disabled: !canEditRate(), 'aria-label': 'Buying rate per gram',
        oninput: () => { ln.rate = rate.value; ln.rateEdited = true; show(); changed(); },
      });
      show();
      return h('tr', null,
        h('td', null, h('input', { type: 'text', value: ln.description, placeholder: 'For example: broken chain', 'aria-label': 'Description', oninput: (e) => { ln.description = e.target.value; } })),
        h('td', null, karatSelect(ln.karat, (e) => {
          ln.karat = Number(e.target.value);
          if (!ln.rateEdited) { ln.rate = rateFor(ln.karat).buy_rate; rate.value = ln.rate; }
          show(); changed();
        })),
        h('td', null, h('input', { type: 'number', step: '0.001', min: '0', value: ln.weight_g, placeholder: '0.000', 'aria-label': 'Weight in grams', oninput: (e) => { ln.weight_g = e.target.value; show(); changed(); } })),
        h('td', null, rate), value,
        h('td', null, h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Remove this line', onclick: () => { lines.splice(i, 1); goldRows(lines, tbody, changed); changed(); } }, '✕')));
    }));
  }

  const goldHead = () => h('thead', null, h('tr', null, h('th', null, 'Description'), h('th', null, 'Karat'), h('th', null, 'Weight (g)'),
    h('th', null, 'Rate per g'), h('th', { class: 'right' }, 'Value'), h('th')));

  function refreshGoldRates(lines) {
    for (const l of lines) if (!l.rateEdited) l.rate = rateFor(l.karat).buy_rate;
  }

  // ----- buy gold -----
  NJ.pages['/buy'] = async (page) => {
    const lines = [newGoldLine()];
    const picker = customerPicker();
    const body = h('tbody');
    const total = h('span');
    const method = h('select', null, h('option', { value: 'cash', text: 'Cash' }), h('option', { value: 'bank', text: 'Bank transfer' }));
    const note = h('input', { type: 'text', maxlength: 500 });
    const complete = h('button', { class: 'btn primary big', type: 'button' }, 'Complete purchase');
    const update = () => { total.textContent = money(goldTotal(lines)); };

    complete.addEventListener('click', busy(complete, async () => {
      const customer = picker.get();
      if (!customer) throw new Error('Choose the customer you are buying from. Their details go on the voucher.');
      const filled = lines.filter((l) => Number(l.weight_g) > 0);
      if (!filled.length) throw new Error('Enter the weight of the gold you are buying.');
      const purchase = await api('POST', '/api/purchases', {
        customer_id: customer.id, items: goldPayload(filled), payment_method: method.value, note: note.value,
      });
      toast(`Purchase completed: ${purchase.voucher_no}`, 'good');
      lines.splice(0, lines.length, newGoldLine());
      note.value = '';
      picker.set(null);
      goldRows(lines, body, update);
      update();
      showPurchase(purchase);
    }));

    listen('nj:rates', () => {
      refreshGoldRates(lines);
      goldRows(lines, body, update);
      update();
      toast('Gold rates just changed. This voucher now uses the new rates.');
    });

    const missing = NJ.state.rates.filter((r) => !(r.buy_rate > 0)).map((r) => `${r.karat}K`);
    page.append(h('div', { class: 'counter single' },
      missing.length ? h('div', { class: 'notice' }, `No buying rate is set for ${missing.join(', ')}. Set today's rates under Gold rates.`) : null,
      h('div', { class: 'panel' },
        h('h2', { text: 'Gold from the customer' }),
        field('Customer', picker.el, 'Record who you are buying from, with their NIC or passport number.'),
        h('div', { class: 'scroll' }, h('table', null, goldHead(), body)),
        h('p', { style: 'margin-top:.6rem' }, h('button', { class: 'btn', type: 'button', onclick: () => { lines.push(newGoldLine()); goldRows(lines, body, update); } }, 'Add another line')),
        h('div', { class: 'totals' }, h('div', { class: 'due' }, h('span', { text: 'Pay the customer' }), total)),
        h('div', { class: 'row', style: 'margin-top:.8rem' }, field('Paid by', method), field('Note on the voucher (optional)', note)),
        complete)));
    goldRows(lines, body, update);
    update();
  };

  Object.assign(NJ, { showSale, showPurchase, saleReceipt });
})();
