'use strict';
// The selling counter: scan row, bill lines, summary panel and function keys.
// Built to be worked from the keyboard, with the scanner always ready.
(function () {
  const { h, api, plain, money, grams, r2, val, rateFor, branchName, canEditRate, hallmark, karatSelect, toast, fail, modal,
    confirmBox, printNode, busy, customerPicker, listen, onLeave, rollTo, replay, calmMotion, timeOnly } = NJ;

  const chip = (text, kind) => h('span', { class: `chip ${kind || ''}`, text });
  const labelled = (label, key, control, cls) => h('label', { class: cls || '' }, h('span', null, label, key ? h('kbd', { text: key }) : null), control);
  const isGold = (l) => l.kind === 'gold';
  const amountOf = (l) => (isGold(l)
    ? -r2((Number(l.weight_g) || 0) * (Number(l.rate) || 0))
    : r2(((Number(l.weight_g) || 0) * (Number(l.rate) || 0) + (Number(l.making_charge) || 0)) * (Number(l.qty) || 0)));

  NJ.pages['/sell'] = async (page) => {
    const me = NJ.state.me;
    const taxPercent = Number(NJ.state.settings.tax_percent) || 0;
    const HOLD_KEY = `nusky-held-bills-${me.id}`;
    let lines = [];
    let customer = null;
    let sel = -1;
    let found = [];
    let active = 0;
    let dropOpen = false;
    let timer = null;
    let searchSeq = 0;

    // ----- top band -----
    const custName = h('h2');
    const custSub = h('div', { class: 'small muted' });
    const custClear = h('button', { class: 'btn icon hidden', type: 'button', 'aria-label': 'Back to walk-in customer', onclick: (e) => { e.stopPropagation(); setCustomer(null); } }, '✕');
    const custCard = h('div', { class: 'card pos-cust', role: 'button', tabindex: '0', onclick: chooseCustomer, onkeydown: (e) => { if (e.key === 'Enter') chooseCustomer(); } },
      h('div', null, custName, custSub), custClear);
    function setCustomer(c) {
      customer = c;
      custName.textContent = c ? c.name : 'Walk-in customer';
      custSub.textContent = c
        ? [c.phone, c.id_number && `ID ${c.id_number}`].filter(Boolean).join(', ') || 'No phone or ID saved'
        : `No customer chosen. Press F4 to choose one. Cashier ${me.name}`;
      custClear.classList.toggle('hidden', !c);
      replay(custName, 'pop');
    }

    const clockDay = h('span');
    const clockTime = h('b');
    const clockNum = h('span', { class: 'daynum' });
    function tick() {
      const d = new Date();
      clockDay.textContent = d.toLocaleDateString(undefined, { weekday: 'long' });
      clockTime.textContent = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      clockNum.textContent = String(d.getDate());
    }
    tick();
    const clockTimer = setInterval(tick, 1000);
    onLeave(() => clearInterval(clockTimer));

    const invNo = h('b', { class: 'invno', text: '…' });
    async function loadNext() {
      try {
        invNo.textContent = (await api('GET', '/api/sales/next')).invoice_no;
      } catch { /* the number is only a preview */ }
    }
    const info = h('div', { class: 'info' });

    // ----- entry row -----
    const tagIn = h('input', { type: 'text', placeholder: 'Scan or type a tag', autocomplete: 'off', 'aria-label': 'Scan a tag' });
    const itemIn = h('input', { type: 'text', placeholder: 'Search stock, or describe an item', autocomplete: 'off', 'aria-label': 'Find an item' });
    const drop = h('ul', { class: 'drop', role: 'listbox' });
    const eKarat = karatSelect(22, entryAmount);
    const eWeight = h('input', { type: 'number', step: '0.001', min: '0', placeholder: '0.000', oninput: entryAmount });
    const eMaking = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '0', oninput: entryAmount });
    const eAmount = h('output', { text: '0.00' });
    function entryAmount() {
      eAmount.textContent = plain(val(eWeight) * rateFor(eKarat.value).sell_rate + val(eMaking));
    }

    const inCart = (itemId) => lines.filter((l) => l.item_id === itemId).reduce((n, l) => n + Number(l.qty || 0), 0);

    function renderDrop() {
      if (!found.length) {
        drop.replaceChildren(h('li', { class: 'none', text: itemIn.value.trim()
          ? 'Nothing in stock matches. To sell it anyway, fill in karat and weight and press Enter.'
          : 'No stock at this branch yet. Add items under Stock.' }));
        return;
      }
      drop.replaceChildren(...found.slice(0, 40).map((item, i) => {
        const left = item.qty - inCart(item.id);
        return h('li', { class: `${i === active ? 'on' : ''} ${left < 1 ? 'used' : ''}`, role: 'option', onmousedown: (e) => { e.preventDefault(); pick(item); } },
          hallmark(item.karat),
          h('div', null, h('b', { text: item.name }),
            h('small', { text: `${item.sku}, ${grams(item.weight_g)}${left < 1 ? ', already on the bill' : item.qty > 1 ? `, ${left} left` : ''}` })),
          h('div', { class: 'right nowrap', text: plain(item.weight_g * rateFor(item.karat).sell_rate + item.making_charge) }));
      }));
      const on = drop.querySelector('.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    }
    async function runSearch() {
      const seq = ++searchSeq;
      const rows = await api('GET', `/api/items?stock=in&branch_id=${me.branch_id}&q=${encodeURIComponent(itemIn.value.trim())}`);
      if (seq !== searchSeq) return; // a newer search has started; drop this late answer
      found = rows;
      active = 0;
      renderDrop();
    }
    function openDrop() {
      dropOpen = true;
      drop.classList.add('open');
      runSearch().catch(fail);
    }
    function closeDrop() {
      dropOpen = false;
      drop.classList.remove('open');
    }
    function pick(item) {
      addStock(item);
      itemIn.value = '';
      closeDrop();
      tagIn.focus();
    }
    itemIn.addEventListener('focus', openDrop);
    itemIn.addEventListener('blur', () => setTimeout(closeDrop, 150));
    itemIn.addEventListener('input', () => {
      clearTimeout(timer);
      if (!dropOpen) { dropOpen = true; drop.classList.add('open'); }
      timer = setTimeout(() => runSearch().catch(fail), 160);
    });
    itemIn.addEventListener('keydown', async (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!found.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + Math.min(found.length, 40)) % Math.min(found.length, 40);
        renderDrop();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(timer);
        try {
          await runSearch();
          if (found.length && dropOpen) pick(found[active]);
          else if (itemIn.value.trim()) { closeDrop(); eWeight.focus(); }
        } catch (err) { fail(err); }
      }
    });
    for (const el of [eKarat, eWeight, eMaking]) {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });
    }
    tagIn.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = tagIn.value.trim();
      if (!q) return;
      tagIn.value = '';
      try {
        const rows = await api('GET', `/api/items?stock=in&branch_id=${me.branch_id}&q=${encodeURIComponent(q)}`);
        const hit = rows.find((i) => (i.sku || '').toLowerCase() === q.toLowerCase());
        if (hit) addStock(hit);
        else toast(`Tag ${q} is not in stock at this branch.`, 'bad');
      } catch (err) { fail(err); }
    });

    // ----- bill lines -----
    const tbody = h('tbody');
    const itemName = h('b', { text: 'No item selected' });
    const itemSub = h('div');

    function addStock(item) {
      const rate = rateFor(item.karat).sell_rate;
      if (!(rate > 0)) return toast(`Set today's ${item.karat}K selling rate before selling this.`, 'bad');
      if (inCart(item.id) >= item.qty) return toast(`All of ${item.name} in stock is already on the bill.`, 'bad');
      const at = lines.findIndex((l) => l.item_id === item.id);
      if (at >= 0) {
        lines[at].qty = Number(lines[at].qty) + 1;
        sel = at;
      } else {
        lines.push({ kind: 'item', item_id: item.id, sku: item.sku, description: item.name, karat: item.karat, weight_g: item.weight_g,
          rate, rateEdited: false, making_charge: item.making_charge, qty: 1, max: item.qty });
        sel = lines.length - 1;
      }
      renderLines(sel);
    }
    function addCustom() {
      const description = itemIn.value.trim();
      const karat = Number(eKarat.value);
      const rate = rateFor(karat).sell_rate;
      if (!description) { itemIn.focus(); return toast('Describe the item in the Item box first.', 'bad'); }
      if (!(val(eWeight) > 0)) { eWeight.focus(); return toast('Enter the weight in grams.', 'bad'); }
      if (!(rate > 0)) return toast(`Set today's ${karat}K selling rate before selling this.`, 'bad');
      lines.push({ kind: 'item', item_id: null, sku: '', description, karat, weight_g: val(eWeight), rate, rateEdited: false, making_charge: val(eMaking), qty: 1, max: 9999 });
      itemIn.value = eWeight.value = eMaking.value = '';
      closeDrop();
      entryAmount();
      sel = lines.length - 1;
      renderLines(sel);
      tagIn.focus();
    }
    function addGold() {
      lines.push({ kind: 'gold', description: '', karat: 22, weight_g: '', rate: rateFor(22).buy_rate, rateEdited: false });
      sel = lines.length - 1;
      renderLines(sel);
      const weight = tbody.children[sel] && tbody.children[sel].querySelector('input[type=number]');
      if (weight) weight.focus();
    }
    function removeLine(i, tr) {
      const gone = () => {
        lines.splice(i, 1);
        if (sel >= lines.length) sel = lines.length - 1;
        renderLines();
      };
      if (calmMotion()) return gone();
      tr.classList.add('leaving');
      setTimeout(gone, 180);
    }
    const removeButton = (ln, i, label) => h('button', {
      class: 'btn icon', type: 'button', 'aria-label': `Remove ${label}`,
      onclick: (e) => { e.stopPropagation(); removeLine(i, e.currentTarget.closest('tr')); },
    }, '✕');

    function itemRow(ln, i) {
      const amount = h('td', { class: 'amount', text: plain(amountOf(ln)) });
      const changed = () => { amount.textContent = plain(amountOf(ln)); update(); showSelected(); };
      return h('tr', { onclick: () => select(i) },
        h('td', { class: 'nowrap small muted', text: ln.sku || '—' }),
        h('td', null, h('b', { text: ln.description }), ' ', ln.item_id ? (ln.max > 1 ? chip(`stock ${ln.max}`) : null) : chip('not in stock', 'warn')),
        h('td', null, hallmark(ln.karat)),
        h('td', { class: 'right nowrap', text: grams(ln.weight_g) }),
        h('td', { class: 'right' }, h('input', { type: 'number', step: '0.01', min: '0', value: ln.rate, disabled: !canEditRate(), 'aria-label': 'Rate per gram', oninput: (e) => { ln.rate = e.target.value; ln.rateEdited = true; changed(); } })),
        h('td', { class: 'right' }, h('input', { type: 'number', step: '0.01', min: '0', value: ln.making_charge, 'aria-label': 'Making charge', oninput: (e) => { ln.making_charge = e.target.value; changed(); } })),
        h('td', { class: 'right' }, ln.max > 1
          ? h('input', { class: 'qty', type: 'number', step: '1', min: '1', max: String(ln.max), value: ln.qty, 'aria-label': 'Quantity', oninput: (e) => { ln.qty = e.target.value; changed(); } })
          : '1'),
        amount,
        h('td', null, removeButton(ln, i, ln.description)));
    }
    function goldRow(ln, i) {
      const amount = h('td', { class: 'amount neg', text: plain(amountOf(ln)) });
      const changed = () => { amount.textContent = plain(amountOf(ln)); update(); showSelected(); };
      const rate = h('input', { type: 'number', step: '0.01', min: '0', value: ln.rate, disabled: !canEditRate(), 'aria-label': 'Buying rate per gram', oninput: () => { ln.rate = rate.value; ln.rateEdited = true; changed(); } });
      return h('tr', { class: 'goldline', onclick: () => select(i) },
        h('td', null, chip('OLD GOLD', 'in')),
        h('td', null, h('input', { type: 'text', value: ln.description, placeholder: 'For example: broken chain', 'aria-label': 'Old gold description', oninput: (e) => { ln.description = e.target.value; } })),
        h('td', null, karatSelect(ln.karat, (e) => {
          ln.karat = Number(e.target.value);
          if (!ln.rateEdited) { ln.rate = rateFor(ln.karat).buy_rate; rate.value = ln.rate; }
          changed();
        })),
        h('td', { class: 'right' }, h('input', { type: 'number', step: '0.001', min: '0', value: ln.weight_g, placeholder: '0.000', 'aria-label': 'Old gold weight in grams', oninput: (e) => { ln.weight_g = e.target.value; changed(); } })),
        h('td', { class: 'right' }, rate),
        h('td', { class: 'right muted', text: '—' }), h('td', { class: 'right muted', text: '—' }),
        amount,
        h('td', null, removeButton(ln, i, 'old gold')));
    }

    function showSelected() {
      const ln = lines[sel];
      if (!ln) {
        itemName.textContent = 'No item selected';
        itemSub.replaceChildren(h('span', { text: 'Scan a tag to start the bill' }));
        info.textContent = 'Rates are per gram';
        return;
      }
      itemName.textContent = isGold(ln) ? ln.description || `Old gold ${ln.karat}K` : ln.description;
      itemSub.replaceChildren(
        h('span', { text: `${isGold(ln) ? 'Taken in exchange' : ln.sku || 'Not in stock'}, ${ln.karat}K ${NJ.FINENESS[ln.karat]}, ${grams(ln.weight_g)}` }),
        h('b', { text: plain(amountOf(ln)) }));
      info.textContent = isGold(ln)
        ? `Old gold bought at ${plain(ln.rate)} per gram`
        : `${ln.description}: ${plain(ln.rate)} per gram, making ${plain(ln.making_charge)}`;
    }
    function markSelected() {
      [...tbody.children].forEach((tr, i) => tr.classList.toggle('sel', i === sel));
      showSelected();
    }
    function select(i) {
      sel = i;
      markSelected();
    }
    function renderLines(flash) {
      if (!lines.length) {
        sel = -1;
        tbody.replaceChildren(h('tr', { class: 'blank' }, h('td', { colspan: '9' },
          h('div', { class: 'empty' }, h('b', { text: 'The bill is empty' }), 'Scan a tag, or press F1 to search stock.'))));
      } else {
        tbody.replaceChildren(...lines.map((ln, i) => (isGold(ln) ? goldRow(ln, i) : itemRow(ln, i))));
        const row = flash !== undefined ? tbody.children[flash] : null;
        if (row) {
          row.classList.add('fresh');
          row.scrollIntoView({ block: 'nearest' });
        }
      }
      markSelected();
      update();
    }

    // ----- summary -----
    const sumMeta = h('span');
    const out = { subtotal: h('span'), tax: h('span'), gold: h('span'), balance: h('b'), change: h('b') };
    const discount = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '0', 'aria-label': 'Bill discount', oninput: update });
    const lessGold = h('div', { class: 'hidden' }, h('span', { text: 'Less old gold' }), out.gold);
    const netLabel = h('span', { text: 'Net total' });
    const netOut = h('b', { text: '0.00' });
    const netBox = h('div', { class: 'net' }, netLabel, netOut);
    const cash = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '0', oninput: update });
    const card = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '0', oninput: update });
    const bank = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '0', oninput: update });
    const balanceBox = h('div', { class: 'balance' },
      h('span', { class: 'due' }, 'Still due', out.balance), h('span', { class: 'chg' }, 'Change', out.change));
    const note = h('input', { type: 'text', maxlength: 500, placeholder: 'Note on the bill', 'aria-label': 'Note on the bill' });

    function figures() {
      const items = lines.filter((l) => !isGold(l));
      const subtotal = r2(items.reduce((sum, l) => sum + amountOf(l), 0));
      const disc = r2(val(discount));
      const tax = r2(((subtotal - disc) * taxPercent) / 100);
      const total = r2(subtotal - disc + tax);
      const goldValue = r2(-lines.filter(isGold).reduce((sum, l) => sum + amountOf(l), 0));
      return {
        subtotal, disc, tax, total, goldValue, net: r2(total - goldValue), hasGold: lines.some(isGold),
        pieces: items.reduce((n, l) => n + (Number(l.qty) || 0), 0),
        weight: items.reduce((w, l) => w + (Number(l.weight_g) || 0) * (Number(l.qty) || 0), 0),
      };
    }
    function update() {
      const f = figures();
      sumMeta.textContent = `${f.pieces} ${f.pieces === 1 ? 'piece' : 'pieces'}, ${grams(f.weight)}`;
      out.subtotal.textContent = plain(f.subtotal);
      out.tax.textContent = plain(f.tax);
      out.gold.textContent = `− ${plain(f.goldValue)}`;
      lessGold.classList.toggle('hidden', !f.hasGold);
      netLabel.textContent = f.net < 0 ? 'Pay the customer' : 'Net total';
      netBox.classList.toggle('owed', f.net < 0);
      rollTo(netOut, Math.abs(f.net), plain);
      const nothingDue = f.net <= 0;
      for (const input of [cash, card, bank]) {
        input.disabled = nothingDue;
        if (nothingDue) input.value = '';
      }
      const paid = r2(val(cash) + val(card) + val(bank));
      const short = nothingDue ? 0 : Math.max(0, r2(f.net - paid));
      out.balance.textContent = plain(short);
      out.change.textContent = plain(nothingDue ? 0 : Math.max(0, r2(paid - f.net)));
      balanceBox.classList.toggle('short', short > 0 && lines.length > 0);
    }

    // ----- actions behind the function keys -----
    function reset() {
      lines = [];
      discount.value = cash.value = card.value = bank.value = note.value = '';
      setCustomer(null);
      renderLines();
      tagIn.focus();
    }
    async function clearBill() {
      if (!lines.length && !customer) return;
      if (await confirmBox('Clear this bill and start again?', 'Clear the bill', true)) reset();
    }
    function chooseCustomer() {
      const picker = customerPicker((c) => { if (c) { setCustomer(c); d.close(); } });
      const d = modal('Choose the customer', h('div', { style: 'min-height:300px' }, picker.el), [
        h('button', { class: 'btn', type: 'button', onclick: () => { setCustomer(null); d.close(); } }, 'Walk-in customer'),
      ], { onClose: () => tagIn.focus() });
      const input = d.querySelector('.picker input');
      if (input) input.focus();
    }
    function exactCash() {
      const f = figures();
      if (!(f.net > 0)) return toast('Nothing is due on this bill.', 'bad');
      cash.value = Math.max(0, r2(f.net - val(card) - val(bank))).toFixed(2);
      update();
      replay(netOut, 'bumped');
    }

    const readHeld = () => { try { return JSON.parse(localStorage.getItem(HOLD_KEY)) || []; } catch { return []; } };
    const writeHeld = (list) => { try { localStorage.setItem(HOLD_KEY, JSON.stringify(list)); } catch { /* storage is unavailable */ } heldBadge(); };
    function hold() {
      if (!lines.length) return toast('Nothing to hold. The bill is empty.', 'bad');
      writeHeld([...readHeld(), { at: Date.now(), customer, lines, discount: discount.value, note: note.value, total: figures().net }]);
      reset();
      toast('Bill put on hold. Press F5 to bring it back.', 'good');
    }
    function unhold() {
      const list = readHeld();
      if (!list.length) return toast('There are no bills on hold.', 'bad');
      if (lines.length) return toast('Hold or clear the current bill first.', 'bad');
      const d = modal('Bills on hold', h('table', null, h('tbody', null, list.map((b, i) => h('tr', {
        class: 'click',
        onclick: () => {
          writeHeld(readHeld().filter((_, n) => n !== i));
          lines = b.lines.map((l) => (l.rateEdited ? l : { ...l, rate: isGold(l) ? rateFor(l.karat).buy_rate : rateFor(l.karat).sell_rate }));
          discount.value = b.discount || '';
          note.value = b.note || '';
          setCustomer(b.customer || null);
          sel = 0;
          renderLines(0);
          d.close();
          toast('Bill brought back at today’s rates.', 'good');
        },
      },
        h('td', null, h('b', { text: b.customer ? b.customer.name : 'Walk-in customer' })),
        h('td', { text: `${b.lines.length} ${b.lines.length === 1 ? 'line' : 'lines'}` }),
        h('td', { text: `held at ${timeOnly(new Date(b.at).toISOString())}` }),
        h('td', { class: 'right', text: plain(b.total) }))))), [], { onClose: () => tagIn.focus() });
    }
    async function billCopy() {
      try {
        NJ.showSale(await api('GET', '/api/sales/last'));
      } catch (err) { fail(err); }
    }
    function quotation() {
      const items = lines.filter((l) => !isGold(l));
      if (!items.length) return toast('Add an item before printing a quotation.', 'bad');
      const gold = lines.filter((l) => isGold(l) && Number(l.weight_g) > 0);
      const f = figures();
      const doc = NJ.saleReceipt({
        title: 'Quotation', status: 'quote', created_at: new Date().toISOString(), branch_name: branchName(me.branch_id), user_name: me.name, customer,
        items: items.map((l) => ({ description: l.description, sku: l.sku, karat: l.karat, weight_g: l.weight_g, rate: Number(l.rate), making_charge: Number(l.making_charge) || 0, qty: Number(l.qty), line_total: amountOf(l) })),
        exchange: gold.length ? { items: gold.map((l) => ({ description: l.description || `Old gold ${l.karat}K`, karat: l.karat, weight_g: Number(l.weight_g), rate: Number(l.rate), line_total: -amountOf(l) })) } : null,
        subtotal: f.subtotal, discount: f.disc, tax: f.tax, total: f.total, old_gold_value: f.goldValue, net_payable: f.net,
        note: 'Prices follow the gold rate and are valid today only.',
      });
      modal('Quotation', doc, [h('button', { class: 'btn primary', type: 'button', onclick: () => printNode(doc) }, 'Print')], { wide: true });
    }
    function celebrate(sale) {
      if (calmMotion()) return toast(`Sale completed: ${sale.invoice_no}`, 'good');
      const art = h('span', { 'aria-hidden': 'true' });
      art.innerHTML = '<svg viewBox="0 0 80 80" width="130" height="130"><circle class="ring" cx="40" cy="40" r="34"/><path class="mark" d="M25 41l10 10 20-22"/></svg>';
      const el = h('div', { class: 'done', role: 'status' }, art, h('b', { text: 'Sale completed' }), h('span', { text: `${sale.invoice_no}, ${money(sale.total)}` }));
      document.body.append(el);
      setTimeout(() => el.classList.add('bye'), 1250);
      setTimeout(() => el.remove(), 1600);
    }

    const goKey = h('button', { class: 'fkey go', type: 'button', 'data-key': 'F10' }, 'Print', h('small', { text: 'F10' }));
    const complete = busy(goKey, async () => {
      const items = lines.filter((l) => !isGold(l));
      if (!items.length) throw new Error('The bill is empty. Scan a tag first.');
      const gold = lines.filter(isGold);
      if (gold.some((l) => !(Number(l.weight_g) > 0))) throw new Error('Enter the weight of the old gold, or remove that line.');
      const sale = await api('POST', '/api/sales', {
        customer_id: customer ? customer.id : null,
        items: items.map((l) => ({ item_id: l.item_id, description: l.description, karat: l.karat, weight_g: l.weight_g,
          rate: l.rateEdited ? l.rate : undefined, making_charge: l.making_charge, qty: l.qty })),
        old_gold: gold.map((l) => ({ description: l.description, karat: l.karat, weight_g: l.weight_g, rate: l.rateEdited ? l.rate : undefined })),
        discount: val(discount),
        payments: { cash: val(cash), card: val(card), bank: val(bank) },
        note: note.value,
      });
      celebrate(sale);
      reset();
      loadNext();
      setTimeout(() => NJ.showSale(sale), calmMotion() ? 0 : 1400);
    });
    goKey.addEventListener('click', complete);

    const actions = {
      Escape: clearBill, F1: () => itemIn.focus(), F2: billCopy, F4: chooseCustomer, F5: unhold, F6: addGold, F7: hold,
      F8: () => { discount.focus(); discount.select(); }, F9: exactCash, F10: () => complete(),
    };
    const key = (code, label, cls) => h('button', { class: `fkey ${cls || ''}`, type: 'button', 'data-key': code, onclick: () => actions[code]() },
      label, h('small', { text: code === 'Escape' ? 'Esc' : code }));
    const unholdKey = key('F5', 'Unhold');
    function heldBadge() {
      const old = unholdKey.querySelector('.badge');
      if (old) old.remove();
      const n = readHeld().length;
      if (n) unholdKey.append(h('span', { class: 'badge', text: String(n), 'aria-label': `${n} on hold` }));
    }
    const keyBar = h('div', { class: 'fkeys' },
      key('Escape', 'Clear'), key('F7', 'Hold'), unholdKey, key('F4', 'Customer', 'alt'), key('F8', 'Discount', 'alt'),
      key('F6', 'Old gold', 'alt'), key('F9', 'Exact cash', 'alt'), key('F2', 'Bill copy'), goKey);

    function onKey(e) {
      if (document.querySelector('dialog[open]') || !actions[e.key]) return;
      if (e.key === 'Escape' && dropOpen) return closeDrop();
      e.preventDefault(); // F5 would otherwise reload the page, F1 open browser help
      const button = keyBar.querySelector(`[data-key="${e.key}"]`);
      if (button) {
        button.classList.add('hit');
        setTimeout(() => button.classList.remove('hit'), 170);
      }
      actions[e.key]();
    }
    document.addEventListener('keydown', onKey);
    onLeave(() => document.removeEventListener('keydown', onKey));

    listen('nj:rates', () => {
      for (const l of lines) if (!l.rateEdited) l.rate = isGold(l) ? rateFor(l.karat).buy_rate : rateFor(l.karat).sell_rate;
      renderLines();
      entryAmount();
      if (lines.length) toast('Gold rates just changed. This bill now uses the new rates.');
    });

    // ----- layout -----
    page.append(h('div', { class: 'pos' },
      h('div', { class: 'pos-top' },
        custCard,
        h('div', { class: 'card pos-clock' }, h('div', null, clockDay, clockTime), clockNum),
        h('div', { class: 'card pos-status' },
          h('div', { class: 'presence', 'aria-label': 'Staff online now' }),
          h('div', null, h('span', { class: 'small muted', text: `${branchName(me.branch_id)}, next bill ` }), invNo))),
      h('div', { class: 'pos-strip' }, h('div', { class: 'ratestrip', 'aria-label': 'Selling rates per gram' }), info),
      h('div', { class: 'pos-body' },
        h('div', { class: 'pos-left' },
          h('div', { class: 'entry' },
            labelled('Scan tag', '', tagIn, 'scan'),
            h('div', { class: 'itembox' }, labelled('Item', 'F1', itemIn), drop),
            labelled('Karat', '', eKarat), labelled('Weight g', '', eWeight), labelled('Making', '', eMaking),
            h('div', { class: 'amt' }, h('span', null, 'Amount'), eAmount)),
          h('div', { class: 'card lines' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Tag'), h('th', null, 'Item'), h('th', null, 'Karat'), h('th', { class: 'right' }, 'Weight'),
              h('th', { class: 'right' }, 'Rate'), h('th', { class: 'right' }, 'Making'), h('th', { class: 'right' }, 'Qty'), h('th', { class: 'right' }, 'Amount'), h('th'))),
            tbody))),
        h('div', { class: 'pos-right' },
          h('div', { class: 'card itemcard' }, itemName, itemSub),
          h('div', { class: 'card sumcard' },
            h('div', { class: 'sumhead' }, h('span', { text: 'Invoice summary' }), sumMeta),
            h('div', { class: 'sumrows' },
              h('div', null, h('span', { text: 'Sub total' }), out.subtotal),
              h('div', null, h('span', null, 'Discount', h('kbd', { text: 'F8' })), discount),
              taxPercent ? h('div', null, h('span', { text: `Tax ${taxPercent}%` }), out.tax) : null,
              lessGold)),
          netBox,
          h('div', { class: 'card paycard' },
            h('div', { class: 'paygrid' }, labelled('Cash', '', cash), labelled('Card', '', card), labelled('Bank', '', bank)),
            balanceBox),
          h('div', { class: 'minis' }, note, h('button', { class: 'btn', type: 'button', onclick: quotation }, 'Quotation')))),
      keyBar));

    NJ.renderRateStrip();
    NJ.renderPresence();
    setCustomer(null);
    renderLines();
    heldBadge();
    loadNext();
    tagIn.focus();
  };
})();
