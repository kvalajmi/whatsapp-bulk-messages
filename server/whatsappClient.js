const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Singleton WhatsApp client manager
class WhatsAppClientManager {
  constructor() {
    this.client = null;
    this.io = null;
    this.isReady = false;
    this.currentQrVersion = 0;
    this.qrExpirationTimer = null;
    this.authPath = path.join(process.cwd(), '.wwebjs_auth');
    this.cachePath = path.join(process.cwd(), '.wwebjs_cache');
  }

  log(message, level = 'info') {
    const timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss');
    console.log(`[${timestamp}] [WhatsApp] [${level.toUpperCase()}] ${message}`);
  }

  async recursiveDelete(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    
    try {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          await this.recursiveDelete(filePath);
        } else {
          fs.unlinkSync(filePath);
        }
      }
      fs.rmdirSync(dirPath);
      this.log(`Deleted directory: ${dirPath}`);
    } catch (error) {
      this.log(`Error deleting ${dirPath}: ${error.message}`, 'error');
    }
  }

  async clearAuthData() {
    this.log('Clearing authentication data...');
    await this.recursiveDelete(this.authPath);
    await this.recursiveDelete(this.cachePath);
    this.log('Authentication data cleared');
  }

  setupEventHandlers() {
    if (!this.client || !this.io) return;

    this.client.on('qr', async (qr) => {
      try {
        this.currentQrVersion = Date.now();
        const expiresAt = Date.now() + 60000; // 60 seconds
        const dataUrl = await QRCode.toDataURL(qr);
        
        this.log(`QR code generated, version: ${this.currentQrVersion}, expires at: ${dayjs(expiresAt).format('HH:mm:ss')}`);
        
        this.io.emit('qr', {
          qr,
          dataUrl,
          expiresAt,
          version: this.currentQrVersion
        });

        // Clear existing timer
        if (this.qrExpirationTimer) {
          clearTimeout(this.qrExpirationTimer);
        }

        // Set expiration timer
        this.qrExpirationTimer = setTimeout(() => {
          this.log('QR code expired');
          this.io.emit('qr_expired', { version: this.currentQrVersion });
        }, 60000);

      } catch (error) {
        this.log(`QR generation error: ${error.message}`, 'error');
        this.io.emit('error', { message: 'Failed to generate QR code' });
      }
    });

    this.client.on('authenticated', () => {
      this.log('WhatsApp authenticated successfully');
      this.clearQrTimer();
      this.io.emit('status', { 
        type: 'authenticated', 
        timestamp: Date.now(),
        ready: false 
      });
    });

    this.client.on('ready', () => {
      this.isReady = true;
      this.log('WhatsApp client ready');
      this.clearQrTimer();
      this.io.emit('status', { 
        type: 'ready', 
        timestamp: Date.now(),
        ready: true 
      });
    });

    this.client.on('disconnected', (reason) => {
      this.isReady = false;
      this.log(`WhatsApp disconnected: ${reason}`, 'warn');
      this.clearQrTimer();
      this.io.emit('status', { 
        type: 'disconnected', 
        reason, 
        timestamp: Date.now(),
        ready: false 
      });
      // Clean up client reference on disconnect
      this.client = null;
    });

    this.client.on('auth_failure', (msg) => {
      this.log(`Authentication failed: ${msg}`, 'error');
      this.clearQrTimer();
      this.io.emit('error', { message: 'Authentication failed: ' + msg });
      this.client = null;
    });

    this.client.on('loading_screen', (percent, message) => {
      this.log(`Loading: ${percent}% - ${message}`);
      this.io.emit('loading', { percent, message });
    });
  }

  clearQrTimer() {
    if (this.qrExpirationTimer) {
      clearTimeout(this.qrExpirationTimer);
      this.qrExpirationTimer = null;
    }
  }

  async createClient(ioInstance, forceFresh = false) {
    this.io = ioInstance;

    // If forcing fresh session, clear auth data first
    if (forceFresh) {
      await this.destroyClient();
      await this.clearAuthData();
    }

    // Return existing client if already created and not forcing fresh
    if (this.client && !forceFresh) {
      this.log('Returning existing WhatsApp client');
      return this.client;
    }

    // Destroy existing client if any
    if (this.client) {
      await this.destroyClient();
    }

    this.log('Creating new WhatsApp client...');

    try {
      // Simplified Puppeteer configuration for better stability
      const puppeteerConfig = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--no-first-run',
          '--disable-default-apps',
          '--disable-extensions',
        ],
        timeout: 60000, // 1 minute timeout
        handleSIGINT: false,
        handleSIGTERM: false,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        defaultViewport: null,
      };

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: 'default',
          dataPath: this.authPath
        }),
        puppeteer: puppeteerConfig,
      });

      this.setupEventHandlers();
      this.log('WhatsApp client created successfully');
      return this.client;

    } catch (error) {
      this.log(`Error creating WhatsApp client: ${error.message}`, 'error');
      this.client = null;
      throw error;
    }
  }

  async destroyClient() {
    if (!this.client) return;

    this.log('Destroying WhatsApp client...');
    this.clearQrTimer();
    
    try {
      await this.client.destroy();
      this.log('WhatsApp client destroyed successfully');
    } catch (error) {
      this.log(`Error destroying client: ${error.message}`, 'warn');
    } finally {
      this.client = null;
      this.isReady = false;
      this.currentQrVersion = 0;
    }
  }

  getClientStatus() {
    return {
      exists: !!this.client,
      ready: this.isReady,
      qrVersion: this.currentQrVersion,
      timestamp: Date.now()
    };
  }

  async initializeClient() {
    if (!this.client) {
      throw new Error('Client not created. Call createClient() first.');
    }

    this.log('Initializing WhatsApp client...');

    try {
      await this.client.initialize();
      this.log('WhatsApp client initialization started successfully');
    } catch (error) {
      this.log(`Client initialization error: ${error.message}`, 'error');

      if (this.io) {
        this.io.emit('error', { message: 'فشل في تهيئة واتساب. يرجى إعادة تحميل الصفحة والمحاولة مرة أخرى.' });
      }
      this.client = null;
      throw error;
    }
  }

  async checkNumberExists(number) {
    if (!this.client || !this.isReady) {
      throw new Error('WhatsApp client not ready');
    }

    try {
      const chatId = number.replace('+', '') + '@c.us';
      const numberExists = await this.client.isRegisteredUser(chatId);
      this.log(`Number ${number} WhatsApp registration status: ${numberExists}`);
      return numberExists;
    } catch (error) {
      this.log(`Error checking number ${number}: ${error.message}`, 'warn');
      return false;
    }
  }

  async sendMessage(number, content, maxRetries = 2, skipRegistrationCheck = false) {
    if (!this.client || !this.isReady) {
      throw new Error('WhatsApp client not ready');
    }

    this.log(`📤 sendMessage called with number: "${number}", content length: ${content.length}, skipCheck: ${skipRegistrationCheck}`);

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        // Validate phone number format
        if (!number || typeof number !== 'string') {
          throw new Error(`Invalid phone number format: ${number}`);
        }

        // Ensure number starts with + and has digits
        if (!number.startsWith('+') || !/^\+\d{7,15}$/.test(number)) {
          throw new Error(`Invalid phone number format: ${number} (must be +countrycode followed by 7-15 digits)`);
        }

        const chatId = number.replace('+', '') + '@c.us';
        this.log(`🎯 Attempting to send message to ${number} (chatId: ${chatId})`);

        // Additional validation: ensure chatId doesn't match sender's own number
        if (this.client.info && this.client.info.wid && chatId === this.client.info.wid._serialized) {
          this.log(`❌ ERROR: Attempted to send message to self: ${chatId}`, 'error');
          throw new Error(`Cannot send message to your own number: ${number}`);
        }

        // Check if number is registered on WhatsApp (unless skipped for testing)
        if (!skipRegistrationCheck) {
          this.log(`🔍 Checking if ${number} is registered on WhatsApp...`);
          const isRegistered = await this.checkNumberExists(number);
          if (!isRegistered) {
            this.log(`❌ Number ${number} is not registered on WhatsApp`, 'warn');
            throw new Error(`Number ${number} is not registered on WhatsApp`);
          }
          this.log(`✅ Number ${number} is registered on WhatsApp`);
        } else {
          this.log(`⚠️ Skipping registration check for ${number} (test mode)`);
        }

        this.log(`📨 Sending message to ${chatId}...`);
        await this.client.sendMessage(chatId, content);
        this.log(`✅ Message sent successfully to ${number}`);
        return { ok: true };
      } catch (error) {
        attempt++;
        this.log(`❌ Send attempt ${attempt} failed for ${number}: ${error.message}`, 'warn');
        if (attempt > maxRetries) {
          return { ok: false, error: error?.message || 'Failed to send' };
        }
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
}

// Export singleton instance
const whatsappManager = new WhatsAppClientManager();

module.exports = {
  createClient: (io, forceFresh = false) => whatsappManager.createClient(io, forceFresh),
  destroyClient: () => whatsappManager.destroyClient(),
  getClientStatus: () => whatsappManager.getClientStatus(),
  initializeClient: () => whatsappManager.initializeClient(),
  sendMessage: (number, content, maxRetries) => whatsappManager.sendMessage(number, content, maxRetries),
  checkNumberExists: (number) => whatsappManager.checkNumberExists(number),
  isReady: () => whatsappManager.isReady,
  clearAuthData: () => whatsappManager.clearAuthData()
};
