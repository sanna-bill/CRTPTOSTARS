import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import cron from 'node-cron';
import admin from 'firebase-admin';

dotenv.config();

// Initialize Firebase Admin
// Note: In this environment, we check for potential service account config
if (admin.apps.length === 0) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
  } catch (e) {
    console.warn("Firebase Admin fallback check: applicationDefault failed, attempting simplified init");
    admin.initializeApp();
  }
}
const db = admin.firestore();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to calculate MA
const calculateMA = (data: number[], period: number) => {
  if (data.length < period) return null;
  const sum = data.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
};

// Helper to calculate WMA (Linear Weighted Moving Average)
const calculateWMA = (data: number[], period: number) => {
  if (data.length < period) return null;
  let sum = 0;
  let weightSum = 0;
  const slice = data.slice(-period);
  for (let i = 0; i < period; i++) {
    const weight = i + 1;
    sum += slice[i] * weight;
    weightSum += weight;
  }
  return sum / weightSum;
};

// Deduplication map: chatId -> lastAlertId
const lastAlerts = new Map<string, string>();

// Monitoring Logic
async function checkIntervalSignal(interval: string) {
  try {
    // 1. Fetch candles from Binance
    const response = await axios.get('https://api.binance.com/api/v3/klines', {
      params: {
        symbol: 'BTCUSDT',
        interval: interval,
        limit: 150
      }
    });

    const candles = response.data;
    if (!candles || candles.length < 100) return;

    const closes = candles.map((c: any) => parseFloat(c[4]));
    const lastCandle = candles[candles.length - 2]; // Use previous closed candle for stability
    const lastClose = parseFloat(lastCandle[4]);
    const candleOpenTime = lastCandle[0];

    // Calculate Indicators
    const ma20 = calculateMA(closes.slice(0, -1), 20);
    const ma39 = calculateMA(closes.slice(0, -1), 39);
    const wma100 = calculateWMA(closes.slice(0, -1), 100);

    if (ma20 !== null && ma39 !== null) {
      const isSell = ma20 > ma39 && lastClose > ma39 && lastClose < ma20;
      const isBuy = ma20 < ma39 && lastClose > ma20 && lastClose < ma39;

      if (isSell || isBuy) {
        const signalType = isBuy ? 'BUY' : 'SELL';
        const message = isBuy ? "지금 사야해 !!!!!!" : "지금 팔아야해 !!! (참고용)";
        const wmaInfo = wma100 ? `\n(WMA 100: $${wma100.toFixed(2)})` : "";
        
        // 2. Fetch all Chat IDs from Firestore
        const settingsSnapshot = await db.collection('userSettings').get();
        
        const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
        if (!botToken) {
          console.error('[Monitor] Missing TELEGRAM_BOT_TOKEN');
          return;
        }

        for (const settingsDoc of settingsSnapshot.docs) {
          const data = settingsDoc.data();
          const chatId = data.telegramChatId;
          const trimmedChatId = chatId?.trim();
          if (!trimmedChatId) continue;

          // Deduplication: check if we already sent this specific signal for this candle to this user
          const alertId = `${trimmedChatId}_${interval}_${candleOpenTime}_${signalType}`;
          if (lastAlerts.get(trimmedChatId) === alertId) continue;

          try {
            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              chat_id: trimmedChatId,
              text: `[CryptoStar ${interval} Alert]\n${message}\n\nPrice: $${lastClose.toLocaleString()}${wmaInfo}\nTime: ${new Date().toLocaleString()}`,
              parse_mode: 'HTML'
            });
            lastAlerts.set(trimmedChatId, alertId);
            console.log(`[Monitor] Sent ${interval} ${signalType} alert to ${trimmedChatId}`);
          } catch (err: any) {
            console.error(`[Monitor] Failed to send to ${trimmedChatId}:`, err.message);
          }
        }
      }
    }
  } catch (error: any) {
    console.error(`[Monitor Error - ${interval}]`, error.message);
  }
}

async function checkSignalsAndNotify() {
  const now = new Date();
  
  // Always check 15m
  await checkIntervalSignal('15m');
  
  // Temporary: check 1m if before 13:00 KST (04:00 UTC)
  const hourUTC = now.getUTCHours();
  if (hourUTC < 4) {
    await checkIntervalSignal('1m');
  }
}

// Check every 10 seconds for real-time responsiveness
setInterval(() => {
  checkSignalsAndNotify();
}, 10000);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Route for sending push notifications
  app.post('/api/notify', (req, res) => {
    const { message, token } = req.body;
    console.log(`[Push Notification] To: ${token}, Message: ${message}`);
    res.json({ success: true });
  });

  // API Route for sending signal alerts via Telegram Bot
  app.post('/api/telegram-signal', async (req, res) => {
    const { chatId, message, timestamp, authKey } = req.body;
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const serverAuthKey = process.env.VITE_APP_ACCESS_PASSWORD || "1234";

    console.log(`[Telegram Alert] Received request for chatId: ${chatId}`);

    // 1. Basic Auth Verification
    if (authKey !== serverAuthKey) {
      console.warn('[Telegram Alert] Unauthorized access attempt');
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    if (!botToken) {
      console.warn('[Telegram Alert] Missing TELEGRAM_BOT_TOKEN');
      return res.status(500).json({ success: false, error: "Server configuration error (No Bot Token)" });
    }

    try {
      const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      console.log(`[Telegram Alert] Sending to Telegram URL: https://api.telegram.org/bot${botToken.substring(0, 5)}.../sendMessage`);
      
      const response = await axios.post(telegramUrl, {
        chat_id: chatId,
        text: `[CryptoStar Alert]\n${message}\n\nTime: ${timestamp}`,
        parse_mode: 'HTML'
      });

      if (response.data.ok || response.status === 200) {
        res.json({ success: true });
      } else {
        console.error('[Telegram API Error]', response.data);
        res.status(400).json({ success: false, error: response.data.description });
      }
    } catch (error: any) {
      console.error('[Telegram Axios Error]', error.response?.data || error.message);
      res.status(500).json({ success: false, error: "Failed to communicate with Telegram API" });
    }
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
