const { Pool } = require('pg');
const bcrypt = require('bcryptjs');  // ← 改成 bcryptjs
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS videos (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        category VARCHAR(50) NOT NULL,
        video_url TEXT NOT NULL,
        cover_url TEXT,
        user_id INTEGER REFERENCES users(id),
        status VARCHAR(20) DEFAULT 'pending',
        views INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_knowledge (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        category VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_character (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        avatar_url TEXT,
        personality TEXT,
        system_prompt TEXT
      )
    `);

    const adminHashed = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123456', 10);
    await client.query(
      `INSERT INTO users (username, password, role) VALUES ($1, $2, 'admin') ON CONFLICT (username) DO UPDATE SET role='admin'`,
      [process.env.ADMIN_USERNAME || 'admin', adminHashed]
    );

    await client.query(`
      INSERT INTO ai_character (name, personality, system_prompt) 
      VALUES ('小戏', '活泼可爱的戏曲少女，喜欢用轻松有趣的方式讲戏曲知识', 
      '你是"小戏"，一个热爱戏曲的AI虚拟人物。你用活泼可爱的语气和用户聊天，主动分享戏曲小知识。你擅长用通俗易懂的方式解释：行当划分（生旦净丑）、唱腔特点、妆容服饰、经典剧目。你说话时会带emoji，语气亲切。') 
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      INSERT INTO ai_knowledge (question, answer) VALUES 
      ('什么是生旦净丑？', '生旦净丑是戏曲的四大行当哦！🎭 生：男性角色（老生、小生）；旦：女性角色（青衣、花旦）；净：花脸角色（包公、曹操）；丑：滑稽角色（武大郎、店小二）。每个行当都有独特的表演方式！'),
      ('京剧有哪些唱腔？', '京剧主要有西皮和二黄两大唱腔系统！🎵 西皮：明快、激昂，适合表现欢快或激烈情绪；二黄：深沉、委婉，适合表现悲伤、思念。还有反西皮、反二黄等变体呢！')
      ON CONFLICT DO NOTHING
    `);

    console.log('✅ 数据库初始化完成');
    console.log('📋 管理员账号:', process.env.ADMIN_USERNAME || 'admin');
    console.log('📋 管理员密码:', process.env.ADMIN_PASSWORD || 'admin123456');
  } catch (err) {
    console.error('❌ 数据库初始化失败:', err);
  } finally {
    client.release();
  }
}

initDB();
module.exports = pool;