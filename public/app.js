(() => {
  const $ = (sel) => document.querySelector(sel);
  const socket = io();
  let sessionId = null;
  let ready = false;
  let currentQrVersion = 0;
  let qrCountdownTimer = null;
  let qrExpiresAt = 0;

  const i18n = {
    ar: {
      connect_title: 'ربط واتساب · Connect WhatsApp',
      connect_desc: 'اضغط على الزر لعرض رمز QR ثم امسح الرمز باستخدام تطبيق واتساب على الهاتف.',
      btn_connect: 'ربط واتساب',
      btn_refresh: 'تجديد الباركود',
      btn_disconnect: 'تسجيل خروج',
      status_disconnected: 'غير متصل',
      status_connected: 'متصل',
      qr_expires: 'ينتهي خلال · Expires in:',
      seconds: 'ثانية · seconds',
      qr_expired_msg: 'انتهت صلاحية رمز QR · QR code expired',
      upload_title: 'رفع ملف Excel (.xlsx)',
      drop_msg: 'اسحب وأفلت الملف هنا أو انقر للاختيار',
      format_req: 'تنسيق الأعمدة A-G (صف العناوين 1):',
      batch_title: 'إعدادات الدُفعات · Batch Configuration',
      batch_size: 'عدد الرسائل لكل دفعة',
      delay: 'المدة بين الرسائل بالثواني (3-30)',
      send_title: 'الإرسال الجماعي · Bulk Sending',
      btn_start: 'بدء الإرسال',
      btn_pause: 'إيقاف مؤقت',
      btn_resume: 'استئناف',
      btn_stop: 'إيقاف',
      btn_report: 'تنزيل تقرير',
      confirm_start: 'هل أنت متأكد من بدء الإرسال؟',
    },
    en: {
      connect_title: 'Connect WhatsApp',
      connect_desc: 'Click the button to display the QR code, then scan it with WhatsApp on your phone.',
      btn_connect: 'Connect WhatsApp',
      btn_refresh: 'Refresh QR',
      btn_disconnect: 'Disconnect',
      status_disconnected: 'Disconnected',
      status_connected: 'Connected',
      qr_expires: 'Expires in:',
      seconds: 'seconds',
      qr_expired_msg: 'QR code expired',
      upload_title: 'Upload Excel (.xlsx)',
      drop_msg: 'Drag & drop your file here or click to choose',
      format_req: 'Columns A-G (Row 1 headers):',
      batch_title: 'Batch Configuration',
      batch_size: 'Messages per batch',
      delay: 'Delay between messages (seconds) (3-30)',
      send_title: 'Bulk Sending',
      btn_start: 'Start',
      btn_pause: 'Pause',
      btn_resume: 'Resume',
      btn_stop: 'Stop',
      btn_report: 'Download Report',
      confirm_start: 'Are you sure you want to start sending?',
    },
  };
  let lang = localStorage.getItem('lang') || 'ar';

  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (i18n[lang][k]) el.textContent = i18n[lang][k];
    });
  }

  function showError(message) {
    const errorEl = $('#error-message');
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
    setTimeout(() => {
      errorEl.classList.add('hidden');
    }, 5000);
  }

  function hideError() {
    $('#error-message').classList.add('hidden');
  }

  // Convert Arabic numerals to English numerals
  function convertArabicToEnglish(text) {
    if (!text) return text;
    const arabicNumerals = '٠١٢٣٤٥٦٧٨٩';
    const englishNumerals = '0123456789';

    return text.replace(/[٠-٩]/g, function(match) {
      return englishNumerals[arabicNumerals.indexOf(match)];
    });
  }

  // Setup number input with Arabic to English conversion
  function setupNumberInput(inputElement) {
    inputElement.addEventListener('input', function(e) {
      const cursorPosition = e.target.selectionStart;
      const originalValue = e.target.value;
      const convertedValue = convertArabicToEnglish(originalValue);

      if (originalValue !== convertedValue) {
        e.target.value = convertedValue;
        // Restore cursor position
        e.target.setSelectionRange(cursorPosition, cursorPosition);
        // Trigger change event to save config
        e.target.dispatchEvent(new Event('change'));
      }
    });
  }

  function setStatus(isReady, statusType = null) {
    ready = isReady;
    const st = $('#status');
    st.className = 'status ' + (ready ? 'connected' : 'disconnected');
    st.textContent = ready ? i18n[lang].status_connected : i18n[lang].status_disconnected;
    $('#btn-start').disabled = !sessionId || !ready;

    // Update button visibility based on connection status
    updateButtonVisibility(isReady, statusType);

    // Hide QR panel when connected
    if (ready && (statusType === 'ready' || statusType === 'authenticated')) {
      hideQrPanel();
    }
  }

  function updateButtonVisibility(isReady, statusType = null) {
    const connectBtn = $('#btn-connect');
    const refreshBtn = $('#btn-refresh');
    const disconnectBtn = $('#btn-disconnect');

    if (isReady && (statusType === 'ready' || statusType === 'authenticated')) {
      // Connected state: show only disconnect button
      connectBtn.classList.add('hidden');
      refreshBtn.classList.add('hidden');
      disconnectBtn.classList.remove('hidden');
    } else {
      // Disconnected state: show only connect button
      connectBtn.classList.remove('hidden');
      refreshBtn.classList.add('hidden');
      disconnectBtn.classList.add('hidden');
    }
  }

  function showRefreshButton() {
    const connectBtn = $('#btn-connect');
    const refreshBtn = $('#btn-refresh');
    const disconnectBtn = $('#btn-disconnect');

    // QR expired state: show refresh button
    connectBtn.classList.add('hidden');
    refreshBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
  }

  function clearQrCountdown() {
    if (qrCountdownTimer) {
      clearInterval(qrCountdownTimer);
      qrCountdownTimer = null;
    }
  }

  function startQrCountdown(expiresAt) {
    clearQrCountdown();
    qrExpiresAt = expiresAt;

    qrCountdownTimer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((qrExpiresAt - Date.now()) / 1000));
      $('#qr-countdown').textContent = remaining;

      if (remaining <= 0) {
        clearQrCountdown();
        showQrExpired();
      }
    }, 1000);
  }

  function showQrPanel() {
    $('#qr-panel').classList.remove('hidden');
    $('#qr-expired').classList.add('hidden');
  }

  function hideQrPanel() {
    $('#qr-panel').classList.add('hidden');
    clearQrCountdown();
  }

  function showQrExpired() {
    $('#qr-canvas').style.display = 'none';
    $('#qr-expired').classList.remove('hidden');
    showRefreshButton();
  }

  function renderQrToCanvas(dataUrl) {
    const canvas = $('#qr-canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      canvas.style.display = 'block';
    };

    img.src = dataUrl;
  }

  // WhatsApp connect - always use fresh connection for simplicity
  $('#btn-connect').addEventListener('click', async () => {
    const connectBtn = $('#btn-connect');
    const originalText = connectBtn.textContent;

    try {
      // Clear any previous errors
      hideError();

      // Show enhanced loading state
      connectBtn.disabled = true;
      let loadingText = lang === 'ar' ? 'جاري تهيئة واتساب...' : 'Initializing WhatsApp...';
      connectBtn.textContent = loadingText;

      // Add loading animation
      let dots = 0;
      const loadingInterval = setInterval(() => {
        dots = (dots + 1) % 4;
        const dotString = '.'.repeat(dots);
        connectBtn.textContent = loadingText + dotString;
      }, 500);

      const response = await fetch('/api/connect?fresh=1', { method: 'POST' });
      const data = await response.json();

      clearInterval(loadingInterval);

      if (!data.ok) {
        throw new Error(data.error || 'Connection failed');
      }

      // Success - QR should appear via socket
      console.log('WhatsApp connection initiated successfully');
      connectBtn.textContent = lang === 'ar' ? 'انتظار رمز QR...' : 'Waiting for QR...';

    } catch (e) {
      console.error('Connect error:', e);
      const errorMsg = lang === 'ar' ?
        'خطأ في الاتصال بواتساب. يرجى المحاولة مرة أخرى.' :
        'WhatsApp connection error. Please try again.';
      showError(errorMsg);

      // Restore button state on error
      connectBtn.disabled = false;
      connectBtn.textContent = originalText;
    }
  });

  // Refresh QR button
  $('#btn-refresh').addEventListener('click', async () => {
    try {
      await fetch('/api/connect?fresh=1', { method: 'POST' });
    } catch (e) {
      console.error('Refresh QR error:', e);
    }
  });

  // Disconnect button
  $('#btn-disconnect').addEventListener('click', async () => {
    try {
      // Clear the WhatsApp session completely
      await fetch('/api/connect?fresh=1', { method: 'POST' });
      // Reset UI to initial state
      ready = false;
      hideQrPanel();
      updateButtonVisibility(false);
      setStatus(false, 'disconnected');
    } catch (e) {
      console.error('Disconnect error:', e);
    }
  });

  socket.on('qr', ({ dataUrl, expiresAt, version }) => {
    // Ignore stale QR codes
    if (version <= currentQrVersion) {
      console.log('Ignoring stale QR, version:', version, 'current:', currentQrVersion);
      return;
    }

    currentQrVersion = version;
    console.log('New QR received, version:', version);

    // Restore connect button state when QR appears
    const connectBtn = $('#btn-connect');
    connectBtn.disabled = false;
    connectBtn.textContent = lang === 'ar' ? 'ربط واتساب' : 'Connect WhatsApp';

    showQrPanel();
    renderQrToCanvas(dataUrl);
    startQrCountdown(expiresAt);
  });

  socket.on('qr_expired', ({ version }) => {
    if (version === currentQrVersion) {
      showQrExpired();
    }
  });

  socket.on('status', ({ ready, type }) => {
    setStatus(ready, type);
  });

  socket.on('loading', ({ percent, message }) => {
    console.log(`Loading: ${percent}% - ${message}`);

    // Update connect button with loading progress
    const connectBtn = $('#btn-connect');
    if (connectBtn.disabled) {
      const loadingMsg = lang === 'ar' ?
        `جاري التحميل ${percent}%...` :
        `Loading ${percent}%...`;
      connectBtn.textContent = loadingMsg;
    }
  });

  socket.on('error', ({ message }) => {
    console.error('WhatsApp error:', message);
    const errorMsg = lang === 'ar' ?
      'خطأ في واتساب: ' + message :
      'WhatsApp error: ' + message;
    showError(errorMsg);
  });

  // Upload handling
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const uploadError = $('#upload-error');
  const summary = $('#summary');
  const preview = $('#preview');

  function resetUploadUI() {
    uploadError.textContent = '';
    summary.classList.add('hidden');
    preview.classList.add('hidden');
    summary.innerHTML = '';
    preview.innerHTML = '';
  }

  function handleFile(file) {
    resetUploadUI();
    if (!file || !file.name.toLowerCase().endsWith('.xlsx')) {
      uploadError.textContent = 'الرجاء رفع ملف .xlsx صحيح | Please upload a valid .xlsx file';
      return;
    }
    const form = new FormData();
    form.append('file', file);
    fetch('/api/upload', { method: 'POST', body: form })
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || 'Upload failed');
        sessionId = data.sessionId;
        // Summary
        const totalAmount = new Intl.NumberFormat(lang === 'ar' ? 'ar-KW' : 'en-US', { style: 'currency', currency: 'KWD' }).format(data.summary.totalAmountDue);
        summary.innerHTML = `<ul>
          <li>العملاء: ${data.summary.totalCustomers} · Customers</li>
          <li>أرقام صحيحة: ${data.summary.totalPhones} · Valid phones</li>
          <li>المجموع: ${totalAmount} · Total Amount</li>
        </ul>`;
        summary.classList.remove('hidden');

        // Preview first 5
        const rows = data.summary.preview;
        const t = document.createElement('table');
        t.style.width = '100%';
        t.style.borderCollapse = 'collapse';
        const th = document.createElement('tr');
        ['Name','ID','Phones','Amount','Msg'].forEach((h) => {
          const c = document.createElement('th'); c.textContent = h; c.style.textAlign = 'start'; c.style.borderBottom = '1px solid #e5e7eb'; c.style.padding = '6px'; th.appendChild(c);
        });
        t.appendChild(th);
        rows.forEach((r) => {
          const tr = document.createElement('tr');
          const cells = [r.name, r.nationalId, (r.phones||[]).join('\n'), r.amountDue, (r.message||'').slice(0,80)];
          cells.forEach((c) => { const td = document.createElement('td'); td.textContent = String(c ?? ''); td.style.verticalAlign = 'top'; td.style.padding = '6px'; td.style.borderBottom = '1px solid #f1f5f9'; tr.appendChild(td); });
          t.appendChild(tr);
        });
        preview.appendChild(t);
        preview.classList.remove('hidden');
        $('#btn-start').disabled = !ready;
      })
      .catch((e) => {
        uploadError.textContent = e.message || 'Upload failed';
      });
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files?.[0];
    handleFile(file);
  });
  fileInput.addEventListener('change', (e) => handleFile(e.target.files?.[0]));

  // Batch config persistence
  const bsInput = $('#batch-size');
  const dsInput = $('#delay-seconds');

  // Setup Arabic to English number conversion for both inputs
  setupNumberInput(bsInput);
  setupNumberInput(dsInput);

  const saved = JSON.parse(localStorage.getItem('config') || '{}');
  if (saved.batchSize) bsInput.value = saved.batchSize;
  if (saved.delaySeconds) dsInput.value = saved.delaySeconds;

  [bsInput, dsInput].forEach((el) => el.addEventListener('change', () => {
    const cfg = {
      batchSize: Number(convertArabicToEnglish(bsInput.value)) || 50,
      delaySeconds: Number(convertArabicToEnglish(dsInput.value)) || 6
    };
    localStorage.setItem('config', JSON.stringify(cfg));
  }));

  // Sending controls
  const btnStart = $('#btn-start');
  const btnPause = $('#btn-pause');
  const btnResume = $('#btn-resume');
  const btnStop = $('#btn-stop');
  const btnReport = $('#btn-report');
  const overallBar = $('#overall-bar');
  const progressText = $('#progress-text');
  const log = $('#log');

  btnStart.addEventListener('click', async () => {
    if (!sessionId) return;
    if (!confirm(i18n[lang].confirm_start)) return;

    // Convert Arabic numbers and validate
    const batchSizeValue = convertArabicToEnglish(bsInput.value);
    const delaySecondsValue = convertArabicToEnglish(dsInput.value);

    const batchSize = Math.max(1, Number(batchSizeValue) || 50);
    const delaySeconds = Math.max(3, Math.min(30, Number(delaySecondsValue) || 6));

    btnStart.disabled = true;
    btnPause.disabled = false;
    btnStop.disabled = false;
    try {
      const r = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, batchSize, delaySeconds, confirm: true }) });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'Failed to start');
    } catch (e) {
      alert(e.message || 'Failed to start');
    }
  });

  btnPause.addEventListener('click', async () => {
    await fetch('/api/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    btnPause.disabled = true; btnResume.disabled = false;
  });

  btnResume.addEventListener('click', async () => {
    await fetch('/api/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    btnResume.disabled = true; btnPause.disabled = false;
  });

  btnStop.addEventListener('click', async () => {
    await fetch('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    btnPause.disabled = true; btnResume.disabled = true; btnStop.disabled = true;
  });

  btnReport.addEventListener('click', () => {
    if (!sessionId) return;
    const a = document.createElement('a');
    a.href = `/api/report.csv?sessionId=${encodeURIComponent(sessionId)}`;
    a.download = 'report.csv';
    a.click();
  });

  socket.on('progress', ({ sent, total, currentBatch, totalBatches }) => {
    const pct = total ? Math.round((sent / total) * 100) : 0;
    overallBar.style.width = pct + '%';
    progressText.textContent = `Batch ${currentBatch}/${totalBatches} · ${sent}/${total} (${pct}%)`;
    if (sent >= total) {
      btnPause.disabled = true; btnResume.disabled = true; btnStop.disabled = true; btnReport.disabled = false;
    }
  });

  socket.on('delivery', (d) => {
    const line = `[${new Date(d.time).toLocaleTimeString()}] ${d.status.toUpperCase()} — ${d.customer} (${d.nationalId}) -> ${d.phone}${d.error ? ' | ' + d.error : ''}`;
    const div = document.createElement('div');
    div.textContent = line;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  });

  socket.on('error', (e) => {
    const div = document.createElement('div');
    div.style.color = '#b91c1c';
    div.textContent = 'ERROR: ' + (e?.message || 'Unknown');
    log.appendChild(div);
  });

  // Language toggle
  $('#lang-ar').addEventListener('click', () => { lang = 'ar'; localStorage.setItem('lang','ar'); applyLang(); });
  $('#lang-en').addEventListener('click', () => { lang = 'en'; localStorage.setItem('lang','en'); applyLang(); });
  applyLang();
})();

