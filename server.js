const express = require('express');
const path    = require('path');
const https   = require('https');
const app     = express();
app.use(express.json());

const API_KEY   = process.env.API_KEY   || '$2a$10$WiRdDM1vwwyaoA.yf/.XkuA/2173q1VIdQ56RJyfD4vGgp8U5tu.O';
const BIN_ID    = process.env.BIN_ID    || '6a4cdd5cf5f4af5e296bb50b';
const ADMIN_KEY = process.env.ADMIN_KEY || 'investpro_admin_secret_2024';

// 1. SERVIR TON SITE
app.use(express.static(path.join(__dirname, 'public')));

// 2. RATE LIMITING SIMPLE (sans dépendance externe)
const rateLimitMap = {};
function rateLimit(ip, maxReq, windowMs) {
  const now = Date.now();
  if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
  rateLimitMap[ip] = rateLimitMap[ip].filter(function(t) { return now - t < windowMs; });
  if (rateLimitMap[ip].length >= maxReq) return false;
  rateLimitMap[ip].push(now);
  return true;
}
setInterval(function() {
  const now = Date.now();
  Object.keys(rateLimitMap).forEach(function(ip) {
    rateLimitMap[ip] = (rateLimitMap[ip]||[]).filter(function(t){return now-t<300000;});
    if (!rateLimitMap[ip].length) delete rateLimitMap[ip];
  });
}, 300000);

// 3. FONCTIONS JSONBIN
function dbRead() {
  return new Promise(function(resolve) {
    const opts = {
      hostname: 'api.jsonbin.io',
      path: '/v3/b/' + BIN_ID + '/latest',
      method: 'GET',
      headers: { 'X-Master-Key': API_KEY, 'X-Bin-Meta': 'false' }
    };
    const req = https.request(opts, function(res) {
      let d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { const j = JSON.parse(d); resolve(j && j.record !== undefined ? j.record : j); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', function(e) { console.error('dbRead:', e.message); resolve(null); });
    req.end();
  });
}

function dbWrite(data) {
  return new Promise(function(resolve) {
    const body = JSON.stringify(data);
    const opts = {
      hostname: 'api.jsonbin.io',
      path: '/v3/b/' + BIN_ID,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': API_KEY, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, function(res) {
      let d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve(res.statusCode === 200); });
    });
    req.on('error', function(e) { console.error('dbWrite:', e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function dbUpdate(fn) {
  const db = await dbRead();
  if (!db) return false;
  return dbWrite(fn(JSON.parse(JSON.stringify(db))));
}

// SMS Parser
function parseSMS(txt) {
  const P = [
    { op:'MTN MoMo',     amt:/(?:recu|reçu|received)\s+([\d\s]+)\s*(?:FCFA|XAF)/i,   tel:/(?:de|from)\s+([\d\s]{9,15})/i,                  code:/(?:ID|Ref|TxnID)\s*[:\s]+([A-Z0-9]+)/i },
    { op:'Orange Money', amt:/(?:Montant|Amount)\s*[:\s]+([\d\s]+)\s*(?:FCFA|XAF)/i, tel:/(?:Expediteur|Sender|De)\s*[:\s]+([\d\s]{9,15})/i, code:/(?:Ref|Reference|ID)\s*[:\s]+([A-Z0-9]+)/i },
    { op:'Mobile Money', amt:/([\d]+)\s*(?:FCFA|XAF)/i,                               tel:/([6-9]\d{8})/,                                     code:/([A-Z]{2}\d{8,})/ }
  ];
  for (let i = 0; i < P.length; i++) {
    const p = P[i], am = txt.match(p.amt), te = txt.match(p.tel), co = txt.match(p.code);
    if (am) return { operator: p.op, amount: parseInt((am[1]||'0').replace(/\s/g,'')), phone: te ? te[1].replace(/\s/g,'') : '', txCode: co ? co[1].toUpperCase() : '' };
  }
  return null;
}

function smsMatchDep(dep, sms) {
  if (!sms || !dep) return false;
  if (dep.amount !== sms.amount) return false;
  const dt = (dep.userTel||'').replace(/\s/g,'').slice(-8);
  const st = (sms.phone||'').replace(/\s/g,'').slice(-8);
  if (dt && st && dt !== st) return false;
  if (dep.txCode && sms.txCode && dep.txCode.toUpperCase() !== sms.txCode.toUpperCase()) return false;
  return true;
}

// 4. ROUTE TEST
app.get('/api/ping', function(req, res) {
  res.json({ ok: true, msg: 'InvestPro API OK' });
});

// REGISTER
app.post('/api/register', async function(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(ip, 5, 3600000)) { res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 1 heure.' }); return; }
  const b = req.body;
  if (!b.name || !b.email || !b.phone || !b.pass) { res.status(400).json({ error: 'Champs manquants' }); return; }
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(b.email)) { res.status(400).json({ error: 'Email invalide' }); return; }
  if (b.pass.length < 6) { res.status(400).json({ error: 'Mot de passe trop court' }); return; }
  const db = await dbRead();
  if (!db) { res.status(500).json({ error: 'Erreur base de données' }); return; }
  if (!db.siteOpen) { res.status(403).json({ error: 'Inscriptions fermées' }); return; }
  if ((db.users||[]).find(function(u) { return u.email === b.email.toLowerCase(); })) { res.status(409).json({ error: 'Email déjà utilisé' }); return; }
  const refCode = 'INV-' + Math.random().toString(36).substr(2,6).toUpperCase();
  const nu = { id: Date.now().toString(), name: b.name, email: b.email.toLowerCase(), phone: b.phone, pass: b.pass, joinedAt: new Date().toISOString(), refBy: b.refBy||'', refCode: refCode, depositBalance: 0, withdrawBalance: 0, totalEarned: 0, activeVip: 0, activeInvestments: [], usedVipInvestments: [], transactions: [], pendingActivReturns: [], pendingReturns: [], spinTurns: 0, spinEarned: 0, refCount: 0 };
  db.users = db.users || [];
  db.users.push(nu);
  if (b.refBy) {
    const par = db.users.find(function(u) { return u.refCode === b.refBy || u.email === b.refBy; });
    if (par && par.id !== nu.id) {
      par.spinTurns = (par.spinTurns||0) + 1;
      par.refCount  = (par.refCount||0)  + 1;
      par.transactions = par.transactions || [];
      par.transactions.unshift({ type: 'referral', label: 'Parrainage de ' + b.name + ' — +1 tour', amount: 0, status: 'done', date: new Date().toISOString() });
      db.referrals = db.referrals || [];
      db.referrals.push({ sponsorId: par.id, sponsorEmail: par.email, referredUserId: nu.id, referredUserEmail: nu.email, referredUserName: b.name, status: 'completed', spinCredited: true, createdAt: new Date().toISOString() });
    }
  }
  await dbWrite(db);
  const safe = Object.assign({}, nu); delete safe.pass;
  res.json({ ok: true, user: safe });
});

// LOGIN
app.post('/api/login', async function(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(ip, 10, 900000)) { res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' }); return; }
  const b = req.body;
  if (b.email === 'quentin' && b.pass === 'Quentin') { res.json({ ok: true, user: { id: 'admin', name: 'Quentin', email: 'admin@investpro', isAdmin: true } }); return; }
  const db = await dbRead();
  if (!db) { res.status(500).json({ error: 'Erreur base de données' }); return; }
  if (!db.siteOpen) { res.status(403).json({ error: 'Site fermé' }); return; }
  const u = (db.users||[]).find(function(x) { return x.email === b.email.toLowerCase() && x.pass === b.pass; });
  if (!u) { res.status(401).json({ error: 'Identifiants incorrects' }); return; }
  const safe = Object.assign({}, u); delete safe.pass;
  res.json({ ok: true, user: safe });
});

// SAVE USER
app.post('/api/user/save', async function(req, res) {
  const b = req.body;
  await dbUpdate(function(db) {
    const idx = (db.users||[]).findIndex(function(u) { return u.email === b.email; });
    if (idx >= 0) { const p = db.users[idx].pass; db.users[idx] = Object.assign(db.users[idx], b, { pass: p }); }
    return db;
  });
  res.json({ ok: true });
});

// GET USER
app.get('/api/user', async function(req, res) {
  const db = await dbRead();
  if (!db) { res.status(500).json({ error: 'Erreur BDD' }); return; }
  const u = (db.users||[]).find(function(x) { return x.email === req.query.email; });
  if (!u) { res.status(404).json({ error: 'Introuvable' }); return; }
  const safe = Object.assign({}, u); delete safe.pass;
  res.json(safe);
});

// DEPOSIT
app.post('/api/deposit', async function(req, res) {
  const b = req.body;
  const dep = { id: Date.now().toString(), userEmail: b.userEmail, userName: b.userName, userTel: b.userTel, amount: b.amount, operator: b.operator, txCode: b.txCode||'', smsText: b.smsText||'', date: new Date().toISOString(), status: 'pending' };
  await dbUpdate(function(db) {
    db.deposits = db.deposits||[]; db.deposits.push(dep);
    db.notifications = db.notifications||[];
    db.notifications.unshift(Object.assign({ type: 'deposit', read: false }, dep));
    return db;
  });
  res.json({ ok: true, id: dep.id });
});

// WITHDRAW
app.post('/api/withdraw', async function(req, res) {
  const b = req.body;
  const db = await dbRead();
  if (!db) { res.status(500).json({ error: 'Erreur BDD' }); return; }
  const u = (db.users||[]).find(function(x) { return x.email === b.userEmail; });
  if (!u || (u.withdrawBalance||0) < b.amount) { res.status(400).json({ error: 'Solde insuffisant' }); return; }
  const wid = Date.now().toString();
  const wd  = { id: wid, userEmail: b.userEmail, userName: b.userName, userTel: b.userTel, amount: b.amount, frais: b.frais, netAmount: b.netAmount, operator: b.operator, date: new Date().toISOString(), status: 'pending' };
  await dbUpdate(function(db) {
    db.withdrawals = db.withdrawals||[]; db.withdrawals.push(wd);
    db.notifications = db.notifications||[];
    db.notifications.unshift(Object.assign({ type: 'withdraw', read: false }, wd));
    const usr = (db.users||[]).find(function(x) { return x.email === b.userEmail; });
    if (usr) { usr.transactions = usr.transactions||[]; usr.transactions.unshift({ type: 'withdraw', label: 'Retrait ' + b.operator, amount: -b.amount, status: 'pending', wid: wid, date: new Date().toISOString() }); }
    return db;
  });
  res.json({ ok: true, id: wid });
});

// ADMIN DATA
app.get('/api/admin/data', async function(req, res) {
  const db = await dbRead();
  if (!db) { res.status(500).json({ error: 'Erreur BDD' }); return; }
  res.json({ users: (db.users||[]).map(function(u){const s=Object.assign({},u);delete s.pass;return s;}), deposits: db.deposits||[], withdrawals: db.withdrawals||[], notifications: db.notifications||[], siteOpen: db.siteOpen });
});

// ADMIN APPROVE DEPOSIT
app.post('/api/admin/deposit/approve', async function(req, res) {
  const b = req.body;
  await dbUpdate(function(db) {
    const dep=(db.deposits||[]).find(function(d){return d.id===b.id;}); if(!dep) return db;
    dep.status='approved';
    const u=(db.users||[]).find(function(x){return x.email===dep.userEmail;});
    if(u){u.depositBalance=(u.depositBalance||0)+dep.amount;u.transactions=u.transactions||[];u.transactions.unshift({type:'deposit',label:'Dépôt approuvé '+dep.operator,amount:dep.amount,status:'done',date:new Date().toISOString()});}
    return db;
  });
  res.json({ ok: true });
});

// ADMIN REJECT DEPOSIT
app.post('/api/admin/deposit/reject', async function(req, res) {
  const b = req.body;
  await dbUpdate(function(db) {
    const dep=(db.deposits||[]).find(function(d){return d.id===b.id;}); if(!dep) return db;
    dep.status='rejected';
    const u=(db.users||[]).find(function(x){return x.email===dep.userEmail;});
    if(u){u.transactions=u.transactions||[];u.transactions.unshift({type:'deposit',label:'Dépôt rejeté',amount:dep.amount,status:'rejected',date:new Date().toISOString()});}
    return db;
  });
  res.json({ ok: true });
});

// ADMIN APPROVE WITHDRAW
app.post('/api/admin/withdraw/approve', async function(req, res) {
  const b = req.body;
  await dbUpdate(function(db) {
    const wd=(db.withdrawals||[]).find(function(w){return w.id===b.id;}); if(!wd) return db;
    wd.status='approved';
    const u=(db.users||[]).find(function(x){return x.email===wd.userEmail;});
    if(u){u.withdrawBalance=Math.max(0,(u.withdrawBalance||0)-wd.amount);u.transactions=(u.transactions||[]).map(function(t){return t.wid===b.id?Object.assign({},t,{status:'done'}):t;});}
    return db;
  });
  res.json({ ok: true });
});

// ADMIN REJECT WITHDRAW
app.post('/api/admin/withdraw/reject', async function(req, res) {
  const b = req.body;
  await dbUpdate(function(db) {
    const wd=(db.withdrawals||[]).find(function(w){return w.id===b.id;}); if(!wd) return db;
    wd.status='rejected';
    const u=(db.users||[]).find(function(x){return x.email===wd.userEmail;});
    if(u){u.transactions=(u.transactions||[]).map(function(t){return t.wid===b.id?Object.assign({},t,{status:'rejected'}):t;});}
    return db;
  });
  res.json({ ok: true });
});

// ADMIN APPROVE INVEST RETURN
app.post('/api/admin/invest/approve', async function(req, res) {
  const b = req.body;
  await dbUpdate(function(db) {
    const u=(db.users||[]).find(function(x){return x.email===b.userEmail;}); if(!u) return db;
    u.withdrawBalance=(u.withdrawBalance||0)+b.total; u.totalEarned=(u.totalEarned||0)+b.total;
    u.pendingReturns=(u.pendingReturns||[]).filter(function(r){return r.vipName!==b.vipName;});
    u.transactions=u.transactions||[];
    u.transactions.unshift({type:'invest_complete',label:'Retour '+b.vipName+' approuvé',amount:b.total,status:'done',date:new Date().toISOString()});
    const rates=[0.07,0.05,0.03]; let cur=b.userEmail;
    for(let lvl=0;lvl<3;lvl++){
      const c=(db.users||[]).find(function(x){return x.email===cur;}); if(!c||!c.refBy) break;
      const p=(db.users||[]).find(function(x){return x.refCode===c.refBy||x.email===c.refBy;}); if(!p) break;
      const comm=Math.floor(b.total*rates[lvl]);
      p.withdrawBalance=(p.withdrawBalance||0)+comm; p.totalEarned=(p.totalEarned||0)+comm;
      p.transactions=p.transactions||[];
      p.transactions.unshift({type:'commission',label:'Commission niv.'+(lvl+1)+' ('+Math.round(rates[lvl]*100)+'%) — '+u.name,amount:comm,status:'done',date:new Date().toISOString()});
      cur=p.email;
    }
    db.notifications=(db.notifications||[]).map(function(n){return(n.type==='invest_return'&&n.userEmail===b.userEmail&&n.status==='pending')?Object.assign({},n,{status:'approved',read:true}):n;});
    return db;
  });
  res.json({ ok: true });
});

// ADMIN SMS VERIFY
app.post('/api/admin/sms-verify', async function(req, res) {
  const b = req.body;
  if (b.adminKey !== ADMIN_KEY) { res.status(403).json({ error: 'Clé invalide' }); return; }
  const sms = parseSMS(b.smsText||'');
  if (!sms) { res.json({ ok: false, message: 'SMS non reconnu' }); return; }
  const db = await dbRead(); if (!db) { res.status(500).json({ error: 'Erreur BDD' }); return; }
  const match = (db.deposits||[]).filter(function(d){return d.status==='pending';}).find(function(d){return smsMatchDep(d,sms);});
  if (!match) { res.json({ ok: false, message: 'Aucun dépôt correspondant', parsed: sms }); return; }
  await dbUpdate(function(db) {
    const dep=(db.deposits||[]).find(function(x){return x.id===match.id;}); if(dep) dep.status='auto-approved';
    const u=(db.users||[]).find(function(x){return x.email===match.userEmail;});
    if(u){u.depositBalance=(u.depositBalance||0)+match.amount;u.transactions=u.transactions||[];u.transactions.unshift({type:'deposit',label:'Dépôt auto-approuvé '+match.operator,amount:match.amount,status:'done',date:new Date().toISOString()});}
    return db;
  });
  res.json({ ok: true, approved: match });
});

// ADMIN DELETE USER
app.post('/api/admin/user/delete', async function(req, res) {
  const b = req.body;
  await dbUpdate(function(db) {
    db.users         = (db.users||[]).filter(function(u){return u.email!==b.email;});
    db.deposits      = (db.deposits||[]).filter(function(d){return d.userEmail!==b.email;});
    db.withdrawals   = (db.withdrawals||[]).filter(function(w){return w.userEmail!==b.email;});
    db.notifications = (db.notifications||[]).filter(function(n){return n.userEmail!==b.email;});
    return db;
  });
  res.json({ ok: true });
});

// ADMIN TOGGLE SITE
app.post('/api/admin/site', async function(req, res) {
  const b = req.body;
  await dbUpdate(function(db){db.siteOpen=b.open;return db;});
  res.json({ ok: true });
});

// ADMIN NOTIFS READ
app.post('/api/admin/notifs/read', async function(req, res) {
  await dbUpdate(function(db){(db.notifications||[]).forEach(function(n){n.read=true;});return db;});
  res.json({ ok: true });
});

// SMS LISTENER PAGE
app.get('/sms-listener', function(req, res) {
  res.sendFile(path.join(__dirname, 'sms-listener.html'));
});

// 5. SI ON VA SUR / → AFFICHE INDEX.HTML
app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 6. LANCER LE SERVEUR
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log("RUNNING ON", PORT));
