const bcrypt = require('bcryptjs');
const db = require('./database');
require('dotenv').config();

async function setup() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';

  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  if (existing) {
    console.log(`✅ Admin "${username}" already exists`);
    return;
  }

  const hashed = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run(username, hashed);
  console.log(`✅ Admin created: ${username} / ${password}`);
  console.log('⚠️  Change your password after first login!');
}

setup().catch(console.error);
