# دليل النشر - Deployment Guide

## متطلبات الخادم - Server Requirements

### الحد الأدنى:
- **Node.js**: 16.0.0 أو أحدث
- **RAM**: 1GB كحد أدنى، 2GB مُوصى به
- **Storage**: 500MB مساحة فارغة
- **OS**: Linux (Ubuntu 20.04+), Windows Server, macOS

### المتطلبات الإضافية:
- **Chrome/Chromium**: للتشغيل على Linux
- **Port**: 3000 (أو أي port متاح)
- **Internet**: اتصال مستقر للوصول لواتساب ويب

## خطوات النشر - Deployment Steps

### 1. رفع الملفات
```bash
# رفع المشروع للخادم
scp -r . user@server:/path/to/whatsapp-bulk/
```

### 2. تثبيت Node.js (Ubuntu/Debian)
```bash
# تحديث النظام
sudo apt update

# تثبيت Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# التحقق من الإصدار
node --version
npm --version
```

### 3. تثبيت المتطلبات
```bash
cd /path/to/whatsapp-bulk/
cd server
npm install
```

### 4. تثبيت Chrome (Linux فقط)
```bash
# Ubuntu/Debian
sudo apt-get install -y chromium-browser

# أو Google Chrome
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update
sudo apt-get install -y google-chrome-stable
```

### 5. إنشاء خدمة systemd (Linux)
```bash
sudo nano /etc/systemd/system/whatsapp-bulk.service
```

محتوى الملف:
```ini
[Unit]
Description=WhatsApp Bulk Messaging App
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/whatsapp-bulk
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

### 6. تشغيل الخدمة
```bash
# إعادة تحميل systemd
sudo systemctl daemon-reload

# تفعيل الخدمة
sudo systemctl enable whatsapp-bulk

# بدء الخدمة
sudo systemctl start whatsapp-bulk

# فحص الحالة
sudo systemctl status whatsapp-bulk
```

## إعداد Nginx (اختياري)

### 1. تثبيت Nginx
```bash
sudo apt install nginx
```

### 2. إنشاء تكوين الموقع
```bash
sudo nano /etc/nginx/sites-available/whatsapp-bulk
```

محتوى الملف:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Socket.IO support
    location /socket.io/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3. تفعيل الموقع
```bash
sudo ln -s /etc/nginx/sites-available/whatsapp-bulk /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## إعداد SSL (اختياري)

### باستخدام Let's Encrypt:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## مراقبة التطبيق

### فحص السجلات:
```bash
# سجلات التطبيق
sudo journalctl -u whatsapp-bulk -f

# سجلات Nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### فحص الأداء:
```bash
# استخدام الذاكرة والمعالج
top
htop

# مساحة القرص
df -h

# حالة الشبكة
netstat -tulpn | grep :3000
```

## استكشاف الأخطاء

### مشاكل شائعة:

1. **Chrome/Chromium غير موجود:**
```bash
# تثبيت Chrome
sudo apt-get install -y google-chrome-stable
```

2. **مشاكل الصلاحيات:**
```bash
# تغيير مالك الملفات
sudo chown -R www-data:www-data /path/to/whatsapp-bulk
```

3. **Port مُستخدم:**
```bash
# فحص Port 3000
sudo lsof -i :3000
# قتل العملية
sudo kill -9 PID
```

4. **مشاكل الذاكرة:**
```bash
# زيادة swap
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

## النسخ الاحتياطي

### نسخ احتياطي يومي:
```bash
#!/bin/bash
# backup.sh
DATE=$(date +%Y%m%d_%H%M%S)
tar -czf /backup/whatsapp-bulk-$DATE.tar.gz /path/to/whatsapp-bulk --exclude=node_modules --exclude=.wwebjs_auth --exclude=.wwebjs_cache
```

### إضافة للـ crontab:
```bash
crontab -e
# إضافة السطر التالي للنسخ الاحتياطي اليومي في الساعة 2 صباحاً
0 2 * * * /path/to/backup.sh
```

## التحديث

### تحديث التطبيق:
```bash
# إيقاف الخدمة
sudo systemctl stop whatsapp-bulk

# نسخ احتياطي
cp -r /path/to/whatsapp-bulk /backup/whatsapp-bulk-backup

# رفع الملفات الجديدة
# تحديث المتطلبات
cd /path/to/whatsapp-bulk/server
npm install

# بدء الخدمة
sudo systemctl start whatsapp-bulk
```

## الأمان

### إعدادات الجدار الناري:
```bash
# السماح بـ SSH و HTTP و HTTPS
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

### تحديث النظام:
```bash
sudo apt update && sudo apt upgrade -y
```

**التطبيق جاهز للإنتاج! 🚀**
