const express = require('express');
const app = express();
app.use(express.json());

console.log("=== API DEMARRE ===");
console.log("PORT:", process.env.PORT);
console.log("API_KEY:", process.env.API_KEY ? "OK" : "MANQUANT");
console.log("BIN_ID:", process.env.BIN_ID ? "OK" : "MANQUANT");

app.get('/', (req, res) => {
  res.json({ status: "API en ligne" });
});

app.get('/data', async (req, res) => {
  res.json([]); 
});

app.post('/sms', async (req, res) => {
  console.log("SMS reçu:", req.body);
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("RUNNING ON", PORT);
});

process.on('uncaughtException', err => console.error("CRASH:", err));
process.on('unhandledRejection', err => console.error("PROMISE CRASH:", err));
