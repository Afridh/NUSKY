'use strict';
// Today: how the day is going, at a glance. Shown first after signing in.
(function () {
  const { h, api, plain, money, grams, timeOnly, dateTime, today, r2, hallmark, canManage, branchName, fail, listen, onLeave, rollTo } = NJ;

  const dateMinus = (days) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  // A small line chart of the last 14 days' sales, drawn as SVG.
  function sparkline(values) {
    const w = 320;
    const hgt = 80;
    const pad = 6;
    const max = Math.max(1, ...values);
    const step = (w - pad * 2) / Math.max(1, values.length - 1);
    const pts = values.map((v, i) => [pad + i * step, hgt - pad - (v / max) * (hgt - pad * 2)]);
    const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-label', 'Sales over the last 14 days');
    svg.innerHTML =
      `<polygon points="${pad},${hgt - pad} ${line} ${last[0].toFixed(1)},${hgt - pad}" fill="rgba(230,187,79,.18)"/>` +
      `<polyline points="${line}" fill="none" stroke="#f6dc8d" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" class="trace"/>` +
      `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4.5" fill="#fff"/>`;
    return svg;
  }

  NJ.pages['/'] = async (page) => {
    const me = NJ.state.me;
    const manager = canManage();
    let branchId = manager ? '' : String(me.branch_id);

    // ----- rates board: a jeweller's day starts with the rate -----
    const board = h('div', { class: 'board' });
    function renderBoard() {
      board.replaceChildren(...NJ.state.rates.map((r) => h('div', null, hallmark(r.karat),
        h('small', { text: 'We sell at' }), h('div', { class: 'sell', text: plain(r.sell_rate) }),
        h('div', { class: 'buy', text: `We buy at ${plain(r.buy_rate)}` }))));
    }
    renderBoard();
    listen('nj:rates', () => { renderBoard(); load().catch(fail); });

    // ----- branch tabs (managers and admins) -----
    const tabs = manager && NJ.state.branches.length > 1
      ? h('div', { class: 'tabs', role: 'tablist' },
        [{ id: '', name: 'All branches' }, ...NJ.state.branches].map((b) => h('button', {
          type: 'button', role: 'tab', class: String(b.id) === branchId ? 'active' : '',
          onclick: (e) => {
            branchId = String(b.id);
            for (const t of e.currentTarget.parentNode.children) t.classList.toggle('active', t === e.currentTarget);
            load().catch(fail);
          },
        }, b.name)))
      : null;

    const body = h('div');
    const kpi = (label, value, sub, cls, share) => h('div', { class: `card kpi ${cls || ''}` },
      h('span', { text: label }), h('b', { text: value }), h('small', { text: sub }),
      h('i', { style: `--w:${Math.max(0, Math.min(100, share || 0))}%` }));
    const chipbox = (label, value) => h('span', { class: 'chipbox' }, label, h('b', { text: value }));
    const sum = (rows, key) => rows.reduce((a, k) => a + k[key], 0);

    async function load() {
      const q = branchId ? `&branch_id=${branchId}` : '';
      const [s, fortnight, bills] = await Promise.all([
        api('GET', `/api/reports/summary?from=${today()}&to=${today()}${q}`),
        api('GET', `/api/reports/summary?from=${dateMinus(13)}&to=${today()}${q}`),
        api('GET', `/api/sales?from=${today()}&to=${today()}${q}`),
      ]);
      const series = [];
      for (let i = 13; i >= 0; i--) {
        const d = fortnight.days.find((x) => x.date === dateMinus(i));
        series.push(d ? d.sales : 0);
      }
      series[13] = s.sales.total;
      const average = series.slice(0, 13).reduce((a, b) => a + b, 0) / 13;
      const delta = average > 0 ? Math.round(((s.sales.total - average) / average) * 100) : null;
      const cardBank = r2(s.sales.card + s.sales.bank);
      const soldPieces = sum(s.sold_by_karat, 'pieces');
      const soldWeight = sum(s.sold_by_karat, 'weight_g');
      const boughtWeight = sum(s.bought_by_karat, 'weight_g');
      const stockPieces = sum(s.stock, 'pieces');
      const stockWeight = sum(s.stock, 'weight_g');
      const live = bills.filter((b) => b.status !== 'void');
      const todayIso = new Date().toISOString().slice(0, 10);
      const ratesToday = NJ.state.rates.every((r) => r.updated_at && r.updated_at.slice(0, 10) === todayIso && r.sell_rate > 0);
      const lastRate = NJ.state.rates.map((r) => r.updated_at).filter(Boolean).sort().pop();
      const online = NJ.state.online || [];
      const big = h('b', { class: 'big' });
      const share = (part, whole) => (whole > 0 ? (part / whole) * 100 : part > 0 ? 60 : 0);

      body.replaceChildren(
        h('div', { class: 'kpis' },
          kpi('Sales today', money(s.sales.total), `${s.sales.count} ${s.sales.count === 1 ? 'bill' : 'bills'}`, 'in', share(s.sales.total, average * 2)),
          kpi('Cash in the drawer', money(s.cash_drawer), 'from today, after change and payouts', s.cash_drawer < 0 ? 'out' : '', share(s.cash_drawer, s.sales.total)),
          kpi('Card and bank', money(cardBank), 'received today', '', share(cardBank, s.sales.total)),
          kpi('Gold bought', money(s.purchases.total), `${s.purchases.count} ${s.purchases.count === 1 ? 'voucher' : 'vouchers'}, ${grams(boughtWeight)}`, 'out', share(s.purchases.total, s.sales.total)),
          kpi('Gold sold', grams(soldWeight), `${soldPieces} ${soldPieces === 1 ? 'piece' : 'pieces'}`, '', share(soldWeight, stockWeight))),
        h('div', { class: 'hero' },
          h('div', null,
            h('div', { class: 'lbl' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), ' Sales so far today'),
            big,
            h('div', { class: 'lbl' },
              `${s.sales.count} ${s.sales.count === 1 ? 'invoice' : 'invoices'}`,
              delta === null
                ? (manager ? ', no earlier days to compare with yet' : '')
                : h('span', { class: `delta ${delta >= 0 ? 'up' : 'down'}`, text: `, ${delta >= 0 ? '+' : ''}${delta}% against the fortnight average` }))),
          h('div', { class: 'split' },
            h('div', null, h('span', { class: 'lbl', text: 'Cash' }), h('b', { text: plain(s.sales.cash) })),
            h('div', null, h('span', { class: 'lbl', text: 'Card' }), h('b', { text: plain(s.sales.card) })),
            h('div', null, h('span', { class: 'lbl', text: 'Bank' }), h('b', { text: plain(s.sales.bank) }))),
          h('div', { class: 'trend' }, sparkline(series), h('span', { class: 'lbl', text: manager ? 'Last 14 days' : 'Today' })),
          h('div', { class: 'chips' },
            chipbox('Old gold taken', plain(s.sales.old_gold_value)),
            chipbox('Discounts given', plain(s.sales.discount)),
            s.sales.tax ? chipbox('Tax collected', plain(s.sales.tax)) : null,
            chipbox('Stock on hand', `${stockPieces} pcs, ${grams(stockWeight)}`))),
        h('div', { class: 'row', style: 'max-width:520px; margin-bottom:1.1rem' },
          h('a', { class: 'btn primary big', href: '#/sell' }, 'Start a sale'),
          h('a', { class: 'btn big', href: '#/buy' }, 'Buy gold')),
        h('div', { class: 'cols' },
          h('div', { class: 'panel' }, h('h2', { text: 'Where the day stands' }),
            h('ul', { class: 'daylist' },
              h('li', null,
                h('div', null, h('b', { text: ratesToday ? "Today's rates are set" : "Today's rates are not set yet" }),
                  h('small', { text: lastRate ? `Last changed ${dateTime(lastRate)}` : 'Never set' })),
                h('span', { class: `status ${ratesToday ? 'ok' : 'warn'}` }, manager && !ratesToday ? h('a', { href: '#/rates' }, 'Set them') : ratesToday ? 'Done' : 'Waiting')),
              h('li', null,
                h('div', null, h('b', { text: `${online.length} staff online` }), h('small', { text: online.map((u) => u.name).join(', ') || 'Nobody is signed in' })),
                h('span', { class: 'status ok', text: online.length ? 'Live' : '' })),
              h('li', null,
                h('div', null, h('b', { text: live.length ? `Last bill at ${timeOnly(live[0].created_at)}` : 'No bills yet today' }),
                  h('small', { text: live.length ? `${live[0].invoice_no}, ${live[0].user_name}, ${money(live[0].total)}` : 'The first sale of the day is still to come' })),
                h('span', { class: `status ${live.length ? 'ok' : ''}`, text: live.length ? `${live.length} so far` : '' })),
              h('li', null,
                h('div', null, h('b', { text: 'Stock on hand' }), h('small', { text: s.stock.map((k) => `${k.karat}K ${grams(k.weight_g)}`).join(', ') || 'No stock recorded' })),
                h('span', { class: 'status' }, h('a', { href: '#/stock' }, 'Stock'))))),
          h('div', { class: 'panel' }, h('h2', { text: 'Latest bills' }),
            live.length
              ? h('ul', { class: 'daylist' }, live.slice(0, 7).map((b) => h('li', {
                class: 'click',
                onclick: async () => { try { NJ.showSale(await api('GET', `/api/sales/${b.id}`)); } catch (err) { fail(err); } },
              },
                h('div', null, h('b', { text: b.customer_name || 'Walk-in customer' }),
                  h('small', { text: `${b.invoice_no}, ${timeOnly(b.created_at)}, ${b.user_name}${manager && !branchId ? `, ${branchName(b.branch_id)}` : ''}` })),
                h('span', { class: 'amount', text: plain(b.total) }))))
              : h('div', { class: 'empty' }, 'No bills yet today.'),
            live.length > 7 ? h('p', { style: 'margin:.6rem 0 0' }, h('a', { href: '#/bills' }, 'All of today’s bills')) : null)));
      rollTo(big, s.sales.total, money);
    }

    page.append(tabs, h('p', { class: 'muted', text: `Rates are per gram (${NJ.state.settings.currency}).` }), board, body);
    await load();
    const timer = setInterval(() => load().catch(() => {}), 60000); // keeps the figures fresh on a counter left on this page
    onLeave(() => clearInterval(timer));
  };
})();
