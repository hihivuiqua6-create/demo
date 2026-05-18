// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { apiKeyQueries } = require('../models/database');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';

// Middleware xác thực JWT (cho dashboard admin)
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.token;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
  }
}

// Middleware xác thực API Key (cho web bên ngoài gọi vào)
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Missing X-Api-Key header',
      docs: 'Thêm header: X-Api-Key: <your_api_key>'
    });
  }

  // Check platform master key
  if (apiKey === process.env.PLATFORM_API_KEY) {
    req.apiKeyRecord = { permissions: 'create_bot,read_bot,delete_bot,update_bot', label: 'master' };
    apiKeyQueries.findByKey.get(apiKey); // no-op nếu master key chưa trong DB
    return next();
  }

  // Check DB api keys
  const record = apiKeyQueries.findByKey.get(apiKey);
  if (!record) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid API key' });
  }

  apiKeyQueries.updateLastUsed.run(apiKey);
  req.apiKeyRecord = record;
  next();
}

// Middleware optional auth (vừa JWT vừa API Key)
function requireAuthOrApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey) return requireApiKey(req, res, next);
  return requireAuth(req, res, next);
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

module.exports = { requireAuth, requireApiKey, requireAuthOrApiKey, generateToken };
