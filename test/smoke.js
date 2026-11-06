'use strict';
// End-to-end check of the server against a throwaway database.
// Run with: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nusky-test-'));

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), NUSKY_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'inherit'],
});

function makeClient() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/api/tv');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('Server did not start');
}

async function main() {
  await waitForServer();
  const admin = makeClient();
  const cashier = makeClient();
  let r;

  // --- auth ---
  r = await admin('GET', '/api/bootstrap');
  assert.strictEqual(r.status, 401, 'bootstrap needs sign-in');
  r = await admin('POST', '/api/login', { username: 'admin', password: 'nope' });
  assert.strictEqual(r.status, 401);
  r = await admin('POST', '/api/login', { username: 'admin', password: 'admin123' });
  assert.strictEqual(r.status, 200);
  assert.ok(!/Secure/.test(r.headers.get('set-cookie')), 'plain http keeps a normal cookie');

  // --- the starter password opens nothing until it is replaced ---
  r = await admin('GET', '/api/bootstrap');
  assert.strictEqual(r.data.must_change_password, true);
  assert.strictEqual(r.data.settings, undefined, 'no shop data before the password is changed');
  for (const [method, url] of [['GET', '/api/items'], ['GET', '/api/customers'], ['GET', '/api/users'], ['GET', '/api/backup'], ['PUT', '/api/rates'], ['GET', '/api/events']]) {
    r = await admin(method, url, method === 'GET' ? undefined : {});
    assert.strictEqual(r.status, 403, `${method} ${url} is locked on the starter password`);
  }
  r = await admin('POST', '/api/me/password', { current: 'admin123', next: 'admin123' });
  assert.strictEqual(r.status, 400, 'the starter password cannot be kept');
  r = await admin('POST', '/api/me/password', { current: 'wrong', next: 'first-pass' });
  assert.strictEqual(r.status, 400);
  r = await admin('POST', '/api/me/password', { current: 'admin123', next: 'first-pass' });
  assert.strictEqual(r.status, 200);
  r = await admin('GET', '/api/bootstrap');
  assert.strictEqual(r.data.me.role, 'admin');
  assert.strictEqual(r.data.must_change_password, undefined);
  assert.deepStrictEqual(r.data.rates.map((x) => x.karat), [24, 22, 21, 18]);
  r = await makeClient()('POST', '/api/login', { username: 'admin', password: 'admin123' });
  assert.strictEqual(r.status, 401, 'the starter password no longer signs in');
  // behind an https site the session cookie is marked Secure
  let viaHttps = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ username: 'admin', password: 'first-pass' }),
  });
  assert.match(viaHttps.headers.get('set-cookie'), /; Secure/);
  assert.strictEqual(viaHttps.headers.get('x-frame-options'), 'SAMEORIGIN');

  // --- selling is blocked until rates are set ---
  r = await admin('POST', '/api/sales', { items: [{ description: 'Ring', karat: 22, weight_g: 2 }], payments: { cash: 1 } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /selling rate/);

  // --- rates ---
  r = await admin('PUT', '/api/rates', {
    rates: [
      { karat: 24, sell_rate: 30000, buy_rate: 29000 },
      { karat: 22, sell_rate: 27500, buy_rate: 26500 },
      { karat: 21, sell_rate: 26250, buy_rate: 25300 },
      { karat: 18, sell_rate: 22500, buy_rate: 21600 },
    ],
  });
  assert.strictEqual(r.status, 200);
  r = await admin('PUT', '/api/rates', { rates: [{ karat: 22, sell_rate: 100, buy_rate: 200 }] });
  assert.strictEqual(r.status, 400, 'buy above sell is rejected');
  r = await admin('GET', '/api/tv');
  assert.strictEqual(r.data.rates.find((x) => x.karat === 22).sell_rate, 27500);

  // --- staff + branch ---
  r = await admin('POST', '/api/branches', { name: 'Second branch' });
  const branch2 = r.data.id;
  r = await admin('POST', '/api/users', { username: 'fathima', name: 'Fathima', password: 'secret1', role: 'cashier', branch_id: 1 });
  assert.strictEqual(r.status, 200);
  const cashierId = r.data.id;
  r = await cashier('POST', '/api/login', { username: 'fathima', password: 'secret1' });
  assert.strictEqual(r.status, 200);
  r = await cashier('PUT', '/api/rates', { rates: [{ karat: 22, sell_rate: 1, buy_rate: 1 }] });
  assert.strictEqual(r.status, 403, 'cashier cannot change rates');
  r = await cashier('POST', '/api/items', { name: 'x', karat: 22, weight_g: 1 });
  assert.strictEqual(r.status, 403, 'cashier cannot add stock');

  // --- stock ---
  r = await admin('POST', '/api/items', { name: 'Bridal necklace', category: 'Necklace', karat: 22, weight_g: 16.25, making_charge: 12000 });
  assert.strictEqual(r.status, 200);
  const necklace = r.data;
  assert.match(necklace.sku, /^NJ-\d{6}$/);
  r = await admin('POST', '/api/items', { sku: 'R-18-1', name: 'Stone ring', category: 'Ring', karat: 18, weight_g: 3.5, making_charge: 2500, qty: 2 });
  const ring = r.data;
  r = await admin('POST', '/api/items', { sku: 'r-18-1', name: 'Dup', karat: 18, weight_g: 1 });
  assert.strictEqual(r.status, 400, 'duplicate tag rejected');
  r = await admin('POST', '/api/items', { name: 'Far away bangle', karat: 21, weight_g: 10, branch_id: branch2 });
  const farItem = r.data;
  r = await cashier('GET', '/api/items?q=R-18-1&stock=in');
  assert.strictEqual(r.data[0].id, ring.id);

  // --- customer ---
  r = await cashier('POST', '/api/customers', { name: 'Mr. Perera', phone: '0771234567', id_number: '901234567V' });
  const customer = r.data;

  // --- sale: cashier's edited rate is ignored, totals come from the server ---
  r = await cashier('POST', '/api/sales', {
    customer_id: customer.id,
    items: [{ item_id: necklace.id, rate: 1 }, { item_id: ring.id, qty: 1 }],
    discount: 1000,
    payments: { cash: 400000, card: 200000 },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  let sale = r.data;
  const expectSubtotal = 16.25 * 27500 + 12000 + 3.5 * 22500 + 2500; // 446875 + 12000 + 78750 + 2500
  assert.strictEqual(sale.subtotal, expectSubtotal);
  assert.strictEqual(sale.total, expectSubtotal - 1000);
  assert.strictEqual(sale.invoice_no, 'INV-000001');
  assert.strictEqual(sale.change_given, 600000 - sale.total);
  assert.strictEqual(sale.paid_cash, 400000 - sale.change_given);
  assert.strictEqual(sale.items.length, 2);

  r = await cashier('GET', '/api/sales/next');
  assert.strictEqual(r.data.invoice_no, 'INV-000002');
  r = await cashier('GET', '/api/sales/last');
  assert.strictEqual(r.data.invoice_no, 'INV-000001');
  r = await admin('GET', '/api/sales/last');
  assert.strictEqual(r.status, 404, 'admin has made no bill yet');

  // payment short
  r = await cashier('POST', '/api/sales', { items: [{ item_id: ring.id }], payments: { cash: 10 } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /short/);
  // sold-out item
  r = await cashier('POST', '/api/sales', { items: [{ item_id: necklace.id }], payments: { cash: 99999999 } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /left in stock/);
  // other branch's item
  r = await cashier('POST', '/api/sales', { items: [{ item_id: farItem.id }], payments: { cash: 99999999 } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /another branch/);
  // same item twice exceeding stock (1 ring left)
  r = await cashier('POST', '/api/sales', { items: [{ item_id: ring.id }, { item_id: ring.id }], payments: { cash: 99999999 } });
  assert.strictEqual(r.status, 400);

  // --- sale with old gold exchange where the shop owes the customer ---
  r = await cashier('POST', '/api/sales', {
    items: [{ item_id: ring.id }],
    old_gold: [{ karat: 22, weight_g: 5 }],
    payments: {},
  });
  assert.strictEqual(r.status, 400, 'exchange needs a customer');
  r = await cashier('POST', '/api/sales', {
    customer_id: customer.id,
    items: [{ item_id: ring.id }],
    old_gold: [{ karat: 22, weight_g: 5 }],
    payments: {},
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const exchangeSale = r.data;
  assert.strictEqual(exchangeSale.old_gold_value, 5 * 26500);
  assert.strictEqual(exchangeSale.net_payable, 3.5 * 22500 + 2500 - 5 * 26500);
  assert.strictEqual(exchangeSale.paid_cash, exchangeSale.net_payable);
  assert.strictEqual(exchangeSale.exchange.payment_method, 'exchange');

  // --- buying gold ---
  r = await cashier('POST', '/api/purchases', { items: [{ karat: 24, weight_g: 2 }] });
  assert.strictEqual(r.status, 400, 'purchase needs a customer');
  r = await cashier('POST', '/api/purchases', {
    customer_id: customer.id,
    items: [{ karat: 24, weight_g: 2, description: 'Coin' }, { karat: 18, weight_g: 1.555 }],
    payment_method: 'cash',
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const purchase = r.data;
  assert.strictEqual(purchase.total, 2 * 29000 + Math.round(1.555 * 21600 * 100) / 100);
  assert.strictEqual(purchase.voucher_no, 'PUR-000002');

  // --- reports ---
  r = await admin('GET', '/api/reports/summary');
  assert.strictEqual(r.data.sales.count, 2);
  assert.strictEqual(r.data.purchases.count, 2);
  assert.strictEqual(r.data.purchases.exchange, 5 * 26500);
  const drawer = sale.paid_cash + exchangeSale.paid_cash - purchase.total;
  assert.strictEqual(r.data.cash_drawer, Math.round(drawer * 100) / 100);
  assert.strictEqual(r.data.sold_by_karat.find((k) => k.karat === 18).pieces, 2);

  // --- void puts stock back and cancels the linked exchange ---
  r = await cashier('POST', `/api/sales/${exchangeSale.id}/void`);
  assert.strictEqual(r.status, 403);
  r = await admin('POST', `/api/purchases/${exchangeSale.exchange.id}/void`);
  assert.strictEqual(r.status, 400, 'exchange voucher is cancelled through its bill');
  r = await admin('POST', `/api/sales/${exchangeSale.id}/void`);
  assert.strictEqual(r.data.status, 'void');
  assert.strictEqual(r.data.exchange.status, 'void');
  r = await admin('GET', '/api/items?q=R-18-1');
  assert.strictEqual(r.data[0].qty, 1);
  r = await admin('POST', `/api/sales/${exchangeSale.id}/void`);
  assert.strictEqual(r.status, 400);

  // --- staff messages ---
  r = await cashier('POST', '/api/messages', { to: 'all', body: 'Rates updated?' });
  assert.strictEqual(r.status, 200);
  r = await cashier('POST', '/api/messages', { to: 1, body: 'Need change for the drawer' });
  assert.strictEqual(r.status, 200);
  r = await admin('GET', '/api/messages/threads');
  assert.strictEqual(r.data.find((t) => t.key === 'all').unread, 1);
  assert.strictEqual(r.data.find((t) => t.key === String(cashierId)).unread, 1);
  r = await admin('GET', `/api/messages?with=${cashierId}`);
  assert.strictEqual(r.data.length, 1);
  r = await admin('GET', '/api/messages/threads');
  assert.strictEqual(r.data.find((t) => t.key === String(cashierId)).unread, 0);

  // --- customer messages ---
  r = await cashier('POST', '/api/customer-messages', { customer_ids: [customer.id], body: 'Dear {name}, 22K today {rate22} at {shop}', channel: 'whatsapp' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data[0].link.startsWith('https://wa.me/94771234567?text='));
  assert.strictEqual(r.data[0].text, 'Dear Mr. Perera, 22K today Rs. 27,500 at Nusky Jewellers');
  r = await cashier('POST', '/api/customer-messages', { customer_ids: [customer.id], body: 'x', channel: 'sms' });
  assert.strictEqual(r.status, 400, 'sms needs a gateway');

  // --- TV + settings ---
  r = await admin('PUT', '/api/tv', {
    message: 'Eid offers this week', show_pavan: true, show_buy: true, subtitle: 'Colombo 03',
    points: [['Pure gold', 'Genuine quality'], ['', ''], ['New collections', 'Wedding']],
  });
  assert.strictEqual(r.data.message, 'Eid offers this week');
  assert.strictEqual(r.data.subtitle, 'Colombo 03');
  assert.strictEqual(r.data.show_buy, true);
  assert.deepStrictEqual(r.data.points, [['Pure gold', 'Genuine quality'], ['New collections', 'Wedding']], 'empty points are dropped');
  r = await admin('PUT', '/api/tv', { points: [['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b']] });
  assert.strictEqual(r.status, 400, 'at most three selling points');

  // TV slideshow pictures
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await cashier('POST', '/api/tv/images', { data: png });
  assert.strictEqual(r.status, 403, 'cashier cannot change TV pictures');
  r = await admin('POST', '/api/tv/images', { data: 'data:text/html;base64,PGgxPg==' });
  assert.strictEqual(r.status, 400, 'only pictures are accepted');
  r = await admin('POST', '/api/tv/images', { data: 'data:image/jpeg;base64,PGgxPmhpPC9oMT4=' });
  assert.strictEqual(r.status, 400, 'a file that only claims to be a picture is refused');
  r = await admin('POST', '/api/tv/images', { data: png });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.length, 1);
  const picture = r.data[0];
  r = await admin('GET', '/api/tv');
  assert.strictEqual(r.data.images[0].url, picture.url);
  let raw = await fetch(BASE + picture.url);
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.headers.get('content-type'), 'image/png');
  raw = await fetch(BASE + '/api/tv/image/..%2Fnusky.db');
  assert.strictEqual(raw.status, 404, 'only generated picture names are served');
  r = await admin('DELETE', `/api/tv/images/${picture.id}`);
  assert.strictEqual(r.data.length, 0);
  raw = await fetch(BASE + picture.url);
  assert.strictEqual(raw.status, 404);
  r = await cashier('PUT', '/api/settings', { shop_name: 'Hacked' });
  assert.strictEqual(r.status, 403);
  r = await admin('PUT', '/api/settings', { tax_percent: '2.5', currency: 'LKR' });
  assert.strictEqual(r.data.tax_percent, '2.5');

  // --- admin safety ---
  r = await admin('PUT', '/api/users/1', { name: 'Administrator', role: 'cashier', branch_id: 1, active: true });
  assert.strictEqual(r.status, 400, 'cannot demote the only admin');
  r = await admin('POST', '/api/me/password', { current: 'first-pass', next: 'better-pass' });
  assert.strictEqual(r.status, 200);
  r = await makeClient()('POST', '/api/login', { username: 'admin', password: 'better-pass' });
  assert.strictEqual(r.status, 200);

  // --- backup + static pages ---
  r = await admin('GET', '/api/backup');
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.byteLength > 1000);
  for (const page of ['/', '/tv']) {
    const res = await fetch(BASE + page);
    assert.strictEqual(res.status, 200, `${page} is served`);
  }
  const traversal = await fetch(BASE + '/..%2f..%2fpackage.json');
  assert.notStrictEqual(traversal.status, 200);

  console.log('All checks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true }), 300);
  });
