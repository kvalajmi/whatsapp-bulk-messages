const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const XLSX = require('xlsx');
const { Server } = require('socket.io');
const whatsappClient = require('./whatsappClient');

const PORT = process.env.PORT || 3000;

// In-memory stores (single-user oriented)
const datasets = new Map(); // sessionId -> { rows, summary, logs, state }
let io = null;

// Configure file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
      return cb(new Error('Only .xlsx files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Header spec: English/Arabic acceptable names
const HEADER_SPEC = [
  { key: 'name', labels: ['Customer Name', 'اسم العميل'] },
  { key: 'nationalId', labels: ['National ID', 'الرقم المدني'] },
  { key: 'phone1', labels: ['Phone Number', 'رقم الهاتف'] },
  { key: 'phone2', labels: ['Phone Number 2', 'رقم الهاتف ٢'] },
  { key: 'phone3', labels: ['Phone Number 3', 'رقم الهاتف ٣'] },
  { key: 'amountDue', labels: ['Amount Due', 'المبلغ المستحق'] },
  { key: 'message', labels: ['Message Text', 'النص'] },
];

function matchHeaders(headerRow) {
  if (!headerRow || headerRow.length < 7) return { ok: false, error: 'Header row is missing required columns A–G' };
  const normalized = headerRow.map((h) => (h || '').toString().trim());
  const mapping = {};
  for (let i = 0; i < HEADER_SPEC.length; i++) {
    const spec = HEADER_SPEC[i];
    const actual = normalized[i];
    if (!spec.labels.some((l) => l.toLowerCase() === actual.toLowerCase())) {
      return {
        ok: false,
        error: `Invalid header in column ${String.fromCharCode(65 + i)}: expected one of [${spec.labels.join(' | ')}], got "${actual}"`,
      };
    }
    mapping[spec.key] = i;
  }
  return { ok: true, mapping };
}

function isValidPhone(p) {
  if (!p) return false;
  const s = String(p).replace(/\s|-/g, '');
  // Simple international format validation, allow leading + and 7-15 digits
  return /^\+?[1-9][0-9]{6,14}$/.test(s);
}

function toE164(p) {
  if (!p) return null;
  let s = String(p).replace(/\s|-/g, '');

  // إذا كان الرقم يبدأ بـ + فهو جاهز
  if (s.startsWith('+')) return s;

  // إذا كان الرقم يبدأ بـ 965 فأضف + فقط
  if (s.startsWith('965')) return `+${s}`;

  // إذا كان الرقم كويتي (8 أرقام تبدأ بـ 9, 6, 5, أو 2) أضف كود الكويت
  if (/^[9652]\d{7}$/.test(s)) {
    return `+965${s}`;
  }

  // إذا كان الرقم 7 أرقام فقط، أضف كود الكويت (للأرقام القديمة)
  if (/^\d{7}$/.test(s)) {
    return `+965${s}`;
  }

  // للأرقام الأخرى، أضف + إذا لم تكن موجودة
  return s ? `+${s}` : null;
}

function parseExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const header = rows[0] || [];
  const headerCheck = matchHeaders(header);
  if (!headerCheck.ok) {
    return { ok: false, error: headerCheck.error };
  }
  const mapping = headerCheck.mapping;
  const dataRows = rows.slice(1);
  const parsed = [];
  let totalAmount = 0;
  let totalPhones = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    if (!r || r.length === 0 || r.every((c) => c === undefined || c === null || String(c).trim() === '')) continue;
    const name = r[mapping.name] ?? '';
    const nationalId = r[mapping.nationalId] ?? '';
    const phone1 = r[mapping.phone1] ?? '';
    const phone2 = r[mapping.phone2] ?? '';
    const phone3 = r[mapping.phone3] ?? '';
    const amountDueRaw = r[mapping.amountDue] ?? 0;
    const message = r[mapping.message] ?? '';

    const amountDue = Number(amountDueRaw) || 0;
    totalAmount += amountDue;

    const phones = [phone1, phone2, phone3]
      .map((p) => (p === undefined || p === null ? '' : String(p).trim()))
      .filter((p) => p.length > 0)
      .map((p) => toE164(p))
      .filter((p) => isValidPhone(p));

    totalPhones += phones.length;

    // Debug logging for phone number processing
    console.log(`Row ${i + 2}: ${name} - Raw phones: [${phone1}, ${phone2}, ${phone3}] -> Processed: [${phones.join(', ')}]`);

    parsed.push({
      name: String(name),
      nationalId: String(nationalId),
      phones,
      amountDue,
      message: String(message),
      rowIndex: i + 2, // excel row number
    });
  }

  const summary = {
    totalCustomers: parsed.length,
    totalPhones,
    totalAmountDue: totalAmount,
    preview: parsed.slice(0, 5),
  };

  return { ok: true, parsed, summary };
}

function applyTemplate(msg, row) {
  if (!msg) return '';
  return msg
    .replaceAll('{name}', row.name || '')
    .replaceAll('{nationalId}', row.nationalId || '')
    .replaceAll('{amountDue}', String(row.amountDue ?? ''));
}

function emitToAll(event, payload) {
  if (io) io.emit(event, payload);
}

async function sendMessageWithRetry(number, content, maxRetries, delayMs, skipRegistrationCheck = false) {
  try {
    return await whatsappClient.sendMessage(number, content, maxRetries, skipRegistrationCheck);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function createServer() {
  const app = express();
  const server = http.createServer(app);
  io = new Server(server, { cors: { origin: '*'} });

  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan('dev'));

  // Rate limit basic
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
  app.use('/api/', limiter);

  // Serve SPA
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Socket.IO connection
  io.on('connection', (socket) => {
    // Send current WhatsApp status
    const status = whatsappClient.getClientStatus();
    socket.emit('status', {
      ready: status.ready,
      type: status.ready ? 'ready' : 'disconnected',
      timestamp: status.timestamp
    });
  });

  // WhatsApp Connect
  app.post('/api/connect', async (req, res) => {
    try {
      const forceFresh = req.query.fresh === '1';
      console.log(`Connect request received, forceFresh: ${forceFresh}`);

      // Create/get client with fresh option
      await whatsappClient.createClient(io, forceFresh);

      // Initialize the client
      await whatsappClient.initializeClient();

      res.json({
        ok: true,
        message: forceFresh ? 'Initializing fresh WhatsApp session' : 'Initializing WhatsApp client',
        forceFresh
      });
    } catch (error) {
      console.error('Connect endpoint error:', error);
      res.status(500).json({
        ok: false,
        error: error?.message || 'Failed to start WhatsApp client'
      });
    }
  });

  // Status
  app.get('/api/status', (req, res) => {
    const status = whatsappClient.getClientStatus();
    res.json({
      ok: true,
      ready: status.ready,
      clientExists: status.exists,
      qrVersion: status.qrVersion,
      timestamp: status.timestamp
    });
  });

  // Multer error handling middleware
  app.use('/api/upload', (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      console.error('Multer error:', error);
      return res.status(400).json({ ok: false, error: error.message });
    } else if (error) {
      console.error('Upload error:', error);
      return res.status(400).json({ ok: false, error: error.message });
    }
    next();
  });

  // Upload Excel
  app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
      console.log('Upload request received');
      if (!req.file) {
        console.log('No file in request');
        return res.status(400).json({ ok: false, error: 'Missing file' });
      }

      console.log('File received:', req.file.originalname, 'Size:', req.file.size);
      const { ok, parsed, summary, error } = parseExcel(req.file.buffer);
      if (!ok) {
        console.log('Excel parsing failed:', error);
        return res.status(400).json({ ok: false, error });
      }

      const sessionId = uuidv4();
      datasets.set(sessionId, {
        rows: parsed,
        summary,
        logs: [],
        state: { status: 'idle', current: 0 },
      });

      console.log('Excel processed successfully. SessionId:', sessionId);
      res.json({ ok: true, sessionId, summary });
    } catch (e) {
      console.error('Upload endpoint error:', e);
      res.status(500).json({ ok: false, error: e?.message || 'Failed to parse Excel' });
    }
  });

  function ensureSession(req, res) {
    const { sessionId } = req.body || req.query;
    if (!sessionId || !datasets.has(sessionId)) {
      res.status(400).json({ ok: false, error: 'Invalid or missing sessionId' });
      return null;
    }
    return datasets.get(sessionId);
  }

  // Start sending
  app.post('/api/send', async (req, res) => {
    try {
      const ds = ensureSession(req, res);
      if (!ds) return;

      const { batchSize = 50, delaySeconds = 6, confirm = false, testMode = false } = req.body || {};
      const bs = Math.max(1, Math.min(100, Number(batchSize) || 50));
      const dsDelay = Math.max(3, Math.min(30, Number(delaySeconds) || 6));

      if (!confirm) return res.status(400).json({ ok: false, error: 'Confirmation required to start sending' });
      if (!whatsappClient.isReady()) return res.status(400).json({ ok: false, error: 'WhatsApp is not connected. Please connect first.' });
      if (ds.state.status === 'running') return res.status(400).json({ ok: false, error: 'Already running' });

      ds.state = { status: 'running', current: 0, batchSize: bs, delayMs: dsDelay * 1000, total: ds.rows.length, testMode };

      // Kick off sending loop (non-blocking)
      (async () => {
        const totalMessages = ds.rows.reduce((acc, r) => acc + (r.phones?.length || 0), 0);
        const totalBatches = Math.ceil(totalMessages / bs);
        let sentCount = 0;
        let batchIndex = 0; // 0-based

        const pauseCheck = async () => {
          while (ds.state.status === 'paused') {
            await new Promise((r) => setTimeout(r, 500));
          }
          if (ds.state.status === 'stopped') throw new Error('stopped');
        };

        const delay = (ms) => new Promise((r) => setTimeout(r, ms));

        try {
          for (let i = 0; i < ds.rows.length; i++) {
            const row = ds.rows[i];
            const baseMessage = row.message || '';
            const content = applyTemplate(baseMessage, row);

            for (let j = 0; j < row.phones.length; j++) {
              await pauseCheck();
              const phone = row.phones[j];
              const currentMsgIndex = sentCount + 1;
              const newBatchIndex = Math.floor(sentCount / bs);
              if (newBatchIndex !== batchIndex) batchIndex = newBatchIndex;

              console.log(`📤 Sending message ${currentMsgIndex} to ${phone} for customer ${row.name} ${ds.state.testMode ? '(TEST MODE)' : ''}`);
              const resSend = await sendMessageWithRetry(phone, content, 2, ds.state.delayMs, ds.state.testMode);
              console.log(`📊 Message result for ${phone}: ${resSend.ok ? '✅ SUCCESS' : '❌ FAILED - ' + resSend.error}`);

              const logItem = {
                time: dayjs().toISOString(),
                customer: row.name,
                nationalId: row.nationalId,
                phone,
                rowIndex: row.rowIndex,
                messageLength: content.length,
                status: resSend.ok ? 'success' : 'failed',
                error: resSend.ok ? undefined : resSend.error,
              };
              ds.logs.push(logItem);

              sentCount++;
              io.emit('delivery', logItem);
              io.emit('progress', {
                sent: sentCount,
                total: totalMessages,
                currentBatch: batchIndex + 1,
                totalBatches,
              });

              // Inter-message delay
              await delay(ds.state.delayMs);
            }
          }

          ds.state.status = 'completed';
          io.emit('progress', {
            sent: sentCount,
            total: totalMessages,
            currentBatch: totalBatches,
            totalBatches,
          });
          io.emit('completed', { total: totalMessages });
        } catch (e) {
          if (e.message === 'stopped') {
            io.emit('stopped');
          } else {
            io.emit('error', { message: e?.message || 'Sending loop error' });
          }
        }
      })();

      res.json({ ok: true, message: 'Started sending' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'Failed to start sending' });
    }
  });

  app.post('/api/pause', (req, res) => {
    const ds = ensureSession(req, res);
    if (!ds) return;
    if (ds.state.status !== 'running') return res.status(400).json({ ok: false, error: 'Not running' });
    ds.state.status = 'paused';
    io.emit('paused');
    res.json({ ok: true });
  });

  app.post('/api/resume', (req, res) => {
    const ds = ensureSession(req, res);
    if (!ds) return;
    if (ds.state.status !== 'paused') return res.status(400).json({ ok: false, error: 'Not paused' });
    ds.state.status = 'running';
    io.emit('resumed');
    res.json({ ok: true });
  });

  app.post('/api/stop', (req, res) => {
    const ds = ensureSession(req, res);
    if (!ds) return;
    if (!['running', 'paused'].includes(ds.state.status)) return res.status(400).json({ ok: false, error: 'Not running/paused' });
    ds.state.status = 'stopped';
    res.json({ ok: true });
  });

  // Report CSV
  app.get('/api/report.csv', (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId || !datasets.has(sessionId)) return res.status(400).send('Invalid sessionId');
    const ds = datasets.get(sessionId);
    const headers = ['time','customer','nationalId','phone','rowIndex','messageLength','status','error'];
    const lines = [headers.join(',')];
    for (const l of ds.logs) {
      const row = [l.time, l.customer, l.nationalId, l.phone, l.rowIndex, l.messageLength, l.status, (l.error || '').replaceAll('\n',' ').replaceAll(',',';')];
      lines.push(row.map((v) => `"${String(v ?? '')}"`).join(','));
    }
    const csv = lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
    res.send(csv);
  });

  // Summary endpoint (optional helper)
  app.get('/api/summary', (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId || !datasets.has(sessionId)) return res.status(400).json({ ok: false, error: 'Invalid sessionId' });
    res.json({ ok: true, summary: datasets.get(sessionId).summary });
  });

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });

  return { app, server };
}

createServer();

