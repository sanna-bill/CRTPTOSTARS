/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, ISeriesApi, SeriesMarker, Time, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts';
import { Bell, TrendingUp, AlertTriangle, Star, Activity, LogIn, LogOut, User as UserIcon, Lock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, onAuthStateChanged, User, doc, setDoc, serverTimestamp, collection, addDoc, query, orderBy, limit, onSnapshot, where, signInAnonymously } from './lib/firebase';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType | string, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType: operationType as OperationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Types ---
interface CandleData {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Signal {
  id: string;
  time: number;
  price: number;
  timestamp: string;
  type?: 'BUY' | 'SELL';
}

// --- Utils ---

export default function App() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<'Candlestick'>>(null);
  const ma20SeriesRef = useRef<ISeriesApi<'Line'>>(null);
  const ma39SeriesRef = useRef<ISeriesApi<'Line'>>(null);
  const wma100SeriesRef = useRef<ISeriesApi<'Line'>>(null);
  
  // Refs for calculator selection
  const isSelectingEntryRef = useRef(false);
  const isSelectingTargetRef = useRef(false);
  const entryPriceLineRef = useRef<any>(null);
  const targetPriceLineRef = useRef<any>(null);
  const snapshotUnsubscribeRef = useRef<(() => void) | null>(null);

  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [exchangeRate, setExchangeRate] = useState<number>(1400); // Default fallback
  const [ma20, setMa20] = useState<number | null>(null);
  const [ma39, setMa39] = useState<number | null>(null);
  const [wma100, setWma100] = useState<number | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [notifications, setNotifications] = useState<{ id: string; message: string }[]>([]);
  const [interval, setInterval] = useState<'1m' | '15m'>('15m');
  const [showHistory, setShowHistory] = useState(true);
  const [user, setUser] = useState<User | null>(null);

  // Profit Calculator State
  const [leverage, setLeverage] = useState<number>(10);
  const [investment, setInvestment] = useState<number>(100);
  const [calcEntryPrice, setCalcEntryPrice] = useState<number | null>(null);
  const [calcTargetPrice, setCalcTargetPrice] = useState<number | null>(null);
  const [isSelectingEntry, setIsSelectingEntry] = useState(false);
  const [isSelectingTarget, setIsSelectingTarget] = useState(false);
  
  const [loading, setLoading] = useState(true);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const [telegramChatId, setTelegramChatId] = useState<string>(localStorage.getItem('telegram_chat_id') || '');
  const [isAuthorized, setIsAuthorized] = useState<boolean>(localStorage.getItem('is_authorized') === 'true');
  const [passwordInput, setPasswordInput] = useState('');

  useEffect(() => {
    if (isAuthorized && auth.currentUser && telegramChatId) {
      // Save Chat ID to user's settings in Firestore for server-side alerts
      const userRef = doc(db, 'userSettings', auth.currentUser.uid);
      setDoc(userRef, {
        telegramChatId: telegramChatId.trim(),
        updatedAt: serverTimestamp(),
        userId: auth.currentUser.uid,
        email: auth.currentUser.email
      }, { merge: true }).catch(err => handleFirestoreError(err, 'WRITE', 'userSettings'));
    }
  }, [telegramChatId, isAuthorized]);

  useEffect(() => {
    isSelectingEntryRef.current = isSelectingEntry;
    isSelectingTargetRef.current = isSelectingTarget;
  }, [isSelectingEntry, isSelectingTarget]);

  // Fetch Exchange Rate
  useEffect(() => {
    const fetchRate = async () => {
      try {
        const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const data = await res.json();
        if (data && data.rates && data.rates.KRW) {
          setExchangeRate(data.rates.KRW);
        }
      } catch (err) {
        console.error("Failed to fetch exchange rate", err);
      }
    };
    fetchRate();
    const intervalId = window.setInterval(fetchRate, 3600000); // Every hour
    return () => window.clearInterval(intervalId);
  }, []);

  // Handle Price Line Updates
  useEffect(() => {
    const series = candlestickSeriesRef.current;
    if (!series) return;

    // Entry Line
    if (entryPriceLineRef.current) {
      series.removePriceLine(entryPriceLineRef.current);
      entryPriceLineRef.current = null;
    }
    if (calcEntryPrice !== null) {
      entryPriceLineRef.current = series.createPriceLine({
        price: calcEntryPrice,
        color: '#2962FF',
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: 'ENTRY',
      });
    }

    // Target Line
    if (targetPriceLineRef.current) {
      series.removePriceLine(targetPriceLineRef.current);
      targetPriceLineRef.current = null;
    }
    if (calcTargetPrice !== null) {
      targetPriceLineRef.current = series.createPriceLine({
        price: calcTargetPrice,
        color: calcTargetPrice > (calcEntryPrice || 0) ? '#0ECB81' : '#F6465D',
        lineWidth: 2,
        lineStyle: 1,
        axisLabelVisible: true,
        title: 'TARGET',
      });
    }
  }, [calcEntryPrice, calcTargetPrice]);

  useEffect(() => {
    if (typeof Notification !== 'undefined') {
      setNotificationPermission(Notification.permission);
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(err => console.error('SW registration failed', err));
    }
  }, []);

  const requestNotificationPermission = async () => {
    if (typeof Notification !== 'undefined') {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === 'granted') {
        addNotification("Notifications enabled! You will now receive signals even when the screen is locked.");
      }
    }
  };

  const testNotification = () => {
    if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') {
        new Notification('CryptoStar Alert Test', {
          body: 'This is a test alert. Notifications are working correctly!',
          icon: '/star-icon.png',
        });
        addNotification("Test alert sent to your browser.");
      } else {
        requestNotificationPermission();
      }
    } else {
      addNotification("Browser does not support notifications.");
    }
  };

  const calculateMA = (data: number[], period: number): (number | null)[] => {
    const ma: (number | null)[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        ma.push(null);
      } else {
        const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
        ma.push(sum / period);
      }
    }
    return ma;
  };

  const calculateEMA = (data: number[], period: number): (number | null)[] => {
    const ema: (number | null)[] = [];
    const k = 2 / (period + 1);
    let prevEma: number | null = null;
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        ema.push(null);
      } else if (i === period - 1) {
        const sum = data.slice(0, period).reduce((a, b) => a + b, 0);
        prevEma = sum / period;
        ema.push(prevEma);
      } else {
        prevEma = data[i] * k + prevEma! * (1 - k);
        ema.push(prevEma);
      }
    }
    return ema;
  };

  const calculateWMA = (data: number[], period: number): (number | null)[] => {
    const wma: (number | null)[] = [];
    const weightSum = (period * (period + 1)) / 2;

    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        wma.push(null);
      } else {
        let sum = 0;
        for (let j = 0; j < period; j++) {
          sum += data[i - period + 1 + j] * (j + 1);
        }
        wma.push(sum / weightSum);
      }
    }
    return wma;
  };

  const calculateMACD = (data: number[], fast: number = 12, slow: number = 26, signal: number = 9) => {
    const fastEMA = calculateEMA(data, fast);
    const slowEMA = calculateEMA(data, slow);
    
    const macdLine: (number | null)[] = [];
    for (let i = 0; i < data.length; i++) {
      if (fastEMA[i] !== null && slowEMA[i] !== null) {
        macdLine.push(fastEMA[i]! - slowEMA[i]!);
      } else {
        macdLine.push(null);
      }
    }

    const validMacdLine = macdLine.filter(x => x !== null) as number[];
    const signalLineRaw = calculateEMA(validMacdLine, signal);
    
    // Align signal line with original data length
    const signalLine: (number | null)[] = new Array(macdLine.length - validMacdLine.length).fill(null).concat(signalLineRaw);
    
    const histogram: (number | null)[] = macdLine.map((m, i) => {
      return (m !== null && signalLine[i] !== null) ? m - signalLine[i]! : null;
    });

    return { macdLine, signalLine, histogram };
  };

  const handleFirestoreError = (error: any, operation: string, path: string) => {
    const errInfo = {
      error: error?.message || String(error),
      authInfo: {
        userId: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        emailVerified: auth.currentUser?.emailVerified,
      },
      operation,
      path
    };
    console.error('Firestore Error:', JSON.stringify(errInfo));
    // addNotification("Firestore operation failed. Check console for details.");
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      // Clean up previous snapshot listener if it exists
      if (snapshotUnsubscribeRef.current) {
        snapshotUnsubscribeRef.current();
        snapshotUnsubscribeRef.current = null;
      }

      if (!currentUser) {
        try {
          await signInAnonymously(auth);
          // onAuthStateChanged will trigger again with the new user
          return;
        } catch (err) {
          console.warn("Anonymous auth failed (likely disabled in console). Using guest mode.");
          setLoading(false);
          setUser(null);
        }
      } else {
        setUser(currentUser);
        setLoading(false);
      }
      
      const effectiveUserId = currentUser?.uid || 'guest_user';
      
      try {
        const q = query(
          collection(db, 'signals'),
          where('userId', 'in', [effectiveUserId, 'guest_user']),
          orderBy('createdAt', 'desc'),
          limit(50)
        );
        
        snapshotUnsubscribeRef.current = onSnapshot(q, (snapshot) => {
          const historySignals: Signal[] = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
              id: doc.id,
              time: data.time,
              price: data.price,
              timestamp: data.timestamp,
              type: data.type
            };
          });
          if (historySignals.length > 0) {
            setSignals(historySignals);
          }
        }, (error) => {
          handleFirestoreError(error, 'LIST', 'signals');
        });
      } catch (error) {
        handleFirestoreError(error, 'FETCH', 'signals');
      }
    });

    return () => {
      unsubscribe();
      if (snapshotUnsubscribeRef.current) {
        snapshotUnsubscribeRef.current();
      }
    };
  }, []);

  const handleLogout = () => {
    auth.signOut();
    setIsAuthorized(false);
    localStorage.removeItem('is_authorized');
    localStorage.removeItem('app_password');
    addNotification("세션이 종료되었습니다 (터미널 잠금).");
  };

  const addNotification = (message: string) => {
    const id = Date.now().toString();
    setNotifications(prev => [...prev, { id, message }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 5000);

    if (notificationPermission === 'granted') {
      new Notification("CRYPTOSTAR ALERT", { body: message, icon: '/favicon.ico' });
    }
  };

  const sendTelegramAlert = (message: string) => {
    if (telegramChatId) {
      const chatId = telegramChatId.trim();
      const authKey = localStorage.getItem('app_password');
      if (!authKey) return;

      fetch('/api/telegram-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          chatId: chatId, 
          message,
          timestamp: new Date().toLocaleString(),
          authKey: authKey
        })
      })
      .then(async res => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Server error ${res.status}: ${text}`);
        }
        return res.json();
      })
      .catch(err => console.error("Telegram send trigger failed", err));
    }
  };

  const testTelegramAlert = () => {
    const chatId = telegramChatId.trim();
    if (!chatId) {
      addNotification("Telegram Chat ID를 입력해주세요.");
      return;
    }
    
    const authKey = localStorage.getItem('app_password');
    if (!authKey) {
      addNotification("인증 정보가 없습니다. 다시 로그인해 주세요.");
      return;
    }
    
    addNotification(`${chatId} (으)로 테스트 메시지를 전송합니다...`);
    
    // Save to Firestore so server-side can use it
    if (auth.currentUser) {
      const userRef = doc(db, 'userSettings', auth.currentUser.uid);
      setDoc(userRef, {
        telegramChatId: chatId,
        updatedAt: serverTimestamp(),
        userId: auth.currentUser.uid,
        email: auth.currentUser.email
      }, { merge: true }).catch(err => handleFirestoreError(err, 'WRITE', 'userSettings'));
    }

    fetch('/api/telegram-signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chatId: chatId, 
        message: "🚨 CryptoStar 터미널 테스트 알림: 텔레그램 연결이 성공적으로 설정되었습니다.",
        timestamp: new Date().toLocaleString(),
        authKey: authKey
      })
    })
    .then(async res => {
      const isJson = res.headers.get('content-type')?.includes('application/json');
      const data = isJson ? await res.json() : null;
      
      if (res.ok && data?.success) {
        addNotification("텔레그램 메시지 전송 성공! ✅");
      } else {
        const errMsg = data?.error || (await res.text()) || "메시지 전송 실패";
        throw new Error(`${errMsg} (${res.status})`);
      }
    })
    .catch(err => {
      console.error(err);
      addNotification(`텔레그램 전송 실패: ${err.message}`);
    });
  };

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0B0E11' },
        textColor: '#848E9C',
        fontSize: 12,
        fontFamily: 'Inter',
      },
      grid: {
        vertLines: { color: '#1E2329' },
        horzLines: { color: '#1E2329' },
      },
      width: chartContainerRef.current.clientWidth,
      height: window.innerWidth < 768 ? 650 : 700,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#2B3139',
      },
      rightPriceScale: {
        borderColor: '#2B3139',
      },
      handleScroll: true,
      handleScale: true,
    });

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#0ECB81',
      downColor: '#F6465D',
      borderVisible: false,
      wickUpColor: '#0ECB81',
      wickDownColor: '#F6465D',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: '#26a69a',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '', // Overlay
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    const ma20Series = chart.addSeries(LineSeries, {
      color: '#8b4513',
      lineWidth: 1,
      title: 'MA 20',
    });

    const ma39Series = chart.addSeries(LineSeries, {
      color: '#ef4444',
      lineWidth: 1,
      title: 'MA 39',
    });

    const wma100Series = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 1,
      title: 'WMA 100',
    });

    // MACD Setup
    const macdHistogramSeries = chart.addSeries(HistogramSeries, {
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: 'macd',
      title: 'MACD Histogram',
    });

    const macdLineSeries = chart.addSeries(LineSeries, {
      color: '#2962FF',
      lineWidth: 2,
      priceScaleId: 'macd',
      title: 'MACD',
    });

    const macdSignalSeries = chart.addSeries(LineSeries, {
      color: '#FF6D00',
      lineWidth: 2,
      priceScaleId: 'macd',
      title: 'Signal',
    });

    chart.priceScale('macd').applyOptions({
      scaleMargins: {
        top: 0.85,
        bottom: 0,
      },
    });

    const candlestickMarkers = createSeriesMarkers(candlestickSeries);
    chartRef.current = chart;
    (candlestickSeriesRef as any).current = candlestickSeries;
    (ma20SeriesRef as any).current = ma20Series;
    (ma39SeriesRef as any).current = ma39Series;
    (wma100SeriesRef as any).current = wma100Series;

    chart.subscribeClick((param) => {
      if (!param.point || !param.time || !candlestickSeriesRef.current) return;
      
      const price = candlestickSeries.coordinateToPrice(param.point.y);
      if (price === null) return;

      if (isSelectingEntryRef.current) {
        setCalcEntryPrice(price);
        setIsSelectingEntry(false);
      } else if (isSelectingTargetRef.current) {
        setCalcTargetPrice(price);
        setIsSelectingTarget(false);
      }
    });

    let isDisposed = false;

    const handleResize = () => {
      if (chartContainerRef.current && !isDisposed) {
        chart.applyOptions({ 
          width: chartContainerRef.current.clientWidth,
          height: window.innerWidth < 768 ? 650 : 700 
        });
      }
    };
    window.addEventListener('resize', handleResize);

    // Initial Data Fetch
    const fetchHistory = async () => {
      try {
        const fetchBatch = async (endTime?: number) => {
          const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=1000${endTime ? `&endTime=${endTime}` : ''}`;
          const res = await fetch(url);
          return await res.json();
        };

        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const targetStartTime = now - threeDaysMs;

        let allData: any[] = [];
        let currentEndTime: number | undefined = undefined;

        // Fetch enough to cover 3 days
        for (let i = 0; i < 5; i++) {
          const batch = await fetchBatch(currentEndTime);
          if (!batch || batch.length === 0) break;
          
          allData = [...batch, ...allData];
          if (batch[0][0] <= targetStartTime) break;
          currentEndTime = batch[0][0] - 1;
        }

        const data = allData.sort((a, b) => a[0] - b[0]);
        if (isDisposed) return;
        
        const formattedData: CandleData[] = data.map((d: any) => ({
          time: (d[0] / 1000) as Time,
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
          volume: parseFloat(d[5]),
        }));

        const closes = formattedData.map(d => d.close);
        const ma20s = calculateMA(closes, 20);
        const ma39s = calculateMA(closes, 39);
        const wma100s = calculateWMA(closes, 100);
        const { macdLine, signalLine, histogram } = calculateMACD(closes);

        const ma20Data: { time: Time; value: number }[] = [];
        const ma39Data: { time: Time; value: number }[] = [];
        const wma100Data: { time: Time; value: number }[] = [];
        const volumeData: { time: Time; value: number; color: string }[] = [];
        const macdLineData: { time: Time; value: number }[] = [];
        const macdSignalData: { time: Time; value: number }[] = [];
        const macdHistData: { time: Time; value: number; color: string }[] = [];
        const initialMarkers: SeriesMarker<Time>[] = [];

        for (let i = 0; i < formattedData.length; i++) {
          const m20 = ma20s[i];
          const m39 = ma39s[i];
          const w100 = wma100s[i];
          const ml = macdLine[i];
          const sl = signalLine[i];
          const h = histogram[i];
          const c = formattedData[i];

          if (m20 !== null) ma20Data.push({ time: c.time, value: m20 });
          if (m39 !== null) ma39Data.push({ time: c.time, value: m39 });
          if (w100 !== null) wma100Data.push({ time: c.time, value: w100 });
          if (ml !== null) macdLineData.push({ time: c.time, value: ml });
          if (sl !== null) macdSignalData.push({ time: c.time, value: sl });
          if (h !== null) macdHistData.push({ 
            time: c.time, 
            value: h, 
            color: h >= 0 ? '#26a69a66' : '#ef535066' 
          });
          
          volumeData.push({
            time: c.time,
            value: c.volume,
            color: c.close >= c.open ? '#0ECB8144' : '#F6465D44'
          });

          if (m20 !== null && m39 !== null) {
            if (m20 > m39 && c.close > m39 && c.close < m20) {
              initialMarkers.push({
                time: c.time,
                position: 'aboveBar',
                color: '#475569',
                shape: 'arrowDown',
                text: 'SELL (Ref)',
              });
            } else if (m20 < m39 && c.close > m20 && c.close < m39) {
              initialMarkers.push({
                time: c.time,
                position: 'belowBar',
                color: '#0ECB81',
                shape: 'arrowUp',
                text: 'BUY',
              });
            }
          }
        }

        candlestickSeries.setData(formattedData);
        volumeSeries.setData(volumeData);
        ma20Series.setData(ma20Data);
        ma39Series.setData(ma39Data);
        wma100Series.setData(wma100Data);
        macdLineSeries.setData(macdLineData);
        macdSignalSeries.setData(macdSignalData);
        macdHistogramSeries.setData(macdHistData);
        candlestickMarkers.setMarkers(initialMarkers);

        // WebSocket for live updates
        const ws = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${interval}`);
        
        let activeMarkers: SeriesMarker<Time>[] = [...initialMarkers];
        let historicalCloses = [...closes];

        ws.onmessage = (event) => {
          if (isDisposed) return;
          const message = JSON.parse(event.data);
          const k = message.k;
          const klineData = {
            time: (k.t / 1000) as Time,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
          };

          candlestickSeries.update(klineData);
          volumeSeries.update({
            time: klineData.time,
            value: klineData.volume,
            color: klineData.close >= klineData.open ? '#0ECB8144' : '#F6465D44'
          });
          setCurrentPrice(klineData.close);

          const currentCloses = k.x ? [...historicalCloses, klineData.close] : [...historicalCloses, klineData.close];
          if (k.x) historicalCloses.push(klineData.close);

          // Optimize: only calculate if we have enough data, and limit the window
          const calculationWindow = currentCloses.slice(-400); 
          const currentMA20Array = calculateMA(calculationWindow, 20);
          const currentMA39Array = calculateMA(calculationWindow, 39);
          const currentWMA100Array = calculateWMA(calculationWindow, 100);
          const { macdLine: curMacd, signalLine: curSignal, histogram: curHist } = calculateMACD(calculationWindow);

          const currentMA20 = currentMA20Array[currentMA20Array.length - 1];
          const currentMA39 = currentMA39Array[currentMA39Array.length - 1];
          const currentWMA100 = currentWMA100Array[currentWMA100Array.length - 1];
          const currentMacd = curMacd[curMacd.length - 1];
          const currentSignal = curSignal[curSignal.length - 1];
          const currentHist = curHist[curHist.length - 1];

          if (currentMA20 !== null) {
            ma20Series.update({ time: klineData.time, value: currentMA20 });
            setMa20(currentMA20);
          }
          if (currentMA39 !== null) {
            ma39Series.update({ time: klineData.time, value: currentMA39 });
            setMa39(currentMA39);
          }
          if (currentWMA100 !== null) {
            wma100Series.update({ time: klineData.time, value: currentWMA100 });
            setWma100(currentWMA100);
          }

          if (currentMacd !== null) macdLineSeries.update({ time: klineData.time, value: currentMacd });
          if (currentSignal !== null) macdSignalSeries.update({ time: klineData.time, value: currentSignal });
          if (currentHist !== null) macdHistogramSeries.update({ 
            time: klineData.time, 
            value: currentHist, 
            color: currentHist >= 0 ? '#26a69a66' : '#ef535066' 
          });

          if (currentMA20 !== null && currentMA39 !== null) {
            const isSell = currentMA20 > currentMA39 && klineData.close > currentMA39 && klineData.close < currentMA20;
            const isBuy = currentMA20 < currentMA39 && klineData.close > currentMA20 && klineData.close < currentMA39;
            
            if (k.x && (isSell || isBuy)) {
              const newMarker: SeriesMarker<Time> = {
                time: klineData.time,
                position: isSell ? 'aboveBar' : 'belowBar',
                color: isSell ? '#475569' : '#0ECB81',
                shape: isSell ? 'arrowDown' : 'arrowUp',
                text: isSell ? 'SELL (Ref)' : 'BUY',
              };
              activeMarkers.push(newMarker);
              candlestickMarkers.setMarkers(activeMarkers);
              
              const newSignal: Signal = {
                id: Math.random().toString(36).substring(2, 9),
                time: k.t,
                price: klineData.close,
                timestamp: new Date(k.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                type: isSell ? 'SELL' : 'BUY'
              };
              setSignals(prev => [newSignal, ...prev].slice(0, 50));
              
              if (interval === '15m') {
                const krwPrice = currentPrice ? (currentPrice * exchangeRate).toLocaleString() : "";
                const alarmMsg = isBuy ? `지금 사야해 !!!!!! (₩${krwPrice})` : `지금 팔아야해 !!! (참고용) (₩${krwPrice})`;
                addNotification(alarmMsg);
                sendTelegramAlert(alarmMsg);

                // Vibrate 5 times at closing point
                if ('vibrate' in navigator) {
                  navigator.vibrate([200, 100, 200, 100, 200, 100, 200, 100, 200]);
                }

                // Browser Push (Foreground)
                if (Notification.permission === 'granted') {
                  new Notification('CryptoStar Signal', {
                    body: `BTC/USDT at $${klineData.close.toLocaleString()} met strategy criteria on 15m chart.`,
                    icon: '/star-icon.png',
                  });
                }
              }

              // Persist signal to Firestore regardless of interval (history log)
              if (isAuthorized) {
                addDoc(collection(db, 'signals'), {
                  ...newSignal,
                  symbol: 'BTCUSDT',
                  interval: interval,
                  createdAt: serverTimestamp(),
                  userId: auth.currentUser?.uid || 'guest_user'
                }).catch(error => {
                  handleFirestoreError(error, 'CREATE', 'signals');
                });
              }
            }
          }
        };

        return () => ws.close();
      } catch (err) {
        console.error('Failed to fetch history', err);
      }
    };

    fetchHistory();

    return () => {
      isDisposed = true;
      chart.remove();
      window.removeEventListener('resize', handleResize);
    };
  }, [interval]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const correctPassword = import.meta.env.VITE_APP_ACCESS_PASSWORD || "1234";
    if (passwordInput === correctPassword) {
      setIsAuthorized(true);
      localStorage.setItem('is_authorized', 'true');
      localStorage.setItem('app_password', passwordInput); // Store for API authentication
    } else {
      addNotification("비밀번호가 틀렸습니다.");
    }
  };

  if (!isAuthorized) {
    return (
      <div className="fixed inset-0 bg-bg-main flex items-center justify-center z-[9999] p-4">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-bg-accent p-8 rounded-2xl border border-border-subtle w-full max-w-sm shadow-2xl"
        >
          <div className="flex flex-col items-center gap-4 mb-8">
            <div className="w-16 h-16 bg-binance-yellow/10 rounded-full flex items-center justify-center text-binance-yellow">
              <Lock size={32} />
            </div>
            <h1 className="text-xl font-black text-white uppercase tracking-tighter">CryptoStar Terminal</h1>
            <p className="text-gray-text text-xs text-center">인증된 사용자만 접근 가능합니다.</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <input 
              type="password"
              placeholder="Password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              className="w-full bg-bg-main border border-border-subtle rounded-xl px-4 py-3 text-white focus:outline-none focus:border-binance-yellow transition-all"
              autoFocus
            />
            <button 
              type="submit"
              className="w-full bg-binance-yellow hover:bg-yellow-500 text-bg-main font-black py-3 rounded-xl transition-all uppercase tracking-widest text-sm"
            >
              Enter System
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-bg-main text-[#EAECEF] flex flex-col font-sans overflow-hidden">
      <nav className="h-[64px] border-b border-border-subtle flex items-center justify-between px-4 md:px-6 bg-bg-secondary shrink-0">
          <div className="flex items-center gap-4 md:gap-8 overflow-hidden">
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-8 h-8 bg-binance-yellow rounded-full flex items-center justify-center shrink-0">
              <Star className="text-black fill-black" size={20} />
            </div>
            <span className="text-lg md:text-xl font-bold tracking-tight whitespace-nowrap">CRYPTO<span className="text-binance-yellow">STAR</span></span>
          </div>
          <div className="hidden md:flex items-center gap-6 text-sm font-medium border-l border-border-subtle pl-8">
            <div className="flex flex-col">
              <span className="text-gray-text text-xs uppercase font-bold tracking-wider">BTC / USDT</span>
              <div className="flex flex-col">
                <span className={`text-lg font-bold ${currentPrice ? 'text-binance-green' : 'text-gray-text'}`}>
                  {currentPrice ? currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '---'}
                </span>
                <div className="flex items-center gap-1.5 leading-none mt-0.5">
                  <span className="text-[11px] text-amber-500/90 font-mono font-bold">
                    ≈ ₩{(currentPrice ? currentPrice * exchangeRate : 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="text-[9px] text-gray-text/40 font-medium">
                    (1$ = ₩{exchangeRate.toFixed(1)})
                  </span>
                </div>
              </div>
            </div>
            {/* Legend for desktop only in nav */}
            <div className="flex items-center gap-4 text-xs font-bold text-gray-text">
              <div className="flex flex-col">
                <span className="underline decoration-[#8b4513] underline-offset-4 decoration-2">MA(20)</span>
                <span className="text-[#8b4513] font-mono">{ma20?.toFixed(1) || '---'}</span>
              </div>
              <div className="flex flex-col">
                <span className="underline decoration-[#ef4444] underline-offset-4 decoration-2">MA(39)</span>
                <span className="text-[#ef4444] font-mono">{ma39?.toFixed(1) || '---'}</span>
              </div>
              <div className="flex flex-col">
                <span className="underline decoration-[#f59e0b] underline-offset-4 decoration-2">WMA(100)</span>
                <span className="text-[#f59e0b] font-mono">{wma100?.toFixed(1) || '---'}</span>
              </div>
            </div>
          </div>
        </div>
          <div className="flex items-center gap-2 md:gap-4 shrink-0">
            <button 
              onClick={() => setShowHistory(!showHistory)}
              className={`p-2 rounded transition-colors ${showHistory ? 'text-binance-yellow' : 'text-gray-text hover:text-white'}`}
              title="Signal History"
            >
              <Activity size={18} />
            </button>
            <button 
              onClick={handleLogout}
              className="p-2 rounded text-gray-text hover:text-white transition-colors"
              title="터미널 잠금"
            >
              <LogOut size={18} />
            </button>
            <button 
              onClick={testNotification}
              className="p-2 rounded text-gray-text hover:text-white transition-colors flex items-center gap-2"
              title="알림 테스트"
            >
              <Activity size={18} />
              <span className="hidden lg:block text-[10px] font-black uppercase">알림 테스트</span>
            </button>
            <div className="flex items-center bg-bg-main border border-border-subtle rounded-lg px-2 py-1 gap-1 ml-4 overflow-hidden">
              <span className="text-[10px] font-black uppercase text-gray-text px-1">Telegram ID</span>
              <input 
                type="text" 
                placeholder="Chat ID (e.g. 1234567)"
                value={telegramChatId}
                onChange={(e) => {
                  setTelegramChatId(e.target.value);
                  localStorage.setItem('telegram_chat_id', e.target.value);
                }}
                className="bg-transparent border-none text-[10px] text-white focus:outline-none w-28 md:w-40 placeholder:text-gray-text/30"
              />
              <button 
                onClick={testTelegramAlert}
                className="bg-bg-accent hover:bg-white/10 text-white text-[9px] font-black px-2 py-1 rounded transition-colors border border-white/5"
              >
                TEST
              </button>
            </div>
          {notificationPermission !== 'granted' && (
            <button 
              onClick={requestNotificationPermission}
              className="p-2 rounded text-binance-yellow hover:bg-bg-accent transition-colors md:flex items-center gap-2"
              title="푸시 알림 활성화"
            >
              <Bell size={20} className="animate-swing" />
              <span className="hidden md:block text-[10px] font-black uppercase">알림 활성화</span>
            </button>
          )}
          <div className="flex bg-bg-accent rounded p-1">
            <button 
              onClick={() => setInterval('1m')}
              className={`px-3 py-1 text-xs font-bold rounded transition-all ${interval === '1m' ? 'bg-binance-yellow text-black' : 'text-gray-text'}`}
            >
              1m
            </button>
            <button 
              onClick={() => setInterval('15m')}
              className={`px-3 py-1 text-xs font-bold rounded transition-all ${interval === '15m' ? 'bg-binance-yellow text-black' : 'text-gray-text'}`}
            >
              15m
            </button>
          </div>
        </div>
      </nav>

      {/* Main Content Layout */}
      <main className="flex-1 flex overflow-hidden relative flex-col md:flex-row">
        {/* Sidebar: Alert Logs */}
        <aside className={`${showHistory ? 'w-full md:w-[320px] flex' : 'hidden'} bg-bg-secondary border-r border-border-subtle flex-col shrink-0 absolute inset-0 z-20 md:relative`}>
          <div className="p-4 border-b border-border-subtle flex justify-between items-center">
            <h3 className="text-[10px] uppercase tracking-[0.2em] text-gray-text font-black">
              Signal History
            </h3>
            <div className="flex gap-2">
              <button onClick={() => setShowHistory(false)} className="md:hidden text-gray-text hover:text-white">
                <AlertTriangle size={16} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 p-2 scrollbar-hide">
            {/* Leverage Calculator */}
            <div className="mb-4 p-3 bg-bg-main border border-border-subtle rounded-lg">
              <h4 className="text-[10px] font-black uppercase text-binance-yellow tracking-widest mb-3 flex items-center gap-2">
                <TrendingUp size={12} />
                Leverage Calculator
              </h4>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] text-gray-text font-bold uppercase tracking-tighter">Leverage (x)</label>
                    <input 
                      type="number" 
                      value={leverage} 
                      onChange={(e) => setLeverage(Number(e.target.value))}
                      className="bg-bg-accent border border-border-subtle rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-binance-yellow"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] text-gray-text font-bold uppercase tracking-tighter">Investment ($)</label>
                    <input 
                      type="number" 
                      value={investment} 
                      onChange={(e) => setInvestment(Number(e.target.value))}
                      className="bg-bg-accent border border-border-subtle rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-binance-yellow"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="text-gray-text uppercase font-bold">Entry Price</span>
                    <button 
                      onClick={() => { setIsSelectingEntry(true); setIsSelectingTarget(false); }}
                      className={`px-2 py-1 rounded text-[9px] font-bold uppercase transition-colors ${isSelectingEntry ? 'bg-binance-yellow text-bg-main' : 'bg-bg-accent text-white border border-border-subtle hover:bg-white/10'}`}
                    >
                      {isSelectingEntry ? 'Selecting...' : 'Select Chart'}
                    </button>
                  </div>
                  <div className="text-xs font-mono text-white bg-bg-accent/50 p-2 rounded border border-border-subtle/30 overflow-hidden text-ellipsis">
                    {calcEntryPrice ? calcEntryPrice.toLocaleString() : 'Click Select and then Click Chart'}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="text-gray-text uppercase font-bold">Target Price</span>
                    <button 
                      onClick={() => { setIsSelectingTarget(true); setIsSelectingEntry(false); }}
                      className={`px-2 py-1 rounded text-[9px] font-bold uppercase transition-colors ${isSelectingTarget ? 'bg-binance-yellow text-bg-main' : 'bg-bg-accent text-white border border-border-subtle hover:bg-white/10'}`}
                    >
                      {isSelectingTarget ? 'Selecting...' : 'Select Chart'}
                    </button>
                  </div>
                  <div className="text-xs font-mono text-white bg-bg-accent/50 p-2 rounded border border-border-subtle/30 overflow-hidden text-ellipsis">
                    {calcTargetPrice ? calcTargetPrice.toLocaleString() : 'Click Select and then Click Chart'}
                  </div>
                </div>

                {calcEntryPrice && calcTargetPrice && (
                  <div className="mt-4 p-3 bg-bg-accent border border-binance-yellow/20 rounded-lg space-y-2">
                    <div className="flex justify-between text-[10px] text-gray-text font-bold uppercase">
                      <span>ROI</span>
                      <span className={(calcTargetPrice > calcEntryPrice ? 'text-binance-green' : 'text-[#ef4444]')}>
                        {(((calcTargetPrice - calcEntryPrice) / calcEntryPrice) * 100 * leverage).toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex justify-between text-xs text-white font-black uppercase">
                      <span>Profit</span>
                      <span className={(calcTargetPrice > calcEntryPrice ? 'text-binance-green' : 'text-[#ef4444]')}>
                        ${((investment * (calcTargetPrice - calcEntryPrice) / calcEntryPrice) * leverage).toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}
                
                {(calcEntryPrice || calcTargetPrice) && (
                   <button 
                    onClick={() => { setCalcEntryPrice(null); setCalcTargetPrice(null); }}
                    className="w-full py-2 text-[9px] font-black uppercase text-gray-text hover:text-white transition-colors"
                   >
                     Clear Drawing
                   </button>
                )}
              </div>
            </div>

            <div className="border-t border-border-subtle mx-2 my-4"></div>

            {signals.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8 opacity-20">
                <Activity size={32} className="mb-2" />
                <p className="text-xs uppercase tracking-widest text-white">No signals found</p>
                <p className="text-[10px] mt-2">Wait for live triggers</p>
              </div>
            ) : (
              signals.map((signal) => (
                <motion.div
                  key={signal.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={`p-3 bg-bg-accent rounded border-l-4 transition-colors cursor-default ${signal.type === 'SELL' ? 'border-slate-600 opacity-50 grayscale' : 'border-[#0ECB81]'}`}
                >
                  <div className="flex justify-between items-center mb-1">
                    <span className={`${signal.type === 'SELL' ? 'text-slate-400' : 'text-[#0ECB81]'} text-[10px] font-black uppercase tracking-wider`}>
                      {signal.type === 'SELL' ? 'SELL (REFERENCE)' : 'BUY'}
                    </span>
                    <span className="text-gray-text text-[10px] tabular-nums">{signal.timestamp}</span>
                  </div>
                  <div className="text-sm font-mono font-bold tracking-tight text-white">Price: {signal.price.toLocaleString()}</div>
                  <div className="text-[9px] text-gray-text uppercase font-bold mt-1">MA Strategy Met</div>
                </motion.div>
              ))
            )}
          </div>
        </aside>

        {/* Main Chart Area */}
        <section className="flex-1 bg-bg-main p-3 md:p-6 flex flex-col overflow-y-auto">
          {/* Mobile Only Quick Stats */}
          <div className="flex md:hidden justify-between items-center mb-4 bg-bg-secondary p-3 rounded border border-border-subtle overflow-x-auto gap-4 scrollbar-hide">
             <div className="flex flex-col shrink-0">
                <span className="text-[10px] text-gray-text font-black uppercase tracking-widest">Price</span>
                <span className="text-white font-mono font-bold text-sm tracking-tight">{currentPrice?.toLocaleString() || '---'}</span>
             </div>
             <div className="flex flex-col shrink-0 border-l border-border-subtle pl-4">
                <span className="text-[10px] text-[#8b4513] font-black uppercase tracking-widest">MA20</span>
                <span className="text-white font-mono font-bold text-sm tracking-tight">{ma20?.toFixed(1) || '---'}</span>
             </div>
             <div className="flex flex-col shrink-0 border-l border-border-subtle pl-4">
                <span className="text-[10px] text-[#ef4444] font-black uppercase tracking-widest">MA39</span>
                <span className="text-white font-mono font-bold text-sm tracking-tight">{ma39?.toFixed(1) || '---'}</span>
             </div>
             <div className="flex flex-col shrink-0 border-l border-border-subtle pl-4">
                <span className="text-[10px] text-[#f59e0b] font-black uppercase tracking-widest">WMA100</span>
                <span className="text-white font-mono font-bold text-sm tracking-tight">{wma100?.toFixed(1) || '---'}</span>
             </div>
             <div className="flex flex-col shrink-0 border-l border-border-subtle pl-4 pr-2">
                <span className="text-[10px] text-binance-yellow font-black uppercase tracking-widest">Status</span>
                <span className="text-binance-green font-bold text-xs">ONLINE</span>
             </div>
          </div>

          <div className="hidden md:flex justify-between items-center mb-6 shrink-0">
            <div className="flex gap-4 items-center">
              <span className="text-lg font-bold flex items-center gap-2">
                BTC / USDT <span className="text-gray-text text-sm font-medium bg-bg-accent px-2 py-0.5 rounded border border-border-subtle">{interval}</span>
              </span>
              <div className="flex gap-3">
                <div className="flex items-center gap-2 text-[11px] font-bold">
                  <div className="w-3 h-0.5 bg-[#8b4513]"></div>
                  <span className="text-gray-text uppercase">MA 20</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-bold">
                  <div className="w-3 h-0.5 bg-[#ef4444]"></div>
                  <span className="text-gray-text uppercase">MA 39</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-bold">
                  <div className="w-3 h-0.5 bg-[#f59e0b]"></div>
                  <span className="text-gray-text uppercase">WMA 100</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-bold">
                  <div className="w-3 h-3 border-2 border-binance-yellow rounded-full"></div>
                  <span className="text-gray-text uppercase">Trend Marker</span>
                </div>
              </div>
            </div>
          </div>

          {/* Chart Visual Container */}
          <div className="flex-1 min-h-[500px] md:min-h-[650px] border border-border-subtle rounded-xl bg-bg-main relative group overflow-y-auto">
            <div ref={chartContainerRef} className="w-full h-full" />
            
            {/* Legend Overlay Desktop */}
            <div className="absolute top-4 left-4 z-10 flex flex-col gap-2 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity hidden md:flex">
              <div className="bg-bg-secondary/80 backdrop-blur-md border border-border-subtle p-3 rounded-md shadow-2xl flex flex-col gap-1">
                <div className="text-[10px] text-gray-text uppercase font-black tracking-widest mb-1">Interval Telemetry</div>
                <div className="text-sm font-mono flex justify-between gap-8">
                  <span className="text-gray-text">MA20:</span>
                  <span className="text-[#8b4513] font-bold underline decoration-[#8b4513]/30">{ma20?.toFixed(2)}</span>
                </div>
                <div className="text-sm font-mono flex justify-between gap-8">
                  <span className="text-gray-text">MA39:</span>
                  <span className="text-[#ef4444] font-bold underline decoration-[#ef4444]/30">{ma39?.toFixed(2)}</span>
                </div>
                <div className="text-sm font-mono flex justify-between gap-8">
                  <span className="text-gray-text">WMA100:</span>
                  <span className="text-[#f59e0b] font-bold underline decoration-[#f59e0b]/30">{wma100?.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Removed summary boxes per user request for cleaner UI */}
        </section>
      </main>

      {/* Status Bar Footer */}
      <footer className="h-[32px] bg-bg-accent border-t border-border-subtle flex items-center justify-between px-4 text-[9px] md:text-[10px] text-gray-text font-bold uppercase tracking-wider shrink-0 overflow-hidden">
        <div className="flex gap-4 md:gap-6">
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <div className="w-1.5 h-1.5 bg-binance-green rounded-full"></div>
            Connected: Binance API
          </span>
          <span className="hidden md:flex items-center gap-1.5 whitespace-nowrap">
            <Activity size={12} className="text-ma20" />
            System Latency: 12ms
          </span>
        </div>
        <div className="truncate pl-4">© 2024 CryptoStar Terminal • Advanced Strategy Monitoring</div>
      </footer>

      {/* Global Notifications Layer */}
      <div className="fixed top-4 md:top-20 right-4 md:right-6 z-[100] flex flex-col gap-3 pointer-events-none w-[calc(100%-2rem)] md:w-auto">
        <AnimatePresence>
          {notifications.map((n) => (
            <motion.div
              key={n.id}
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
              className="bg-bg-secondary/95 backdrop-blur-xl border border-binance-yellow/50 text-white px-4 py-3 rounded-xl shadow-2xl flex items-center gap-4 pointer-events-auto border-l-4 border-l-binance-yellow"
            >
              <div className="bg-binance-yellow/20 p-2 rounded-lg shrink-0">
                <Star className="text-binance-yellow fill-binance-yellow" size={18} />
              </div>
              <div className="flex flex-col min-w-0">
                <p className="font-black text-[10px] uppercase tracking-[0.2em] text-binance-yellow">Strategy Triggered</p>
                <p className="text-sm font-bold tracking-tight truncate">{n.message}</p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
