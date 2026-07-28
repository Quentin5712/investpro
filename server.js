const http  = require('http');
const https = require('https');
const fs    = require('fs');
const url   = require('url');
const path  = require('path');

const PORT      = process.env.PORT      || 3000;
const BIN_ID    = process.env.BIN_ID    || '6a4cdd5cf5f4af5e296bb50b';
const API_KEY   = process.env.API_KEY   || '$2a$10$WiRdDM1vwwyaoA.yf/.XkuA/2173q1VIdQ56RJyfD4vGgp8U5tu.O';
const ADMIN_KEY = process.env.ADMIN_KEY || 'investpro_admin_secret_2024';
const DB_URL    = 'https://api.jsonbin.io/v3/b/';

// ── Helpers ──────────────────────────────────────────────

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function(resolve) {
    let d = '';
    req.on('data', function(chunk) { d += chunk; });
    req.on('end', function() {
      try { resolve(JSON.parse(d)); } catch(e) { resolve({}); }
    });
  });
}

function serveFile(res, filePath) {
  const ext  = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
}

// ── JSONBin ───────────────────────────────────────────────

function dbRead() {
  return new Promise(function(resolve) {
    const options = {
      hostname: 'api.jsonbin.io',
      path: '/v3/b/' + BIN_ID + '/latest',
      method: 'GET',
      headers: { 'X-Master-Key': API_KEY, 'X-Bin-Meta': 'false' }
    };
    const req = https.request(options, function(res) {
      let d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try {
          const j = JSON.parse(d);
          resolve(j.record !== undefined ? j.record : j);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.end();
  });
}

function dbWrite(data) {
  return new Promise(function(resolve) {
    const body = JSON.stringify(data);
    const options = {
      hostname: 'api.jsonbin.io',
      path: '/v3/b/' + BIN_ID,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': API_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, function(res) {
      let d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve(res.statusCode === 200); });
    });
    req.on('error', function() { resolve(false); });
    req.write(body);
    req.end();
  });
}

async function dbUpdate(fn) {
  const db = await dbRead();
  if (!db) return false;
  const updated = fn(JSON.parse(JSON.stringify(db)));
  return await dbWrite(updated);
}

// ── SMS Parser ────────────────────────────────────────────

function parseSMS(txt) {
  const patterns = [
    {
      op: 'MTN MoMo',
      amt: /(?:recu|reçu|received)\s+([\d\s]+)\s*(?:FCFA|XAF)/i,
      tel: /(?:de|from)\s+([\d\s]{9,15})/i,
      code: /(?:ID|Ref|TxnID)\s*[:\s]+([A-Z0-9]+)/i
    },
    {
      op: 'Orange Money',
      amt: /(?:Montant|Amount)\s*[:\s]+([\d\s]+)\s*(?:FCFA|XAF)/i,
      tel: /(?:Expediteur|Sender|De)\s*[:\s]+([\d\s]{9,15})/i,
      code: /(?:Ref|Reference|ID)\s*[:\s]+([A-Z0-9]+)/i
    },
    {
      op: 'Mobile Money',
      amt: /([\d]+)\s*(?:FCFA|XAF)/i,
      tel: /([6-9]\d{8})/,
      code: /([A-Z]{2}\d{8,})/
    }
  ];
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    const am = txt.match(p.amt);
    const te = txt.match(p.tel);
    const co = txt.match(p.code);
    if (am) {
      return {
        operator: p.op,
        amount:   parseInt((am[1] || '0').replace(/\s/g, '')),
        phone:    te ? te[1].replace(/\s/g, '') : '',
        txCode:   co ? co[1].toUpperCase() : ''
      };
    }
  }
  return null;
}

function depositMatchesSMS(dep, sms) {
  if (!sms || !dep) return false;
  if (dep.amount !== sms.amount) return false;
  const dt = (dep.userTel || '').replace(/\s/g, '').slice(-8);
  const st = (sms.phone  || '').replace(/\s/g, '').slice(-8);
  if (dt && st && dt !== st) return false;
  if (dep.txCode && sms.txCode && dep.txCode.toUpperCase() !== sms.txCode.toUpperCase()) return false;
  return true;
}

// ── Server ────────────────────────────────────────────────

const server = http.createServer(async function(req, res) {
  const parsed = url.parse(req.url, true);
  const route  = parsed.pathname;

  if (req.method === 'OPTIONS') { send(res, 200, {}); return; }

  // Fichiers statiques
  if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
    serveFile(res, path.join(__dirname, 'public', 'index.html')); return;
  }
  if (req.method === 'GET' && route === '/sms-listener') {
    serveFile(res, path.join(__dirname, 'sms-listener.html')); return;
  }

  const b = req.method === 'POST' ? await readBody(req) : {};

  // ── REGISTER
  if (route === '/api/register' && req.method === 'POST') {
    if (!b.name || !b.email || !b.phone || !b.pass) {
      send(res, 400, { error: 'Champs manquants' }); return;
    }
    const db = await dbRead();
    if (!db) { send(res, 500, { error: 'Erreur base de données' }); return; }
    if (!db.siteOpen) { send(res, 403, { error: 'Inscriptions fermées' }); return; }
    if (db.users.find(function(u) { return u.email === b.email.toLowerCase(); })) {
      send(res, 409, { error: 'Email déjà utilisé' }); return;
    }
    const refCode = 'INV-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    const nu = {
      id: Date.now().toString(), name: b.name, email: b.email.toLowerCase(),
      phone: b.phone, pass: b.pass, joinedAt: new Date().toISOString(),
      refBy: b.refBy || '', refCode: refCode,
      depositBalance: 0, withdrawBalance: 0, totalEarned: 0, activeVip: 0,
      activeInvestments: [], usedVipInvestments: [], transactions: [],
      pendingActivReturns: [], pendingReturns: [],
      spinTurns: 0, spinEarned: 0, refCount: 0
    };
    db.users.push(nu);
    if (b.refBy) {
      const par = db.users.find(function(u) { return u.refCode === b.refBy || u.email === b.refBy; });
      if (par) {
        par.spinTurns  = (par.spinTurns  || 0) + 1;
        par.refCount   = (par.refCount   || 0) + 1;
        par.transactions = par.transactions || [];
        par.transactions.unshift({ type: 'referral', label: 'Parrainage de ' + b.name + ' — +1 tour', amount: 0, status: 'done', date: new Date().toISOString() });
      }
    }
    await dbWrite(db);
    const safe = Object.assign({}, nu); delete safe.pass;
    send(res, 200, { ok: true, user: safe }); return;
  }

  // ── LOGIN
  if (route === '/api/login' && req.method === 'POST') {
    if (b.email === 'quentin' && b.pass === 'Quentin') {
      send(res, 200, { ok: true, user: { id: 'admin', name: 'Quentin', email: 'admin@investpro', isAdmin: true } }); return;
    }
    const db = await dbRead();
    if (!db) { send(res, 500, { error: 'Erreur base de données' }); return; }
    if (!db.siteOpen) { send(res, 403, { error: 'Site fermé' }); return; }
    const u = db.users.find(function(x) { return x.email === b.email.toLowerCase() && x.pass === b.pass; });
    if (!u) { send(res, 401, { error: 'Identifiants incorrects' }); return; }
    const safe = Object.assign({}, u); delete safe.pass;
    send(res, 200, { ok: true, user: safe }); return;
  }

  // ── SAVE USER
  if (route === '/api/user/save' && req.method === 'POST') {
    await dbUpdate(function(db) {
      const idx = db.users.findIndex(function(u) { return u.email === b.email; });
      if (idx >= 0) { const pass = db.users[idx].pass; db.users[idx] = Object.assign(db.users[idx], b, { pass: pass }); }
      return db;
    });
    send(res, 200, { ok: true }); return;
  }

  // ── GET USER
  if (route === '/api/user' && req.method === 'GET') {
    const email = parsed.query.email;
    const db = await dbRead();
    if (!db) { send(res, 500, { error: 'Erreur base de données' }); return; }
    const u = db.users.find(function(x) { return x.email === email; });
    if (!u) { send(res, 404, { error: 'Introuvable' }); return; }
    const safe = Object.assign({}, u); delete safe.pass;
    send(res, 200, safe); return;
  }

  // ── DEPOSIT
  if (route === '/api/deposit' && req.method === 'POST') {
    const dep = {
      id: Date.now().toString(), userEmail: b.userEmail, userName: b.userName,
      userTel: b.userTel, amount: b.amount, operator: b.operator,
      txCode: b.txCode || '', smsText: b.smsText || '',
      date: new Date().toISOString(), status: 'pending'
    };
    await dbUpdate(function(db) {
      db.deposits = db.deposits || []; db.deposits.push(dep);
      db.notifications = db.notifications || [];
      db.notifications.unshift(Object.assign({ type: 'deposit', read: false }, dep));
      return db;
    });
    send(res, 200, { ok: true, id: dep.id }); return;
  }

  // ── WITHDRAW
  if (route === '/api/withdraw' && req.method === 'POST') {
    const db = await dbRead();
    if (!db) { send(res, 500, { error: 'Erreur base de données' }); return; }
    const u = db.users.find(function(x) { return x.email === b.userEmail; });
    if (!u || (u.withdrawBalance || 0) < b.amount) {
      send(res, 400, { error: 'Solde retrait insuffisant' }); return;
    }
    const wid = Date.now().toString();
    const wd  = {
      id: wid, userEmail: b.userEmail, userName: b.userName, userTel: b.userTel,
      amount: b.amount, frais: b.frais, netAmount: b.netAmount,
      operator: b.operator, date: new Date().toISOString(), status: 'pending'
    };
    await dbUpdate(function(db) {
      db.withdrawals = db.withdrawals || []; db.withdrawals.push(wd);
      db.notifications = db.notifications || [];
      db.notifications.unshift(Object.assign({ type: 'withdraw', read: false }, wd));
      const usr = db.users.find(function(x) { return x.email === b.userEmail; });
      if (usr) {
        usr.transactions = usr.transactions || [];
        usr.transactions.unshift({ type: 'withdraw', label: 'Retrait ' + b.operator, amount: -b.amount, status: 'pending', wid: wid, date: new Date().toISOString() });
      }
      return db;
    });
    send(res, 200, { ok: true, id: wid }); return;
  }

  // ── ADMIN DATA
  if (route === '/api/admin/data' && req.method === 'GET') {
    const db = await dbRead();
    if (!db) { send(res, 500, { error: 'Erreur base de données' }); return; }
    const users = db.users.map(function(u) { const s = Object.assign({}, u); delete s.pass; return s; });
    send(res, 200, { users: users, deposits: db.deposits || [], withdrawals: db.withdrawals || [], notifications: db.notifications || [], siteOpen: db.siteOpen }); return;
  }

  // ── ADMIN APPROVE DEPOSIT
  if (route === '/api/admin/deposit/approve' && req.method === 'POST') {
    await dbUpdate(function(db) {
      const dep = db.deposits.find(function(d) { return d.id === b.id; });
      if (!dep) return db;
      dep.status = 'approved';
      const u = db.users.find(function(x) { return x.email === dep.userEmail; });
      if (u) {
        u.depositBalance = (u.depositBalance || 0) + dep.amount;
        u.transactions = u.transactions || [];
        u.transactions.unshift({ type: 'deposit', label: 'Dépôt approuvé ' + dep.operator, amount: dep.amount, status: 'done', date: new Date().toISOString() });
      }
      return db;
    });
    send(res, 200, { ok: true }); return;
  }

  // ── ADMIN REJECT DEPOSIT
  if (route === '/api/admin/deposit/reject' && req.method === 'POST') {
    await dbUpdate(function(db) {
      const dep = db.deposits.find(function(d) { return d.id === b.id; });
      if (!dep) return db;
      dep.status = 'rejected';
      const u = db.users.find(function(x) { return x.email === dep.userEmail; });
      if (u) {
        u.transactions = u.transactions || [];
        u.transactions.unshift({ type: 'deposit', label: 'Dépôt rejeté', amount: dep.amount, status: 'rejected', date: new Date().toISOString() });
      }
      return db;
    });
    send(res, 200, { ok: true }); return;
  }

  // ── ADMIN APPROVE WITHDRAW
  if (route === '/api/admin/withdraw/approve' && req.method === 'POST') {
    await dbUpdate(function(db) {
      const wd = db.withdrawals.find(function(w) { return w.id === b.id; });
      if (!wd) return db;
      wd.status = 'approved';
      const u = db.users.find(function(x) { return x.email === wd.userEmail; });
      if (u) {
        u.withdrawBalance = Math.max(0, (u.withdrawBalance || 0) - wd.amount);
        u.transactions = (u.transactions || []).map(function(t) {
          return t.wid === b.id ? Object.assign({}, t, { status: 'done' }) : t;
        });
      }
      return db;
    });
    send(res, 200, { ok: true }); return;
  }

  // ── ADMIN REJECT WITHDRAW
  if (route === '/api/admin/withdraw/reject' && req.method === 'POST') {
    await dbUpdate(function(db) {
      const wd = db.withdrawals.find(function(w) { return w.id === b.id; });
      if (!wd) return db;
      wd.status = 'rejected';
      const u = db.users.find(function(x) { return x.email === wd.userEmail; });
      if (u) {
        u.transactions = (u.transactions || []).map(function(t) {
          return t.wid === b.id ? Object.assign({}, t, { status: 'rejected' }) : t;
        });
      }
      return db;
    });
    send(res, 200, { ok: true }); return;
  }

  // ── ADMIN APPROVE INVEST RETURN
  if (route === '/api/admin/invest/approve' && req.method === 'POST') {
    await dbUpdate(function(db) {
      const u = db.users.find(function(x) { return x.email === b.userEmail; });
      if (!u) return db;
      u.withdrawBalance = (u.withdrawBalance || 0) + b.total;
      u.totalEarned     = (u.totalEarned     || 0) + b.total;
      u.pendingReturns  = (u.pendingReturns  || []).filter(function(r) { return r.vipName !== b.vipName; });
      u.transactions    = u.transactions || [];
      u.transactions.unshift({ type: 'invest_complete', label: 'Retour ' + b.vipName + ' approuvé', amount: b.total, status: 'done', date: new Date().toISOString() });
      // Commissions 7/5/3%
      const rates = [0.07, 0.05, 0.03];
      let curEmail = b.userEmail;
      for (let lvl = 0; lvl < 3; lvl++) {
        const cur = db.users.find(function(x) { return x.email === curEmail; });
        if (!cur || !cur.refBy) break;
        const par = db.users.find(function(x) { return x.refCode === cur.refBy || x.email === cur.refBy; });
        if (!par) break;
        const comm = Math.floor(b.total * rates[lvl]);
        par.withdrawBalance = (par.withdrawBalance || 0) + comm;
        par.totalEarned     = (par.totalEarned     || 0) + comm;
        par.transactions    = par.transactions || [];
        par.transactions.unshift({ type: 'commission', label: 'Commission niv.' + (lvl + 1) + ' (' + Math.round(rates[lvl] * 100) + '%) — ' + u.name, amount: comm, status: 'done', date: new Date().toISOString() });
        curEmail = par.email;
      }
      db.notifications = (db.notifications || []).map(function(n) {
        return (n.type === 'invest_return' && n.userEmail === b.userEmail && n.status === 'pending')
          ? Object.assign({}, n, { status: 'approved', read: true }) : n;
      });
      return db;
    });
    send(res, 200, { ok: true }); return;
  }

  // ── ADMIN SMS VERIFY
  if (route === '/api/admin/sms-verify' && req.method === 'POST') {
    if (b.adminKey !== ADMIN_KEY) { send(res, 403, { error: 'Clé admin invalide' }); return; }
    const sms = parseSMS(b.smsText || '');
    if (!sms) { send(res, 200, { ok: false, message: 'SMS non reconnu' }); return; }
    const db = await dbRead();
    if (!db) { send(res, 500, { error: 'Erreur base de données' }); return; }
    const match = (db.deposits || []).filter(function(d) { return d.status === 'pending'; }).find(function(d) { return depositMatchesSMS(d, sms); });
    if (!match) { send(res, 200, { ok: false, message: 'Aucun dépôt correspondant', parsed: sms }); return; }
    await dbUpdate(function(db) {
      const dep = db.deposits.find(function(x) { return x.id === match.id; });
      if (dep) dep.status = 'auto-approved';
      const u = db.users.find(function(x) { return x.email === match.userEmail; });
      if (u) {
        u.depositBalance = (u.depositBalance || 0) + match.amount;
        u.transactions   = u.transactions || [];
        u.transactions.unshift({ type: 'deposit', label: 'Dépôt auto-approuvé ' + match.operator, amount: match.amount, status: 'done', date: new Date().toISOString() });
      }
      return db;
    });
    send(res, 200, { ok: true, approved: match }); return;
  }

  // ── ADMIN DELETE USER
  if (route === '/api/admin/user/delete' && req.method === 'POST') {
    await dbUpdate(function(db) {
      db.users         = db.users.filter(function(u) { return u.email !== b.email; });
      db.deposits      = (db.deposits      || []).filter(function(d) { return d.userEmail !== b.email; });
      db.withdrawals   = (db.withdrawals   || []).filter(function(w) { return w.userEmail !== b.email; });
      db.notifications = (db.notifications || []).filter(function(n) { return n.userEmail !== b.email; });
      return db;
    });
    send(res, 200, { ok: true }); return;
  }

  // ── ADMIN TOGGLE SITE
  if (route === '/api/admin/site' && req.method === 'POST') {
    await dbUpdate(function(db) { db.siteOpen = b.open; return db; });
    send(res, 200, { ok: true }); return;
  }

  // ── ADMIN NOTIFS READ
  if (route === '/api/admin/notifs/read' && req.method === 'POST') {
    await dbUpdate(function(db) { (db.notifications || []).forEach(function(n) { n.read = true; }); return db; });
    send(res, 200, { ok: true }); return;
  }

  send(res, 404, { error: 'Route introuvable' });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('InvestPro server running on port ' + PORT);
});
