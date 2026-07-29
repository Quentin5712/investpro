const express = require('express');
const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY;
const BIN_ID = process.env.BIN_ID;

// FONCTION POUR LIRE JSONBIN
async function getData() {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
    headers: { 'X-Master-Key': API_KEY }
  });
  const data = await res.json();
  return data.record || [];
}

// FONCTION POUR ECRIRE DANS JSONBIN
async function saveData(data) {
  await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
    method: 'PUT',
    headers: { 
      'Content-Type': 'application/json',
      'X-Master-Key': API_KEY 
    },
    body: JSON.stringify(data)
  });
}

// ROUTES
app.get('/', (req, res) => {
  res.json({ status: "API en ligne" });
});

app.get('/data', async (req, res) => {
  try {
    const data = await getData();
    res.json(data);
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/sms', async (req, res) => {
  try {
    const sms = req.body;
    const data = await getData();
    data.push(sms);
    await saveData(data);
    res.json({ status: "ok", total: data.length });
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("RUNNING ON", PORT);
});
