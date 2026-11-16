'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db, tx, now, hashPassword, KARATS, DATA_DIR, DEFAULT_SETTINGS, STARTER_PASSWORD } = require('./db');

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
const RAW = Symbol('raw-response');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const pad6 = (n) => String(n).padStart(6, '0');

function num(value, label, { min = -Infinity, max = 1e12, int = false } = {}) {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) {
    throw bad(`${label} must be a number.`);
  }
  if (int && !Number.isInteger(n)) throw bad(`${label} must be a whole number.`);
  if (n < min) throw bad(`${label} must be at least ${min}.`);
  if (n > max) throw bad(`${label} is too large.`);
  return n;
}

function str(value, label, { max = 200, required = false } = {}) {
  const s = value === null || value === undefined ? '' : String(value).trim();
  if (required && !s) throw bad(`${label} is required.`);
  if (s.length > max) throw bad(`${label} is too long (limit ${max} characters).`);
  return s;
}

function karatOf(value) {
  const k = Number(value);
  if (!KARATS.includes(k)) throw bad('Karat must be 24, 22, 21 or 18.');
  return k;
}

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Turns ?from=YYYY-MM-DD&to=YYYY-MM-DD (shop-local days) into a UTC ISO range.
function dateRange(query) {
  const today = localDate();
  const from = query.from || today;
  const to = query.to || from;
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  if (!ok.test(from) || !ok.test(to)) throw bad('Dates must look like 2026-01-31.');
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T23:59:59.999`);
  if (isNaN(start) || isNaN(end)) throw bad('That date does not exist.');
  if (end < start) throw bad('The "to" date is before the "from" date.');
  return { from, to, fromIso: start.toISOString(), toIso: end.toISOString() };
}

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function getRates() {
  return db.prepare('SELECT karat, sell_rate, buy_rate, updated_at FROM rates ORDER BY karat DESC').all();
}

function rateMap() {
  const map = {};
  for (const r of getRates()) map[r.karat] = r;
  return map;
}

function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, branch_id: u.branch_id, active: u.active };
}

function branchExists(id) {
  return !!db.prepare('SELECT id FROM branches WHERE id = ?').get(id);
}

// ---------- live updates (server-sent events) ----------

const clients = new Set();

function openStream(req, res, info) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, ...info };
  clients.add(client);
  if (client.userId) emitPresence();
  req.on('close', () => {
    clients.delete(client);
    if (client.userId) emitPresence();
  });
}

// Staff with the app open right now, shown as "online" on every counter.
function presenceList() {
  const ids = [...new Set([...clients].filter((c) => c.userId).map((c) => c.userId))];
  return ids.map((id) => db.prepare('SELECT id, name FROM users WHERE id = ?').get(id)).filter(Boolean);
}

function emitPresence() {
  emit('presence', presenceList(), (c) => c.userId);
}

function emit(event, data, filter) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (!filter || filter(c)) {
      try {
        c.res.write(payload);
      } catch {
        clients.delete(c);
      }
    }
  }
}

setInterval(() => {
  for (const c of clients) {
    try {
      c.res.write(': ping\n\n');
    } catch {
      clients.delete(c);
    }
  }
}, 25000).unref();

// The looks the TV board can wear. 'board' is the royal colours without the photo panel.
const TV_THEMES = ['royal', 'emerald', 'ruby', 'ivory', 'board'];

const TV_DIR = path.join(DATA_DIR, 'tv');
fs.mkdirSync(TV_DIR, { recursive: true });

function tvImages() {
  return db
    .prepare('SELECT id, file FROM tv_images ORDER BY id')
    .all()
    .map((r) => ({ id: r.id, url: `/api/tv/image/${r.file}` }));
}

function tvPoints(raw) {
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) return list.filter((p) => Array.isArray(p) && (p[0] || p[1])).map((p) => [String(p[0] || ''), String(p[1] || '')]);
  } catch {
    /* fall through to none */
  }
  return [];
}

function tvPayload() {
  const s = getSettings();
  return {
    shop_name: s.shop_name,
    subtitle: s.tv_subtitle || '',
    phone: s.shop_phone || '',
    currency: s.currency,
    message: s.tv_message,
    show_pavan: s.tv_show_pavan === '1',
    show_buy: s.tv_show_buy === '1',
    theme: TV_THEMES.includes(s.tv_theme) ? s.tv_theme : 'royal',
    points: tvPoints(s.tv_points),
    images: tvImages(),
    rates: getRates(),
  };
}

// ---------- auth ----------

const SESSION_DAYS = 30;
const loginFails = new Map();

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.created_at AS session_created FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1`
    )
    .get(token);
  if (!row) return null;
  if (Date.now() - new Date(row.session_created).getTime() > SESSION_DAYS * 86400000) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  row.token = token;
  return row;
}

db.prepare('DELETE FROM sessions WHERE created_at < ?').run(
  new Date(Date.now() - SESSION_DAYS * 86400000).toISOString()
);

// ---------- routing ----------

const routes = [];
// access: 'public', 'any' (any signed-in user) or a list of roles.
// opts.maxBody raises the request size limit for a route (picture uploads).
function add(method, pattern, access, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp(
    '^' +
      pattern.replace(/:([a-z_]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, rx, keys, access, handler, maxBody: opts.maxBody || 1024 * 1024, beforePasswordChange: !!opts.beforePasswordChange });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'That request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(bad('The request was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleApi(req, res, url) {
  try {
    const pathname = url.pathname;
    let matched = null;
    let pathKnown = false;
    for (const route of routes) {
      const m = route.rx.exec(pathname);
      if (!m) continue;
      pathKnown = true;
      if (route.method !== req.method) continue;
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      matched = { route, params };
      break;
    }
    if (!matched) {
      throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'Method not allowed.' : 'Not found.');
    }
    const { route, params } = matched;
    let user = null;
    if (route.access !== 'public') {
      user = currentUser(req);
      if (!user) throw new HttpError(401, 'Sign in to continue.');
      if (Array.isArray(route.access) && !route.access.includes(user.role)) {
        throw new HttpError(403, 'Your account is not allowed to do that.');
      }
      // An account still on the starter password can do nothing except replace it.
      if (user.must_change && !route.beforePasswordChange) {
        throw new HttpError(403, 'Change your starter password before using the system.');
      }
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req, route.maxBody);
    const query = Object.fromEntries(url.searchParams.entries());
    const result = await route.handler({ req, res, params, query, body, user });
    if (result !== RAW) sendJson(res, 200, result === undefined ? { ok: true } : result);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
    } else {
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on the server. Check the server window for details.' });
    }
  }
}

// ---------- session ----------

add('POST', '/api/login', 'public', ({ req, res, body }) => {
  const username = str(body.username, 'Username', { required: true, max: 60 });
  const password = String(body.password || '');
  const key = `${req.socket.remoteAddress}|${username.toLowerCase()}`;
  const fail = loginFails.get(key);
  if (fail && fail.until > Date.now()) {
    throw new HttpError(429, 'Too many wrong passwords. Wait a minute and try again.');
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  const ok =
    user &&
    crypto.timingSafeEqual(Buffer.from(hashPassword(password, user.salt), 'hex'), Buffer.from(user.pass_hash, 'hex'));
  if (!ok) {
    const count = (fail && fail.count ? fail.count : 0) + 1;
    loginFails.set(key, { count: count >= 5 ? 0 : count, until: count >= 5 ? Date.now() + 60000 : 0 });
    throw new HttpError(401, 'Wrong username or password.');
  }
  loginFails.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)').run(token, user.id, now());
  // Behind an HTTPS site (the hosting's proxy sets this header) the cookie is never sent over plain HTTP.
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
  return { user: publicUser(user) };
});

add(
  'POST',
  '/api/logout',
  'any',
  ({ res, user }) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(user.token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  },
  { beforePasswordChange: true }
);

add(
  'GET',
  '/api/bootstrap',
  'any',
  ({ user }) => {
    // Until the starter password is replaced, the account learns nothing but that fact.
    if (user.must_change) return { me: publicUser(user), must_change_password: true, shop_name: getSettings().shop_name };
    return {
      me: publicUser(user),
      settings: getSettings(),
      rates: getRates(),
      branches: db.prepare('SELECT * FROM branches ORDER BY id').all(),
      users: db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser),
      karats: KARATS,
    };
  },
  { beforePasswordChange: true }
);

add(
  'POST',
  '/api/me/password',
  'any',
  ({ body, user }) => {
    if (hashPassword(String(body.current || ''), user.salt) !== user.pass_hash) {
      throw bad('Your current password is not right.');
    }
    const next = String(body.next || '');
    if (next.length < 6) throw bad('The new password needs at least 6 characters.');
    if (next === STARTER_PASSWORD || next === String(body.current)) throw bad('Choose a password different from the one you have now.');
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET pass_hash = ?, salt = ?, must_change = 0 WHERE id = ?').run(hashPassword(next, salt), salt, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, user.token);
  },
  { beforePasswordChange: true }
);

add('GET', '/api/events', 'any', ({ req, res, user }) => {
  openStream(req, res, { userId: user.id });
  return RAW;
});

// ---------- gold rates ----------

add('GET', '/api/rates', 'any', () => getRates());

add('PUT', '/api/rates', ['admin', 'manager'], ({ body, user }) => {
  const list = Array.isArray(body.rates) ? body.rates : [];
  if (!list.length) throw bad('No rates were sent.');
  const cleaned = list.map((r) => {
    const karat = karatOf(r.karat);
    const sell = r2(num(r.sell_rate, `${karat}K selling rate`, { min: 0 }));
    const buy = r2(num(r.buy_rate, `${karat}K buying rate`, { min: 0 }));
    if (buy > sell && sell > 0) {
      throw bad(`${karat}K buying rate is higher than its selling rate. Check the two numbers.`);
    }
    return { karat, sell, buy };
  });
  tx(() => {
    const at = now();
    const current = rateMap();
    for (const r of cleaned) {
      const old = current[r.karat];
      if (old && old.sell_rate === r.sell && old.buy_rate === r.buy) continue;
      db.prepare('UPDATE rates SET sell_rate = ?, buy_rate = ?, updated_at = ?, updated_by = ? WHERE karat = ?').run(
        r.sell, r.buy, at, user.id, r.karat
      );
      db.prepare('INSERT INTO rate_history (karat, sell_rate, buy_rate, created_at, user_id) VALUES (?,?,?,?,?)').run(
        r.karat, r.sell, r.buy, at, user.id
      );
    }
  });
  const rates = getRates();
  emit('rates', rates);
  return rates;
});

add('GET', '/api/rates/history', 'any', () =>
  db
    .prepare(
      `SELECT h.id, h.karat, h.sell_rate, h.buy_rate, h.created_at, u.name AS user_name
       FROM rate_history h LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id DESC LIMIT 200`
    )
    .all()
);

// ---------- stock ----------

function readItemBody(body, user) {
  const item = {
    sku: str(body.sku, 'Tag number', { max: 40 }),
    name: str(body.name, 'Item name', { required: true, max: 120 }),
    category: str(body.category, 'Category', { max: 60 }),
    karat: karatOf(body.karat),
    weight_g: r3(num(body.weight_g, 'Weight', { min: 0.001, max: 100000 })),
    making_charge: r2(num(body.making_charge === '' || body.making_charge == null ? 0 : body.making_charge, 'Making charge', { min: 0 })),
    qty: num(body.qty === '' || body.qty == null ? 1 : body.qty, 'Quantity', { min: 0, max: 100000, int: true }),
    branch_id: num(body.branch_id || user.branch_id, 'Branch', { int: true }),
    notes: str(body.notes, 'Notes', { max: 500 }),
  };
  if (!branchExists(item.branch_id)) throw bad('That branch does not exist.');
  return item;
}

add('GET', '/api/items', 'any', ({ query }) => {
  const where = [];
  const args = [];
  const q = (query.q || '').trim();
  if (q) {
    where.push('(sku LIKE ? OR name LIKE ? OR category LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (query.branch_id) {
    where.push('branch_id = ?');
    args.push(Number(query.branch_id));
  }
  if (query.karat) {
    where.push('karat = ?');
    args.push(Number(query.karat));
  }
  if (query.stock === 'in') where.push('qty > 0');
  if (query.stock === 'out') where.push('qty = 0');
  const sql =
    'SELECT * FROM items' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY (sku = ?) DESC, id DESC LIMIT 500';
  return db.prepare(sql).all(...args, q);
});

add('POST', '/api/items', ['admin', 'manager'], ({ body, user }) => {
  const it = readItemBody(body, user);
  return tx(() => {
    if (it.sku && db.prepare('SELECT id FROM items WHERE sku = ?').get(it.sku)) {
      throw bad(`Tag number ${it.sku} is already used by another item.`);
    }
    const info = db
      .prepare(
        `INSERT INTO items (sku, name, category, karat, weight_g, making_charge, qty, branch_id, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(it.sku || null, it.name, it.category, it.karat, it.weight_g, it.making_charge, it.qty, it.branch_id, it.notes, now());
    const id = Number(info.lastInsertRowid);
    if (!it.sku) db.prepare('UPDATE items SET sku = ? WHERE id = ?').run(`NJ-${pad6(id)}`, id);
    return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  });
});

add('PUT', '/api/items/:id', ['admin', 'manager'], ({ body, params, user }) => {
  const id = Number(params.id);
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, 'That item no longer exists.');
  const it = readItemBody(body, user);
  const sku = it.sku || existing.sku;
  const clash = db.prepare('SELECT id FROM items WHERE sku = ? AND id != ?').get(sku, id);
  if (clash) throw bad(`Tag number ${sku} is already used by another item.`);
  db.prepare(
    `UPDATE items SET sku = ?, name = ?, category = ?, karat = ?, weight_g = ?, making_charge = ?, qty = ?, branch_id = ?, notes = ?
     WHERE id = ?`
  ).run(sku, it.name, it.category, it.karat, it.weight_g, it.making_charge, it.qty, it.branch_id, it.notes, id);
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
});

add('DELETE', '/api/items/:id', ['admin', 'manager'], ({ params }) => {
  const id = Number(params.id);
  if (db.prepare('SELECT id FROM sale_items WHERE item_id = ? LIMIT 1').get(id)) {
    throw bad('This item appears on a past bill, so it cannot be deleted. Set its quantity to 0 instead.');
  }
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
});

// ---------- customers ----------

function readCustomerBody(body) {
  return {
    name: str(body.name, 'Customer name', { required: true, max: 120 }),
    phone: str(body.phone, 'Phone', { max: 30 }),
    id_number: str(body.id_number, 'ID number', { max: 40 }),
    address: str(body.address, 'Address', { max: 300 }),
    notes: str(body.notes, 'Notes', { max: 500 }),
  };
}

add('GET', '/api/customers', 'any', ({ query }) => {
  const q = (query.q || '').trim();
  if (!q) return db.prepare('SELECT * FROM customers ORDER BY id DESC LIMIT 500').all();
  const like = `%${q}%`;
  return db
    .prepare('SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR id_number LIKE ? ORDER BY name LIMIT 500')
    .all(like, like, like);
});

add('POST', '/api/customers', 'any', ({ body }) => {
  const c = readCustomerBody(body);
  const info = db
    .prepare('INSERT INTO customers (name, phone, id_number, address, notes, created_at) VALUES (?,?,?,?,?,?)')
    .run(c.name, c.phone, c.id_number, c.address, c.notes, now());
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(info.lastInsertRowid));
});

add('PUT', '/api/customers/:id', 'any', ({ body, params }) => {
  const id = Number(params.id);
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(id)) {
    throw new HttpError(404, 'That customer no longer exists.');
  }
  const c = readCustomerBody(body);
  db.prepare('UPDATE customers SET name = ?, phone = ?, id_number = ?, address = ?, notes = ? WHERE id = ?').run(
    c.name, c.phone, c.id_number, c.address, c.notes, id
  );
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
});

add('GET', '/api/customers/:id', 'any', ({ params }) => {
  const id = Number(params.id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) throw new HttpError(404, 'That customer no longer exists.');
  return {
    customer,
    sales: db
      .prepare('SELECT id, invoice_no, total, status, created_at FROM sales WHERE customer_id = ? ORDER BY id DESC LIMIT 100')
      .all(id),
    purchases: db
      .prepare(
        'SELECT id, voucher_no, total, payment_method, status, created_at FROM purchases WHERE customer_id = ? ORDER BY id DESC LIMIT 100'
      )
      .all(id),
  };
});

// ---------- selling ----------

function canEditRate(user, settings) {
  return user.role !== 'cashier' || settings.cashier_edit_rate === '1';
}

// Validates gold bought from a customer (a purchase, or old gold given against a bill).
function readGoldLines(lines, rates, allowRateEdit) {
  return lines.map((ln, i) => {
    const label = `Gold line ${i + 1}`;
    const karat = karatOf(ln.karat);
    const weight = r3(num(ln.weight_g, `${label} weight`, { min: 0.001, max: 100000 }));
    const current = rates[karat].buy_rate;
    let rate = current;
    if (allowRateEdit && ln.rate !== undefined && ln.rate !== null && ln.rate !== '') {
      rate = r2(num(ln.rate, `${label} rate`, { min: 0.01 }));
    }
    if (!(rate > 0)) throw bad(`Set today's ${karat}K buying rate before buying gold.`);
    return {
      description: str(ln.description, `${label} description`, { max: 160 }) || `Old gold ${karat}K`,
      karat,
      weight_g: weight,
      rate,
      line_total: r2(weight * rate),
    };
  });
}

function insertPurchase({ branchId, userId, customerId, lines, method, saleId, note, at }) {
  const total = r2(lines.reduce((sum, l) => sum + l.line_total, 0));
  const info = db
    .prepare(
      `INSERT INTO purchases (branch_id, user_id, customer_id, total, payment_method, sale_id, note, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(branchId, userId, customerId, total, method, saleId, note, at);
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE purchases SET voucher_no = ? WHERE id = ?').run(`PUR-${pad6(id)}`, id);
  const ins = db.prepare(
    'INSERT INTO purchase_items (purchase_id, description, karat, weight_g, rate, line_total) VALUES (?,?,?,?,?,?)'
  );
  for (const l of lines) ins.run(id, l.description, l.karat, l.weight_g, l.rate, l.line_total);
  return { id, total };
}

function getPurchase(id) {
  const p = db
    .prepare(
      `SELECT p.*, b.name AS branch_name, u.name AS user_name, s.invoice_no AS sale_invoice_no
       FROM purchases p JOIN branches b ON b.id = p.branch_id JOIN users u ON u.id = p.user_id
       LEFT JOIN sales s ON s.id = p.sale_id WHERE p.id = ?`
    )
    .get(id);
  if (!p) throw new HttpError(404, 'That voucher does not exist.');
  p.customer = p.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(p.customer_id) : null;
  p.items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(id);
  return p;
}

function getSale(id) {
  const s = db
    .prepare(
      `SELECT s.*, b.name AS branch_name, u.name AS user_name
       FROM sales s JOIN branches b ON b.id = s.branch_id JOIN users u ON u.id = s.user_id WHERE s.id = ?`
    )
    .get(id);
  if (!s) throw new HttpError(404, 'That bill does not exist.');
  s.customer = s.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(s.customer_id) : null;
  s.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id);
  const exchange = db.prepare('SELECT id FROM purchases WHERE sale_id = ?').get(id);
  s.exchange = exchange ? getPurchase(exchange.id) : null;
  return s;
}

add('POST', '/api/sales', 'any', ({ body, user }) => {
  const settings = getSettings();
  const allowRateEdit = canEditRate(user, settings);
  const rates = rateMap();
  const lines = Array.isArray(body.items) ? body.items : [];
  const goldIn = Array.isArray(body.old_gold) ? body.old_gold : [];
  if (!lines.length) throw bad('Add at least one item to the bill.');
  if (lines.length > 200 || goldIn.length > 200) throw bad('That bill has too many lines.');

  let customerId = null;
  if (body.customer_id) {
    customerId = Number(body.customer_id);
    if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw bad('That customer no longer exists.');
  }
  if (goldIn.length && !customerId) throw bad('Choose a customer before taking old gold in exchange.');

  const saleId = tx(() => {
    const stockLeft = new Map();
    const prepared = lines.map((ln, i) => {
      const label = `Line ${i + 1}`;
      let item = null;
      if (ln.item_id) {
        item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(ln.item_id));
        if (!item) throw bad(`${label}: that stock item no longer exists.`);
        if (item.branch_id !== user.branch_id) {
          throw bad(`${item.name} (${item.sku}) is at another branch. Transfer it to your branch first.`);
        }
      }
      const qty = num(ln.qty === undefined || ln.qty === '' ? 1 : ln.qty, `${label} quantity`, { min: 1, max: 10000, int: true });
      if (item) {
        const left = stockLeft.has(item.id) ? stockLeft.get(item.id) : item.qty;
        if (left < qty) throw bad(`Only ${left} of ${item.name} (${item.sku}) left in stock.`);
        stockLeft.set(item.id, left - qty);
      }
      const karat = item ? item.karat : karatOf(ln.karat);
      const weight = item ? item.weight_g : r3(num(ln.weight_g, `${label} weight`, { min: 0.001, max: 100000 }));
      let rate = rates[karat].sell_rate;
      if (allowRateEdit && ln.rate !== undefined && ln.rate !== null && ln.rate !== '') {
        rate = r2(num(ln.rate, `${label} rate`, { min: 0.01 }));
      }
      if (!(rate > 0)) throw bad(`Set today's ${karat}K selling rate before selling.`);
      const making =
        ln.making_charge === undefined || ln.making_charge === null || ln.making_charge === ''
          ? item ? item.making_charge : 0
          : r2(num(ln.making_charge, `${label} making charge`, { min: 0 }));
      const description = item ? item.name : str(ln.description, `${label} description`, { required: true, max: 160 });
      return {
        item_id: item ? item.id : null,
        sku: item ? item.sku : '',
        description,
        karat,
        weight_g: weight,
        rate,
        making_charge: making,
        qty,
        line_total: r2((weight * rate + making) * qty),
      };
    });

    const subtotal = r2(prepared.reduce((sum, l) => sum + l.line_total, 0));
    const discount = r2(num(body.discount === undefined || body.discount === '' ? 0 : body.discount, 'Discount', { min: 0 }));
    if (discount > subtotal) throw bad('The discount is more than the bill.');
    const taxPercent = Number(settings.tax_percent) || 0;
    const tax = r2(((subtotal - discount) * taxPercent) / 100);
    const total = r2(subtotal - discount + tax);

    const gold = readGoldLines(goldIn, rates, allowRateEdit);
    const oldGoldValue = r2(gold.reduce((sum, l) => sum + l.line_total, 0));
    const net = r2(total - oldGoldValue);

    const pay = body.payments || {};
    const cash = r2(num(pay.cash || 0, 'Cash', { min: 0 }));
    const card = r2(num(pay.card || 0, 'Card', { min: 0 }));
    const bank = r2(num(pay.bank || 0, 'Bank transfer', { min: 0 }));
    let paidCash = 0;
    let change = 0;
    if (net > 0) {
      if (card + bank > net + 0.005) throw bad('Card and bank payments add up to more than the amount due.');
      const paid = r2(cash + card + bank);
      if (paid < net - 0.005) throw bad(`Payment is short by ${r2(net - paid).toFixed(2)}.`);
      change = r2(paid - net);
      paidCash = r2(cash - change);
    } else {
      if (cash + card + bank > 0) throw bad('Nothing is due on this bill. Clear the payment amounts.');
      paidCash = net; // negative: the shop pays the customer the difference in cash
    }

    const at = now();
    const info = db
      .prepare(
        `INSERT INTO sales (branch_id, user_id, customer_id, subtotal, discount, tax, total, old_gold_value, net_payable,
           paid_cash, paid_card, paid_bank, cash_tendered, change_given, note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        user.branch_id, user.id, customerId, subtotal, discount, tax, total, oldGoldValue, net,
        paidCash, card, bank, cash, change, str(body.note, 'Note', { max: 500 }), at
      );
    const id = Number(info.lastInsertRowid);
    db.prepare('UPDATE sales SET invoice_no = ? WHERE id = ?').run(`INV-${pad6(id)}`, id);

    const insLine = db.prepare(
      `INSERT INTO sale_items (sale_id, item_id, sku, description, karat, weight_g, rate, making_charge, qty, line_total)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    const takeStock = db.prepare('UPDATE items SET qty = qty - ? WHERE id = ?');
    for (const l of prepared) {
      insLine.run(id, l.item_id, l.sku, l.description, l.karat, l.weight_g, l.rate, l.making_charge, l.qty, l.line_total);
      if (l.item_id) takeStock.run(l.qty, l.item_id);
    }
    if (gold.length) {
      insertPurchase({
        branchId: user.branch_id, userId: user.id, customerId, lines: gold,
        method: 'exchange', saleId: id, note: `Exchanged against INV-${pad6(id)}`, at,
      });
    }
    return id;
  });
  return getSale(saleId);
});

add('GET', '/api/sales', 'any', ({ query }) => {
  const { fromIso, toIso } = dateRange(query);
  const where = ['s.created_at BETWEEN ? AND ?'];
  const args = [fromIso, toIso];
  if (query.branch_id) {
    where.push('s.branch_id = ?');
    args.push(Number(query.branch_id));
  }
  return db
    .prepare(
      `SELECT s.id, s.invoice_no, s.total, s.net_payable, s.old_gold_value, s.status, s.created_at, s.branch_id,
              u.name AS user_name, c.name AS customer_name
       FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
       WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT 1000`
    )
    .all(...args);
});

// These two must be registered before /api/sales/:id so "next" and "last" are not read as ids.
add('GET', '/api/sales/next', 'any', () => {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sales'").get();
  return { invoice_no: `INV-${pad6((row ? row.seq : 0) + 1)}` };
});

add('GET', '/api/sales/last', 'any', ({ user }) => {
  const row = db.prepare('SELECT id FROM sales WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
  if (!row) throw new HttpError(404, 'You have not made a bill yet, so there is nothing to copy.');
  return getSale(row.id);
});

add('GET', '/api/sales/:id', 'any', ({ params }) => getSale(Number(params.id)));

add('POST', '/api/sales/:id/void', ['admin', 'manager'], ({ params, user }) => {
  const id = Number(params.id);
  tx(() => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    if (!sale) throw new HttpError(404, 'That bill does not exist.');
    if (sale.status === 'void') throw bad('This bill is already cancelled.');
    const at = now();
    db.prepare("UPDATE sales SET status = 'void', voided_by = ?, voided_at = ? WHERE id = ?").run(user.id, at, id);
    const putBack = db.prepare('UPDATE items SET qty = qty + ? WHERE id = ?');
    for (const l of db.prepare('SELECT item_id, qty FROM sale_items WHERE sale_id = ? AND item_id IS NOT NULL').all(id)) {
      putBack.run(l.qty, l.item_id);
    }
    db.prepare("UPDATE purchases SET status = 'void', voided_by = ?, voided_at = ? WHERE sale_id = ?").run(user.id, at, id);
  });
  return getSale(id);
});

// ---------- buying gold ----------

add('POST', '/api/purchases', 'any', ({ body, user }) => {
  const settings = getSettings();
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw bad('Add at least one line of gold.');
  if (lines.length > 200) throw bad('That voucher has too many lines.');
  const customerId = Number(body.customer_id);
  if (!customerId || !db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) {
    throw bad('Choose the customer you are buying from. Their details go on the voucher.');
  }
  const method = body.payment_method === 'bank' ? 'bank' : 'cash';
  const id = tx(() => {
    const gold = readGoldLines(lines, rateMap(), canEditRate(user, settings));
    return insertPurchase({
      branchId: user.branch_id, userId: user.id, customerId, lines: gold,
      method, saleId: null, note: str(body.note, 'Note', { max: 500 }), at: now(),
    }).id;
  });
  return getPurchase(id);
});

add('GET', '/api/purchases', 'any', ({ query }) => {
  const { fromIso, toIso } = dateRange(query);
  const where = ['p.created_at BETWEEN ? AND ?'];
  const args = [fromIso, toIso];
  if (query.branch_id) {
    where.push('p.branch_id = ?');
    args.push(Number(query.branch_id));
  }
  return db
    .prepare(
      `SELECT p.id, p.voucher_no, p.total, p.payment_method, p.status, p.created_at, p.branch_id, p.sale_id,
              u.name AS user_name, c.name AS customer_name,
              (SELECT COALESCE(SUM(weight_g), 0) FROM purchase_items WHERE purchase_id = p.id) AS weight_g
       FROM purchases p JOIN users u ON u.id = p.user_id LEFT JOIN customers c ON c.id = p.customer_id
       WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 1000`
    )
    .all(...args);
});

add('GET', '/api/purchases/:id', 'any', ({ params }) => getPurchase(Number(params.id)));

add('POST', '/api/purchases/:id/void', ['admin', 'manager'], ({ params, user }) => {
  const id = Number(params.id);
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'That voucher does not exist.');
  if (p.status === 'void') throw bad('This voucher is already cancelled.');
  if (p.sale_id) throw bad('This gold was exchanged against a bill. Cancel the bill instead and both are cancelled.');
  db.prepare("UPDATE purchases SET status = 'void', voided_by = ?, voided_at = ? WHERE id = ?").run(user.id, now(), id);
  return getPurchase(id);
});

// ---------- reports ----------

function summary(fromIso, toIso, branchId) {
  const bw = (col) => (branchId ? ` AND ${col} = ?` : '');
  const args = branchId ? [fromIso, toIso, branchId] : [fromIso, toIso];

  const sales = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(subtotal),0) AS subtotal, COALESCE(SUM(discount),0) AS discount,
              COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(total),0) AS total, COALESCE(SUM(old_gold_value),0) AS old_gold_value,
              COALESCE(SUM(paid_cash),0) AS cash, COALESCE(SUM(paid_card),0) AS card, COALESCE(SUM(paid_bank),0) AS bank
       FROM sales WHERE status = 'completed' AND created_at BETWEEN ? AND ?${bw('branch_id')}`
    )
    .get(...args);

  const purchases = { count: 0, total: 0, cash: 0, bank: 0, exchange: 0 };
  for (const row of db
    .prepare(
      `SELECT payment_method, COUNT(*) AS n, COALESCE(SUM(total),0) AS total
       FROM purchases WHERE status = 'completed' AND created_at BETWEEN ? AND ?${bw('branch_id')} GROUP BY payment_method`
    )
    .all(...args)) {
    purchases.count += row.n;
    purchases.total = r2(purchases.total + row.total);
    purchases[row.payment_method] = r2(row.total);
  }

  const soldByKarat = db
    .prepare(
      `SELECT si.karat, SUM(si.qty) AS pieces, SUM(si.weight_g * si.qty) AS weight_g, SUM(si.line_total) AS amount
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.status = 'completed' AND s.created_at BETWEEN ? AND ?${bw('s.branch_id')} GROUP BY si.karat ORDER BY si.karat DESC`
    )
    .all(...args);

  const boughtByKarat = db
    .prepare(
      `SELECT pi.karat, COUNT(*) AS pieces, SUM(pi.weight_g) AS weight_g, SUM(pi.line_total) AS amount
       FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
       WHERE p.status = 'completed' AND p.created_at BETWEEN ? AND ?${bw('p.branch_id')} GROUP BY pi.karat ORDER BY pi.karat DESC`
    )
    .all(...args);

  const byUser = db
    .prepare(
      `SELECT u.name, COUNT(*) AS count, SUM(s.total) AS total
       FROM sales s JOIN users u ON u.id = s.user_id
       WHERE s.status = 'completed' AND s.created_at BETWEEN ? AND ?${bw('s.branch_id')} GROUP BY s.user_id ORDER BY total DESC`
    )
    .all(...args);

  const days = new Map();
  const bucket = (iso) => {
    const key = localDate(new Date(iso));
    if (!days.has(key)) days.set(key, { date: key, sales: 0, purchases: 0 });
    return days.get(key);
  };
  for (const row of db
    .prepare(`SELECT created_at, total FROM sales WHERE status = 'completed' AND created_at BETWEEN ? AND ?${bw('branch_id')}`)
    .all(...args)) {
    const d = bucket(row.created_at);
    d.sales = r2(d.sales + row.total);
  }
  for (const row of db
    .prepare(`SELECT created_at, total FROM purchases WHERE status = 'completed' AND created_at BETWEEN ? AND ?${bw('branch_id')}`)
    .all(...args)) {
    const d = bucket(row.created_at);
    d.purchases = r2(d.purchases + row.total);
  }

  const stock = db
    .prepare(
      `SELECT karat, SUM(qty) AS pieces, SUM(weight_g * qty) AS weight_g FROM items
       WHERE qty > 0${branchId ? ' AND branch_id = ?' : ''} GROUP BY karat ORDER BY karat DESC`
    )
    .all(...(branchId ? [branchId] : []));

  return {
    sales,
    purchases,
    cash_drawer: r2(sales.cash - purchases.cash),
    sold_by_karat: soldByKarat,
    bought_by_karat: boughtByKarat,
    by_user: byUser,
    days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    stock,
  };
}

add('GET', '/api/reports/summary', 'any', ({ query, user }) => {
  // Cashiers only see today's figures for their own branch.
  if (user.role === 'cashier') {
    const range = dateRange({});
    return { ...range, ...summary(range.fromIso, range.toIso, user.branch_id) };
  }
  const range = dateRange(query);
  return { ...range, ...summary(range.fromIso, range.toIso, query.branch_id ? Number(query.branch_id) : null) };
});

// ---------- staff messages ----------

function lastRead(userId, thread) {
  const row = db.prepare('SELECT last_read_id FROM message_reads WHERE user_id = ? AND thread = ?').get(userId, thread);
  return row ? row.last_read_id : 0;
}

function markRead(userId, thread) {
  const row =
    thread === 'all'
      ? db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE to_user IS NULL').get()
      : db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE from_user = ? AND to_user = ?').get(Number(thread), userId);
  db.prepare(
    `INSERT INTO message_reads (user_id, thread, last_read_id) VALUES (?,?,?)
     ON CONFLICT(user_id, thread) DO UPDATE SET last_read_id = excluded.last_read_id`
  ).run(userId, thread, row.m);
}

function threadKey(value, me) {
  if (value === 'all' || value === undefined) return 'all';
  const id = Number(value);
  if (!Number.isInteger(id) || id === me.id || !db.prepare('SELECT id FROM users WHERE id = ?').get(id)) {
    throw bad('That conversation does not exist.');
  }
  return String(id);
}

add('GET', '/api/messages/threads', 'any', ({ user }) => {
  const threads = [];
  const allLast = db
    .prepare(
      `SELECT m.body, m.created_at, u.name AS from_name FROM messages m JOIN users u ON u.id = m.from_user
       WHERE m.to_user IS NULL ORDER BY m.id DESC LIMIT 1`
    )
    .get();
  threads.push({
    key: 'all',
    name: 'Everyone',
    last: allLast || null,
    unread: db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE to_user IS NULL AND from_user != ? AND id > ?')
      .get(user.id, lastRead(user.id, 'all')).n,
  });
  for (const other of db.prepare('SELECT id, name, role FROM users WHERE active = 1 AND id != ? ORDER BY name').all(user.id)) {
    const last = db
      .prepare(
        `SELECT body, created_at FROM messages
         WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY id DESC LIMIT 1`
      )
      .get(user.id, other.id, other.id, user.id);
    threads.push({
      key: String(other.id),
      name: other.name,
      role: other.role,
      last: last || null,
      unread: db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE from_user = ? AND to_user = ? AND id > ?')
        .get(other.id, user.id, lastRead(user.id, String(other.id))).n,
    });
  }
  return threads;
});

add('GET', '/api/messages', 'any', ({ query, user }) => {
  const key = threadKey(query.with, user);
  const rows =
    key === 'all'
      ? db
          .prepare(
            `SELECT m.*, u.name AS from_name FROM messages m JOIN users u ON u.id = m.from_user
             WHERE m.to_user IS NULL ORDER BY m.id DESC LIMIT 200`
          )
          .all()
      : db
          .prepare(
            `SELECT m.*, u.name AS from_name FROM messages m JOIN users u ON u.id = m.from_user
             WHERE (m.from_user = ? AND m.to_user = ?) OR (m.from_user = ? AND m.to_user = ?) ORDER BY m.id DESC LIMIT 200`
          )
          .all(user.id, Number(key), Number(key), user.id);
  markRead(user.id, key);
  return rows.reverse();
});

add('POST', '/api/messages', 'any', ({ body, user }) => {
  const key = threadKey(body.to, user);
  const text = str(body.body, 'Message', { required: true, max: 2000 });
  const toUser = key === 'all' ? null : Number(key);
  const info = db
    .prepare('INSERT INTO messages (from_user, to_user, body, created_at) VALUES (?,?,?,?)')
    .run(user.id, toUser, text, now());
  const message = db
    .prepare('SELECT m.*, u.name AS from_name FROM messages m JOIN users u ON u.id = m.from_user WHERE m.id = ?')
    .get(Number(info.lastInsertRowid));
  emit('message', message, (c) => c.userId && (toUser === null || c.userId === toUser || c.userId === user.id));
  return message;
});

add('POST', '/api/messages/read', 'any', ({ body, user }) => {
  markRead(user.id, threadKey(body.with, user));
});

// ---------- customer messages ----------

function internationalNumber(phone, countryCode) {
  let d = String(phone).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = countryCode + d.slice(1);
  else if (d.length <= 9) d = countryCode + d;
  return d.replace(/\D/g, '');
}

add('POST', '/api/customer-messages', 'any', async ({ body, user }) => {
  const settings = getSettings();
  const template = str(body.body, 'Message', { required: true, max: 1000 });
  const channel = body.channel === 'sms' ? 'sms' : 'whatsapp';
  const ids = Array.isArray(body.customer_ids) ? body.customer_ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) throw bad('Choose at least one customer.');
  if (ids.length > 500) throw bad('Send to 500 customers at most in one go.');
  if (channel === 'sms' && !settings.sms_gateway_url) {
    throw bad('No SMS gateway is set up yet. An admin can add one under Settings, or send by WhatsApp instead.');
  }
  const rates = rateMap();
  const money = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const results = [];
  const log = db.prepare(
    'INSERT INTO customer_messages (customer_id, phone, body, channel, status, user_id, created_at) VALUES (?,?,?,?,?,?,?)'
  );
  for (const id of ids) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) continue;
    const number = c.phone ? internationalNumber(c.phone, settings.country_code || '') : '';
    const text = template
      .replace(/\{name\}/g, c.name)
      .replace(/\{shop\}/g, settings.shop_name)
      .replace(/\{rate(24|22|21|18)\}/g, (_, k) => `${settings.currency} ${money(rates[k].sell_rate)}`);
    let status;
    let link = null;
    if (!number) {
      status = 'no phone number';
    } else if (channel === 'whatsapp') {
      link = `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
      status = 'ready to send';
    } else {
      const target = settings.sms_gateway_url
        .replace(/\{to\}/g, encodeURIComponent(number))
        .replace(/\{message\}/g, encodeURIComponent(text));
      try {
        const reply = await fetch(target, { signal: AbortSignal.timeout(10000) });
        status = reply.ok ? 'sent' : `failed (gateway said ${reply.status})`;
      } catch {
        status = 'failed (gateway unreachable)';
      }
    }
    log.run(c.id, number, text, channel, status, user.id, now());
    results.push({ customer_id: c.id, name: c.name, phone: c.phone, text, link, status });
  }
  return results;
});

add('GET', '/api/customer-messages', 'any', () =>
  db
    .prepare(
      `SELECT m.id, m.phone, m.body, m.channel, m.status, m.created_at, c.name AS customer_name, u.name AS user_name
       FROM customer_messages m LEFT JOIN customers c ON c.id = m.customer_id LEFT JOIN users u ON u.id = m.user_id
       ORDER BY m.id DESC LIMIT 200`
    )
    .all()
);

// ---------- shop TV ----------

add('GET', '/api/tv', 'public', () => tvPayload());

add('GET', '/api/tv/events', 'public', ({ req, res }) => {
  openStream(req, res, { tv: true });
  return RAW;
});

add('PUT', '/api/tv', ['admin', 'manager'], ({ body }) => {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (body.message !== undefined) set.run('tv_message', str(body.message, 'TV message', { max: 300 }));
  if (body.show_pavan !== undefined) set.run('tv_show_pavan', body.show_pavan ? '1' : '0');
  if (body.show_buy !== undefined) set.run('tv_show_buy', body.show_buy ? '1' : '0');
  if (body.theme !== undefined) {
    if (!TV_THEMES.includes(body.theme)) throw bad(`The TV design must be one of: ${TV_THEMES.join(', ')}.`);
    set.run('tv_theme', body.theme);
  }
  if (body.subtitle !== undefined) set.run('tv_subtitle', str(body.subtitle, 'Line under the shop name', { max: 80 }));
  if (body.points !== undefined) {
    if (!Array.isArray(body.points) || body.points.length > 3) throw bad('Send up to three selling points.');
    const points = body.points.map((p, i) => [
      str(Array.isArray(p) ? p[0] : '', `Selling point ${i + 1} heading`, { max: 30 }),
      str(Array.isArray(p) ? p[1] : '', `Selling point ${i + 1} detail`, { max: 50 }),
    ]);
    set.run('tv_points', JSON.stringify(points));
  }
  const payload = tvPayload();
  emit('tv', payload);
  return payload;
});

// Pictures for the TV slideshow. Stored as files beside the database.
const TV_IMAGE_TYPES = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const TV_IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

add('GET', '/api/tv/images', ['admin', 'manager'], () => tvImages());

add(
  'POST',
  '/api/tv/images',
  ['admin', 'manager'],
  ({ body }) => {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw bad('Choose a JPEG, PNG or WebP picture.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) throw bad('That picture is too large. Use one under 5 MB.');
    const looksRight =
      (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8) ||
      (m[1] === 'png' && buf.subarray(0, 4).toString('latin1') === '\x89PNG') ||
      (m[1] === 'webp' && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP');
    if (!looksRight) throw bad('That file is not a valid picture.');
    if (db.prepare('SELECT COUNT(*) AS n FROM tv_images').get().n >= 20) {
      throw bad('The TV can hold 20 pictures. Remove one before adding another.');
    }
    const file = `${crypto.randomBytes(10).toString('hex')}.${TV_IMAGE_TYPES[m[1]]}`;
    fs.writeFileSync(path.join(TV_DIR, file), buf);
    db.prepare('INSERT INTO tv_images (file, created_at) VALUES (?, ?)').run(file, now());
    emit('tv', tvPayload());
    return tvImages();
  },
  { maxBody: 8 * 1024 * 1024 }
);

add('DELETE', '/api/tv/images/:id', ['admin', 'manager'], ({ params }) => {
  const row = db.prepare('SELECT * FROM tv_images WHERE id = ?').get(Number(params.id));
  if (row) {
    db.prepare('DELETE FROM tv_images WHERE id = ?').run(row.id);
    fs.rm(path.join(TV_DIR, row.file), { force: true }, () => {});
    emit('tv', tvPayload());
  }
  return tvImages();
});

add('GET', '/api/tv/image/:file', 'public', ({ params, res }) => {
  // Names are generated by the server, so anything else is refused rather than looked up.
  const m = /^[a-f0-9]{20}\.(jpg|png|webp)$/.exec(params.file);
  const full = m ? path.join(TV_DIR, params.file) : null;
  if (!full || !fs.existsSync(full)) throw new HttpError(404, 'That picture does not exist.');
  res.writeHead(200, {
    'Content-Type': TV_IMAGE_MIME[m[1]],
    'Content-Length': fs.statSync(full).size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(full).pipe(res);
  return RAW;
});

add('GET', '/api/server-info', 'any', ({ req }) => {
  const port = req.socket.localPort;
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) addresses.push(a.address);
    }
  }
  return { port, addresses, urls: addresses.map((a) => `http://${a}:${port}`) };
});

// ---------- admin ----------

add('GET', '/api/users', ['admin'], () => db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser));

function readRole(value) {
  if (!['admin', 'manager', 'cashier'].includes(value)) throw bad('Role must be admin, manager or cashier.');
  return value;
}

add('POST', '/api/users', ['admin'], ({ body }) => {
  const username = str(body.username, 'Username', { required: true, max: 40 });
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw bad('Usernames can use letters, numbers, dots, dashes and underscores.');
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw bad(`The username ${username} is taken.`);
  const password = String(body.password || '');
  if (password.length < 6) throw bad('The password needs at least 6 characters.');
  const branchId = num(body.branch_id, 'Branch', { int: true });
  if (!branchExists(branchId)) throw bad('That branch does not exist.');
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare('INSERT INTO users (username, name, pass_hash, salt, role, branch_id, active, created_at) VALUES (?,?,?,?,?,?,1,?)')
    .run(username, str(body.name, 'Name', { required: true, max: 80 }), hashPassword(password, salt), salt, readRole(body.role), branchId, now());
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid)));
});

add('PUT', '/api/users/:id', ['admin'], ({ body, params }) => {
  const id = Number(params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, 'That user no longer exists.');
  const role = readRole(body.role);
  const active = body.active ? 1 : 0;
  const branchId = num(body.branch_id, 'Branch', { int: true });
  if (!branchExists(branchId)) throw bad('That branch does not exist.');
  if (existing.role === 'admin' && existing.active && (role !== 'admin' || !active)) {
    const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(id).n;
    if (!others) throw bad('This is the only admin account. Make another admin first.');
  }
  db.prepare('UPDATE users SET name = ?, role = ?, branch_id = ?, active = ? WHERE id = ?').run(
    str(body.name, 'Name', { required: true, max: 80 }), role, branchId, active, id
  );
  if (body.password) {
    const password = String(body.password);
    if (password.length < 6) throw bad('The password needs at least 6 characters.');
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hashPassword(password, salt), salt, id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
});

add('POST', '/api/branches', ['admin'], ({ body }) => {
  const info = db
    .prepare('INSERT INTO branches (name, address, phone) VALUES (?,?,?)')
    .run(str(body.name, 'Branch name', { required: true, max: 80 }), str(body.address, 'Address', { max: 300 }), str(body.phone, 'Phone', { max: 30 }));
  return db.prepare('SELECT * FROM branches WHERE id = ?').get(Number(info.lastInsertRowid));
});

add('PUT', '/api/branches/:id', ['admin'], ({ body, params }) => {
  const id = Number(params.id);
  if (!branchExists(id)) throw new HttpError(404, 'That branch no longer exists.');
  db.prepare('UPDATE branches SET name = ?, address = ?, phone = ? WHERE id = ?').run(
    str(body.name, 'Branch name', { required: true, max: 80 }), str(body.address, 'Address', { max: 300 }), str(body.phone, 'Phone', { max: 30 }), id
  );
  return db.prepare('SELECT * FROM branches WHERE id = ?').get(id);
});

add('PUT', '/api/settings', ['admin'], ({ body }) => {
  const limits = { receipt_footer: 300, shop_address: 300, sms_gateway_url: 500 };
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (body[key] === undefined || key === 'tv_points') continue; // tv_points goes through PUT /api/tv, which checks its shape
      let value = str(body[key], key, { max: limits[key] || 120 });
      if (key === 'tax_percent') value = String(num(value || 0, 'Tax percent', { min: 0, max: 100 }));
      if (key === 'tv_theme' && !TV_THEMES.includes(value)) throw bad('That TV design does not exist.');
      if (key === 'cashier_edit_rate' || key === 'tv_show_pavan' || key === 'tv_show_buy') value = value === '1' || value === 'true' ? '1' : '0';
      if (key === 'country_code') value = value.replace(/\D/g, '');
      if (key === 'shop_name' && !value) throw bad('The shop name cannot be empty.');
      if (key === 'sms_gateway_url' && value && !/^https?:\/\//i.test(value)) throw bad('The SMS gateway address must start with http:// or https://');
      set.run(key, value);
    }
  });
  emit('tv', tvPayload());
  return getSettings();
});

add('GET', '/api/backup', ['admin'], ({ res }) => {
  const file = path.join(DATA_DIR, `backup-${crypto.randomBytes(6).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const size = fs.statSync(file).size;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': `attachment; filename="nusky-backup-${localDate()}.db"`,
  });
  const stream = fs.createReadStream(file);
  const cleanup = () => fs.rm(file, { force: true }, () => {});
  stream.on('close', cleanup);
  stream.on('error', cleanup);
  stream.pipe(res);
  return RAW;
});

module.exports = { handleApi };
