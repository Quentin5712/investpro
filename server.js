const http  = require('http');
const https = require('https');
const fs    = require('fs');
const url   = require('url');
const fetch = require('node-fetch');
const express = require('express');
const app = express();
app.use(express.json())
const path  = require('path');

const PORT      = process.env.PORT      || 3000;
const BIN_ID    = process.env.BIN_ID    || '6a4cdd5cf5f4af5e296bb50b';
const API_KEY   = process.env.API_KEY   || '$2a$10$WiRdDM1vwwyaoA.yf/.XkuA/2173q1VIdQ56RJyfD4vGgp8U5tu.O';
const ADMIN_KEY = process.env.ADMIN_KEY || 'investpro_admin_secret_2024';
const DB_URL    = 'https://api.jsonbin.io/v3/b/';

// ── SMS PATTERNS MTN/Orange Cameroun ──
// Ces patterns détectent les SMS de confirmation de réception d'argent
const SMS_PATTERNS = [
  // MTN Mobile Money Cameroun
  {
    operator: 'MTN MoMo',
    // "Vous avez recu 5000 FCFA de 655123456. ID:CI2024XXXXXX"
    amount:  /(?:recu|reçu|received)\s+([\d\s]+)\s*(?:FCFA|XAF|F CFA)/i,
    phone:   /(?:de|from)\s+(\d{9,12})/i,
    txCode:  /(?:ID|Ref|Reference|TxnID)[:\s]+([A-Z0-9]+)/i
  },
  // Orange Money Cameroun
  {
    operator: 'Orange Money',
    // "Transfert recu. Montant: 5000 FCFA. Expediteur: 699123456. Ref: OM2024XXXXX"
    amount:  /(?:Montant|Amount)[:\s]+([\d\s]+)\s*(?:FCFA|XAF|F CFA)/i,
    phone:   /(?:Expediteur|Sender|De)[:\s]+(\d{9,12})/i,
    txCode:  /(?:Ref|Reference|ID)[:\s]+([A-Z0-9]+)/i
  }
];

// ── Analyser un SMS et extraire montant/numéro/code ──
function parseSMS(smsText){
  for(var p of SMS_PATTERNS){
    var amtMatch  = smsText.match(p.amount);
    var telMatch  = smsText.match(p.phone);
    var codeMatch = smsText.match(p.txCode);
    if(amtMatch){
      return {
        operator: p.operator,
        amount:   parseInt(amtMatch[1].replace(/\s/g,'')),
        phone:    telMatch  ? telMatch[1].replace(/\s/g,'')  : '',
        txCode:   codeMatch ? codeMatch[1].toUpperCase()     : ''
      };
    }
  }
  return null;
}

// ── Vérifier si un dépôt correspond à un SMS reçu ──
function depositMatchesSMS(dep, sms){
  // 1. Montant identique
  if(dep.amount !== sms.amount) return false;
  // 2. Numéro de téléphone correspond (les derniers 8 chiffres)
  var depTel = (dep.userTel||'').replace(/\s/g,'').slice(-8);
  var smsTel = (sms.phone||'').replace(/\s/g,'').slice(-8);
  if(depTel && smsTel && depTel !== smsTel) return false;
  // 3. Code SMS correspond (si fourni par l'utilisateur)
  if(dep.txCode && sms.txCode && dep.txCode.toUpperCase() !== sms.txCode.toUpperCase()) return false;
  return true;
}

// ── JSONBin helpers ──
function dbRead(){
  return new Promise((resolve)=>{
    const req = https.request(
      DB_URL+BIN_ID+'/latest',
      {method:'GET',headers:{'X-Master-Key':API_KEY,'X-Bin-Meta':'false'}},
      (res)=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve(null);} }); }
    );
    req.on('error',()=>resolve(null)); req.end();
  });
}
function dbWrite(data){
  return new Promise((resolve)=>{
    const body=JSON.stringify(data);
    const req=https.request(
      DB_URL+BIN_ID,
      {method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':API_KEY,'Content-Length':Buffer.byteLength(body)}},
      (res)=>{ res.resume(); res.on('end',()=>resolve(res.statusCode===200)); }
    );
    req.on('error',()=>resolve(false)); req.write(body); req.end();
  });
}
async function dbUpdate(fn){
  const db=await dbRead(); if(!db) return false;
  return await dbWrite(fn(JSON.parse(JSON.stringify(db))));
}

// ── Helpers HTTP ──
function send(res,code,data){
  const body=JSON.stringify(data);
  res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
  res.end(body);
}
function readBody(req){
  return new Promise((resolve)=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve({});} }); });
}
function serveFile(res,filePath){
  const ext=path.extname(filePath);
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
  fs.readFile(filePath,(err,data)=>{ if(err){res.writeHead(404);res.end('Not found');return;} res.writeHead(200,{'Content-Type':mime[ext]||'text/plain'}); res.end(data); });
}

// ── SERVER ──
http.createServer(async(req,res)=>{
  const parsed=url.parse(req.url,true);
  const route=parsed.pathname;
  if(req.method==='OPTIONS'){send(res,200,{});return;}

  // Fichiers statiques
  if(req.method==='GET'&&(route==='/'||route==='/index.html')){
    serveFile(res,path.join(__dirname,'public','index.html')); return;
  }
  if(req.method==='GET'&&route==='/sms-listener'){
    serveFile(res,path.join(__dirname,'sms-listener.html')); return;
  }

  const b = req.method==='POST' ? await readBody(req) : {};

  // ════════════════════════════════════════════
  // REGISTER
  if(route==='/api/register'&&req.method==='POST'){
    if(!b.name||!b.email||!b.phone||!b.pass) return send(res,400,{error:'Champs manquants'});
    const db=await dbRead(); if(!db) return send(res,500,{error:'Erreur BDD'});
    if(!db.siteOpen) return send(res,403,{error:'Inscriptions fermées'});
    if(db.users.find(u=>u.email===b.email.toLowerCase())) return send(res,409,{error:'Email déjà utilisé'});
    const refCode='INV-'+Math.random().toString(36).substr(2,6).toUpperCase();
    const nu={id:Date.now().toString(),name:b.name,email:b.email.toLowerCase(),phone:b.phone,pass:b.pass,
      joinedAt:new Date().toISOString(),refBy:b.refBy||'',refCode,
      depositBalance:0,withdrawBalance:0,totalEarned:0,activeVip:0,
      activeInvestments:[],transactions:[],pendingActivReturns:[],pendingReturns:[],
      spinTurns:0,spinEarned:0,refCount:0};
    db.users.push(nu);
    if(b.refBy){
      const par=db.users.find(u=>u.refCode===b.refBy||u.email===b.refBy);
      if(par){par.spinTurns=(par.spinTurns||0)+1;par.refCount=(par.refCount||0)+1;
        par.transactions=par.transactions||[];
        par.transactions.unshift({type:'referral',label:'Parrainage de '+b.name+' — +1 tour',amount:0,status:'done',date:new Date().toISOString()});}
    }
    await dbWrite(db);
    const {pass,...safe}=nu; send(res,200,{ok:true,user:safe}); return;
  }

  // LOGIN
  if(route==='/api/login'&&req.method==='POST'){
    if(b.email==='quentin'&&b.pass==='Quentin')
      return send(res,200,{ok:true,user:{id:'admin',name:'Quentin',email:'admin@investpro',isAdmin:true}});
    const db=await dbRead(); if(!db) return send(res,500,{error:'Erreur BDD'});
    if(!db.siteOpen) return send(res,403,{error:'Site fermé'});
    const u=db.users.find(x=>x.email===b.email.toLowerCase()&&x.pass===b.pass);
    if(!u) return send(res,401,{error:'Identifiants incorrects'});
    const {pass,...safe}=u; send(res,200,{ok:true,user:safe}); return;
  }

  // SAVE USER
  if(route==='/api/user/save'&&req.method==='POST'){
    await dbUpdate(db=>{
      const idx=db.users.findIndex(u=>u.email===b.email);
      if(idx>=0){const pass=db.users[idx].pass;db.users[idx]=Object.assign(db.users[idx],b,{pass});}
      return db;
    });
    send(res,200,{ok:true}); return;
  }

  // GET USER (pour sync)
  if(route==='/api/user'&&req.method==='GET'){
    const email=parsed.query.email;
    const db=await dbRead(); if(!db) return send(res,500,{error:'Erreur BDD'});
    const u=db.users.find(x=>x.email===email);
    if(!u) return send(res,404,{error:'Utilisateur introuvable'});
    const {pass,...safe}=u; send(res,200,safe); return;
  }

  // DEPOSIT REQUEST
  if(route==='/api/deposit'&&req.method==='POST'){
    const dep={id:Date.now().toString(),userEmail:b.userEmail,userName:b.userName,
      userTel:b.userTel,amount:b.amount,operator:b.operator,txCode:b.txCode||'',
      date:new Date().toISOString(),status:'pending'};
    await dbUpdate(db=>{
      db.deposits=db.deposits||[]; db.deposits.push(dep);
      db.notifications=db.notifications||[];
      db.notifications.unshift({type:'deposit',...dep,read:false});
      return db;
    });
    send(res,200,{ok:true,id:dep.id}); return;
  }

  // WITHDRAW REQUEST
  if(route==='/api/withdraw'&&req.method==='POST'){
    const db=await dbRead(); if(!db) return send(res,500,{error:'Erreur BDD'});
    const u=db.users.find(x=>x.email===b.userEmail);
    if(!u||(u.withdrawBalance||0)<b.amount) return send(res,400,{error:'Solde retrait insuffisant'});
    const wid=Date.now().toString();
    const wd={id:wid,userEmail:b.userEmail,userName:b.userName,userTel:b.userTel,
      amount:b.amount,operator:b.operator,date:new Date().toISOString(),status:'pending'};
    await dbUpdate(db=>{
      db.withdrawals=db.withdrawals||[]; db.withdrawals.push(wd);
      db.notifications=db.notifications||[];
      db.notifications.unshift({type:'withdraw',...wd,read:false});
      const usr=db.users.find(x=>x.email===b.userEmail);
      if(usr){usr.transactions=usr.transactions||[];
        usr.transactions.unshift({type:'withdraw',label:'Retrait '+b.operator,amount:-b.amount,status:'pending',wid,date:new Date().toISOString()});}
      return db;
    });
    send(res,200,{ok:true,id:wid}); return;
  }

  // ════════════════════════════════════════════
  // VÉRIFICATION AUTOMATIQUE SMS
  // L'admin envoie les SMS reçus depuis son téléphone
  // Le serveur les compare avec les dépôts en attente
  // ════════════════════════════════════════════
  if(route==='/api/admin/sms-verify'&&req.method==='POST'){
    if(b.adminKey!==ADMIN_KEY) return send(res,403,{error:'Clé admin invalide'});
    // b.smsText = texte du SMS reçu sur le téléphone admin
    const sms=parseSMS(b.smsText||'');
    if(!sms) return send(res,200,{ok:false,message:'SMS non reconnu comme paiement MoMo'});
    const db=await dbRead(); if(!db) return send(res,500,{error:'Erreur BDD'});
    const pending=db.deposits.filter(d=>d.status==='pending');
    const match=pending.find(d=>depositMatchesSMS(d,sms));
    if(!match) return send(res,200,{ok:false,message:'Aucun dépôt en attente ne correspond à ce SMS',parsed:sms});
    // Approuver automatiquement
    await dbUpdate(db=>{
      const dep=db.deposits.find(d=>d.id===match.id);
      if(dep) dep.status='auto-approved';
      const u=db.users.find(x=>x.email===match.userEmail);
      if(u){
        u.depositBalance=(u.depositBalance||0)+match.amount;
        u.transactions=u.transactions||[];
        u.transactions.unshift({type:'deposit',label:'Dépôt auto-approuvé '+match.operator+' (SMS vérifié)',amount:match.amount,status:'done',date:new Date().toISOString()});
      }
      db.notifications=(db.notifications||[]).map(n=>
        n.id===match.id?{...n,status:'auto-approved',read:true}:n
      );
      return db;
    });
    send(res,200,{ok:true,approved:match,message:'Dépôt de '+match.amount+' FCFA approuvé automatiquement pour '+match.userName});
    return;
  }

  // CHECK SMS automatique (depuis le listener page)
  // Admin envoie plusieurs SMS d'un coup pour vérification en lot
  if(route==='/api/admin/sms-check'&&req.method==='POST'){
    if(b.adminKey!==ADMIN_KEY) return send(res,403,{error:'Clé admin invalide'});
    const db=await dbRead(); if(!db) return send(res,500,{error:'Erreur BDD'});
    const pending=db.deposits.filter(d=>d.status==='pending');
    if(!pending.length) return send(res,200,{ok:true,checked:0,approved:[]});
    // b.smsList = tableau de textes SMS reçus sur le téléphone admin
    const smsList=(b.smsList||[]).map(parseSMS).filter(Boolean);
    const approved=[];
    for(const dep of pending){
      const matchingSms=smsList.find(sms=>depositMatchesSMS(dep,sms));
      if(matchingSms){
        await dbUpdate(db=>{
          const d=db.deposits.find(x=>x.id===dep.id);
          if(d) d.status='auto-approved';
          const u=db.users.find(x=>x.email===dep.userEmail);
          if(u){
            u.depositBalance=(u.depositBalance||0)+dep.amount;
            u.transactions=u.transactions||[];
            u.transactions.unshift({type:'deposit',label:'Dépôt auto-approuvé '+dep.operator,amount:dep.amount,status:'done',date:new Date().toISOString()});
          }
          return db;
        });
        approved.push({userName:dep.userName,amount:dep.amount,operator:dep.operator});
      }
    }
    send(res,200,{ok:true,checked:pending.length,approved}); return;
  }

  // ADMIN: ALL DATA
  if(route==='/api/admin/data'&&req.method==='GET'){
    const db=await dbRead(); if(!db) return send(res,500,{error:'Erreur BDD'});
    const users=db.users.map(({pass,...u})=>u);
    send(res,200,{users,deposits:db.deposits||[],withdrawals:db.withdrawals||[],notifications:db.notifications||[],siteOpen:db.siteOpen}); return;
  }

  // ADMIN: APPROVE DEPOSIT (manuel)
  if(route==='/api/admin/deposit/approve'&&req.method==='POST'){
    await dbUpdate(db=>{
      const dep=db.deposits.find(d=>d.id===b.id); if(!dep) return db;
      dep.status='approved';
      const u=db.users.find(x=>x.email===dep.userEmail);
      if(u){u.depositBalance=(u.depositBalance||0)+dep.amount;u.transactions=u.transactions||[];
        u.transactions.unshift({type:'deposit',label:'Dépôt approuvé '+dep.operator,amount:dep.amount,status:'done',date:new Date().toISOString()});}
      return db;
    });
    send(res,200,{ok:true}); return;
  }

  // ADMIN: REJECT DEPOSIT
  if(route==='/api/admin/deposit/reject'&&req.method==='POST'){
    await dbUpdate(db=>{
      const dep=db.deposits.find(d=>d.id===b.id); if(!dep) return db;
      dep.status='rejected';
      const u=db.users.find(x=>x.email===dep.userEmail);
      if(u){u.transactions=u.transactions||[];
        u.transactions.unshift({type:'deposit',label:'Dépôt rejeté',amount:dep.amount,status:'rejected',date:new Date().toISOString()});}
      return db;
    });
    send(res,200,{ok:true}); return;
  }

  // ADMIN: APPROVE WITHDRAW
  if(route==='/api/admin/withdraw/approve'&&req.method==='POST'){
    await dbUpdate(db=>{
      const wd=db.withdrawals.find(w=>w.id===b.id); if(!wd) return db;
      wd.status='approved';
      const u=db.users.find(x=>x.email===wd.userEmail);
      if(u){u.withdrawBalance=Math.max(0,(u.withdrawBalance||0)-wd.amount);
        u.transactions=(u.transactions||[]).map(t=>t.wid===b.id?{...t,status:'done'}:t);}
      return db;
    });
    send(res,200,{ok:true}); return;
  }

  // ADMIN: REJECT WITHDRAW
  if(route==='/api/admin/withdraw/reject'&&req.method==='POST'){
    await dbUpdate(db=>{
      const wd=db.withdrawals.find(w=>w.id===b.id); if(!wd) return db;
      wd.status='rejected';
      const u=db.users.find(x=>x.email===wd.userEmail);
      if(u){u.transactions=(u.transactions||[]).map(t=>t.wid===b.id?{...t,status:'rejected',label:t.label+' (rejeté)'}:t);}
      return db;
    });
    send(res,200,{ok:true}); return;
  }

  // ADMIN: APPROVE INVEST RETURN
  if(route==='/api/admin/invest/approve'&&req.method==='POST'){
    await dbUpdate(db=>{
      const u=db.users.find(x=>x.email===b.userEmail); if(!u) return db;
      u.withdrawBalance=(u.withdrawBalance||0)+b.total;
      u.totalEarned=(u.totalEarned||0)+b.total;
      u.pendingReturns=(u.pendingReturns||[]).filter(r=>r.vipName!==b.vipName);
      u.transactions=u.transactions||[];
      u.transactions.unshift({type:'invest_complete',label:'Retour '+b.vipName+' approuvé',amount:b.total,status:'done',date:new Date().toISOString()});
      const rates=[0.07,0.05,0.03];
      let curEmail=b.userEmail;
      for(let lvl=0;lvl<3;lvl++){
        const cur=db.users.find(x=>x.email===curEmail); if(!cur||!cur.refBy) break;
        const par=db.users.find(x=>x.refCode===cur.refBy||x.email===cur.refBy); if(!par) break;
        const comm=Math.floor(b.total*rates[lvl]);
        par.withdrawBalance=(par.withdrawBalance||0)+comm;
        par.totalEarned=(par.totalEarned||0)+comm;
        par.transactions=par.transactions||[];
        par.transactions.unshift({type:'commission',label:'Commission niv.'+(lvl+1)+' ('+Math.round(rates[lvl]*100)+'%) — '+u.name,amount:comm,status:'done',date:new Date().toISOString()});
        curEmail=par.email;
      }
      db.notifications=(db.notifications||[]).map(n=>
        n.type==='invest_return'&&n.userEmail===b.userEmail&&n.status==='pending'?{...n,status:'approved',read:true}:n
      );
      return db;
    });
    send(res,200,{ok:true}); return;
  }

  // ADMIN: DELETE USER
  if(route==='/api/admin/user/delete'&&req.method==='POST'){
    await dbUpdate(db=>{
      db.users=db.users.filter(u=>u.email!==b.email);
      db.deposits=(db.deposits||[]).filter(d=>d.userEmail!==b.email);
      db.withdrawals=(db.withdrawals||[]).filter(w=>w.userEmail!==b.email);
      db.notifications=(db.notifications||[]).filter(n=>n.userEmail!==b.email);
      return db;
    });
    send(res,200,{ok:true}); return;
  }
// Pas besoin de app.listen, on utilise déjà server.listen
  // ROUTES JSONBIN
app.post('/sms', async (req, res) => {
  try {
    const getRes = await fetch(DB_URL + BIN_ID + '/latest', { headers: { 'X-Master-Key': ADMIN_KEY } });
    const data = await getRes.json();
    let smsArray = data.record || [];
    smsArray.push(req.body);
    await fetch(DB_URL + BIN_ID, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Master-Key': ADMIN_KEY }, body: JSON.stringify(smsArray) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/data', async (req, res) => {
  try {
    const getRes = await fetch(DB_URL + BIN_ID + '/latest', { headers: { 'X-Master-Key': ADMIN_KEY } });
    const data = await getRes.json();
    res.json(data.record || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

  // ADMIN: TOGGLE SITE
  if(route==='/api/admin/site'&&req.method==='POST'){
    await dbUpdate(db=>{db.siteOpen=b.open;return db;});
    send(res,200,{ok:true}); return;
  }

  // ADMIN: MARK NOTIFS READ
  if(route==='/api/admin/notifs/read'&&req.method==='POST'){
    await dbUpdate(db=>{(db.notifications||[]).forEach(n=>n.read=true);return db;});
    send(res,200,{ok:true}); return;
  }

  send(res,404,{error:'Route introuvable'});

}).listen(PORT,'0.0.0.0',()=>{
  console.log('✅ InvestPro server running on port '+PORT);
  console.log('📱 SMS Listener: http://localhost:'+PORT+'/sms-listener');
});
