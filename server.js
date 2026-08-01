const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');  // ← 改成 bcryptjs
const pool = require('./database');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 视频上传配置
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// Session
const PgSession = require('connect-pg-simple')(session);
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, secure: false }
}));

// ========== 用户相关 ==========

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: '用户名和密码至少4位' });
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username',
      [username, hashed]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(err.code === '23505' ? 409 : 500).json({ 
      error: err.code === '23505' ? '用户名已存在' : '注册失败' 
    });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写完整信息' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/me', (req, res) => {
  res.json(req.session.user ? { loggedIn: true, user: req.session.user } : { loggedIn: false });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.post('/api/create-team-accounts', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可操作' });
  }
  const { count = 12, prefix = 'team' } = req.body;
  const created = [];
  for (let i = 1; i <= count; i++) {
    const username = `${prefix}${String(i).padStart(2, '0')}`;
    const password = '123456';
    const hashed = await bcrypt.hash(password, 10);
    try {
      await pool.query(
        'INSERT INTO users (username, password) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
        [username, hashed]
      );
      created.push(username);
    } catch (e) {}
  }
  res.json({ success: true, created, count: created.length });
});

// ========== 视频相关 ==========

app.post('/api/videos', upload.single('video'), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const { title, description, category } = req.body;
  if (!title || !category || !req.file) {
    return res.status(400).json({ error: '标题、栏目、视频文件必填' });
  }
  const validCategories = ['有戏我来评', '我眼中的戏曲', '戏曲微课堂', '名家传戏'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: '无效栏目' });
  }
  try {
    const videoUrl = `/uploads/${req.file.filename}`;
    const result = await pool.query(
      `INSERT INTO videos (title, description, category, video_url, user_id, status) 
       VALUES ($1, $2, $3, $4, $5, 'approved') RETURNING *`,
      [title, description, category, videoUrl, req.session.user.id]
    );
    res.json({ success: true, video: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: '发布失败' });
  }
});

app.get('/api/videos', async (req, res) => {
  const { category, limit = 50 } = req.query;
  try {
    let query = 'SELECT v.*, u.username FROM videos v LEFT JOIN users u ON v.user_id = u.id WHERE v.status = $1';
    const params = ['approved'];
    if (category) {
      query += ' AND v.category = $2';
      params.push(category);
    }
    query += ` ORDER BY v.created_at DESC LIMIT ${parseInt(limit)}`;
    const result = await pool.query(query, params);
    res.json({ videos: result.rows });
  } catch (err) {
    res.status(500).json({ error: '获取失败' });
  }
});

app.get('/api/videos/:id', async (req, res) => {
  try {
    await pool.query('UPDATE videos SET views = views + 1 WHERE id = $1', [req.params.id]);
    const result = await pool.query(
      'SELECT v.*, u.username FROM videos v LEFT JOIN users u ON v.user_id = u.id WHERE v.id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '视频不存在' });
    res.json({ video: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: '获取失败' });
  }
});

app.delete('/api/videos/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  try {
    const video = await pool.query('SELECT user_id FROM videos WHERE id = $1', [req.params.id]);
    if (video.rows.length === 0) return res.status(404).json({ error: '视频不存在' });
    if (video.rows[0].user_id !== req.session.user.id && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '无权限删除' });
    }
    await pool.query('DELETE FROM videos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

// ========== AI戏曲人物互动 ==========

app.post('/api/ai/chat', async (req, res) => {
  const { message, characterId = 1 } = req.body;
  if (!message) return res.status(400).json({ error: '请输入问题' });
  
  try {
    const charResult = await pool.query('SELECT * FROM ai_character WHERE id = $1', [characterId]);
    const character = charResult.rows[0] || { system_prompt: '你是戏曲文化科普助手' };

    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: character.system_prompt },
        { role: 'user', content: message }
      ],
      max_tokens: 300,
      temperature: 0.8
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    let reply = response.data.choices[0].message.content;
    res.json({ reply, character: character.name || '小戏' });
  } catch (err) {
    try {
      const fallback = await pool.query(
        'SELECT answer FROM ai_knowledge ORDER BY RANDOM() LIMIT 1'
      );
      res.json({ 
        reply: fallback.rows[0]?.answer || '小戏正在学习更多戏曲知识呢！🎭 您可以换个问题问我~',
        character: '小戏'
      });
    } catch (e) {
      res.status(500).json({ error: 'AI服务繁忙，请稍后再试' });
    }
  }
});

// ========== 管理员 ==========

app.get('/api/admin/videos', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可查看' });
  }
  const { status } = req.query;
  try {
    let query = 'SELECT v.*, u.username FROM videos v LEFT JOIN users u ON v.user_id = u.id';
    const params = [];
    if (status) {
      query += ' WHERE v.status = $1';
      params.push(status);
    }
    query += ' ORDER BY v.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ videos: result.rows });
  } catch (err) {
    res.status(500).json({ error: '获取失败' });
  }
});

app.put('/api/admin/videos/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可操作' });
  }
  const { status } = req.body;
  try {
    await pool.query('UPDATE videos SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '更新失败' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可查看' });
  }
  try {
    const result = await pool.query('SELECT id, username, role, created_at, last_login FROM users ORDER BY id');
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: '获取失败' });
  }
});

app.put('/api/admin/users/:id/ban', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可操作' });
  }
  try {
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['banned', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

app.use('/uploads', express.static('uploads'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🎭 戏曲吾爱平台已启动！`);
  console.log(`🌐 访问地址: http://localhost:${PORT}`);
  console.log(`📋 管理员账号: ${process.env.ADMIN_USERNAME || 'admin'}`);
  console.log(`📋 管理员密码: ${process.env.ADMIN_PASSWORD || 'admin123456'}`);
});