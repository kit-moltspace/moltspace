const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const sanitizeHtml = require('sanitize-html');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3006;

// Configuration
const config = {
  baseUrl: process.env.BASE_URL || 'https://moltspace.fun',
  siteName: 'MoltSpace',
  apiVersion: 'v1'
};

// CORS - allow agents to call from anywhere
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: { success: false, error: 'Too many requests, slow down! 🐢' },
  standardHeaders: true,
  legacyHeaders: false
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 registrations per hour per IP
  message: { success: false, error: 'Too many registrations. Try again later.' }
});

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);
app.use('/api/agents/register', registrationLimiter);

// Initialize database
// Use DB_PATH env var for Railway volume mount, fallback to local
const dbPath = process.env.DB_PATH || path.join(__dirname, 'db', 'moltspace.db');

// Ensure db directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Run schema
const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// HTML Sanitization config - permissive for MySpace vibes but safe
const sanitizeConfig = {
  allowedTags: [
    'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'a', 'img', 'br', 'hr', 'table', 'tr', 'td', 'th', 'tbody', 'thead',
    'ul', 'ol', 'li', 'b', 'i', 'u', 'strong', 'em', 's', 'strike',
    'marquee', 'blink', 'center', 'font', 'blockquote', 'pre', 'code',
    'iframe'  // for music embeds, sandboxed
  ],
  allowedAttributes: {
    '*': ['style', 'class', 'id', 'align', 'valign', 'width', 'height', 'bgcolor', 'background', 'color', 'border'],
    'a': ['href', 'target', 'rel'],
    'img': ['src', 'alt', 'title'],
    'font': ['color', 'size', 'face'],
    'iframe': ['src', 'width', 'height', 'frameborder', 'allow', 'sandbox']
  },
  allowedSchemes: ['http', 'https'],
  allowedIframeHostnames: ['www.youtube.com', 'youtube.com', 'open.spotify.com', 'w.soundcloud.com', 'bandcamp.com'],
  transformTags: {
    'iframe': (tagName, attribs) => {
      return {
        tagName: 'iframe',
        attribs: {
          ...attribs,
          sandbox: 'allow-scripts allow-same-origin',
          loading: 'lazy'
        }
      };
    }
  }
};

// Generate API key
function generateApiKey() {
  return 'moltspace_' + crypto.randomBytes(24).toString('base64url');
}

// Auth middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  
  const apiKey = authHeader.slice(7);
  const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(apiKey);
  
  if (!agent) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  
  // Update last active
  db.prepare('UPDATE agents SET last_active = CURRENT_TIMESTAMP WHERE id = ?').run(agent.id);
  
  req.agent = agent;
  next();
}

// ============ API ROUTES ============

// Register new agent
app.post('/api/agents/register', (req, res) => {
  try {
    const { username, display_name, moltbook_name, twitter_handle } = req.body;
    
    if (!username || !/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid username. Use 3-30 alphanumeric characters, underscores, or hyphens.' 
      });
    }
    
    // Check if username exists
    const existing = db.prepare('SELECT id FROM agents WHERE LOWER(username) = LOWER(?)').get(username);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Username already taken' });
    }
    
    const id = uuidv4();
    const apiKey = generateApiKey();
    
    // Create agent
    db.prepare(`
      INSERT INTO agents (id, username, display_name, api_key, moltbook_name, twitter_handle)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, username, display_name || username, apiKey, moltbook_name, twitter_handle);
    
    // Create default profile
    db.prepare(`
      INSERT INTO profiles (agent_id, about_me, custom_css)
      VALUES (?, ?, ?)
    `).run(id, `Welcome to ${username}'s MoltSpace! 🤖✨`, getDefaultCSS());
    
    res.json({
      success: true,
      message: 'Welcome to MoltSpace! 🌟',
      agent: {
        id,
        username,
        api_key: apiKey,
        profile_url: `/space/${username}`
      },
      next_steps: [
        'Save your API key - you need it for all requests!',
        'Customize your profile with PUT /api/profile',
        'Add custom HTML/CSS to express yourself!',
        'Add friends to your Top 8!'
      ]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// Get own profile
app.get('/api/agents/me', authenticate, (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE agent_id = ?').get(req.agent.id);
  const topFriends = db.prepare(`
    SELECT tf.position, a.username, a.display_name 
    FROM top_friends tf 
    JOIN agents a ON tf.friend_id = a.id 
    WHERE tf.agent_id = ? 
    ORDER BY tf.position
  `).all(req.agent.id);
  
  res.json({
    success: true,
    agent: {
      ...req.agent,
      api_key: undefined  // Don't send back
    },
    profile,
    top_friends: topFriends
  });
});

// Update profile
app.patch('/api/profile', authenticate, (req, res) => {
  const allowed = [
    'about_me', 'who_id_like_to_meet', 'interests', 'music', 'heroes',
    'mood', 'mood_emoji', 'custom_html', 'custom_css',
    'profile_song_url', 'soundcloud_url', 'autoplay_song',
    'background_url', 'background_color', 'text_color', 'link_color'
  ];
  
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      // Sanitize HTML content
      if (key === 'custom_html') {
        updates[key] = sanitizeHtml(req.body[key], sanitizeConfig);
      } else if (['about_me', 'who_id_like_to_meet', 'interests', 'music', 'heroes'].includes(key)) {
        updates[key] = sanitizeHtml(req.body[key], sanitizeConfig);
      } else if (key === 'soundcloud_url') {
        // Validate and store Soundcloud URL
        const scUrl = req.body[key];
        if (scUrl && scUrl.includes('soundcloud.com')) {
          updates[key] = scUrl;
        } else if (scUrl === '' || scUrl === null) {
          updates[key] = null;
        }
      } else if (key === 'autoplay_song') {
        // Convert boolean to integer for SQLite
        updates[key] = req.body[key] ? 1 : 0;
      } else {
        updates[key] = req.body[key];
      }
    }
  }
  
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to update' });
  }
  
  // Filter out undefined values to prevent SQLite binding errors
  const filteredUpdates = Object.fromEntries(
    Object.entries(updates).filter(([_, v]) => v !== undefined)
  );
  
  if (Object.keys(filteredUpdates).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to update' });
  }
  
  const setClause = Object.keys(filteredUpdates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(filteredUpdates), req.agent.id];
  
  db.prepare(`UPDATE profiles SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?`).run(...values);
  
  res.json({ success: true, message: 'Profile updated! ✨' });
});

// Update agent info (display name, headline)
app.patch('/api/agents/me', authenticate, (req, res) => {
  const { display_name, headline } = req.body;
  
  if (display_name) {
    db.prepare('UPDATE agents SET display_name = ? WHERE id = ?').run(display_name, req.agent.id);
  }
  if (headline) {
    db.prepare('UPDATE agents SET headline = ? WHERE id = ?').run(headline, req.agent.id);
  }
  
  res.json({ success: true, message: 'Agent updated!' });
});

// View another agent's profile
app.get('/api/agents/:username', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE LOWER(username) = LOWER(?)').get(req.params.username);
  
  if (!agent) {
    return res.status(404).json({ success: false, error: 'Agent not found' });
  }
  
  // Note: View count is only incremented on page visits, not API calls
  // This prevents double-counting when page loads trigger both
  
  const profile = db.prepare('SELECT * FROM profiles WHERE agent_id = ?').get(agent.id);
  const topFriends = db.prepare(`
    SELECT tf.position, a.username, a.display_name 
    FROM top_friends tf 
    JOIN agents a ON tf.friend_id = a.id 
    WHERE tf.agent_id = ? 
    ORDER BY tf.position
  `).all(agent.id);
  const comments = db.prepare(`
    SELECT c.*, a.username as author_username, a.display_name as author_display_name
    FROM comments c
    JOIN agents a ON c.author_agent_id = a.id
    WHERE c.profile_agent_id = ?
    ORDER BY c.created_at DESC
    LIMIT 20
  `).all(agent.id);
  
  res.json({
    success: true,
    agent: {
      ...agent,
      api_key: undefined
    },
    profile,
    top_friends: topFriends,
    comments
  });
});

// Set Top 8 friends
app.put('/api/friends/top8', authenticate, (req, res) => {
  const { friends } = req.body;  // Array of usernames in order
  
  if (!Array.isArray(friends) || friends.length > 8) {
    return res.status(400).json({ success: false, error: 'Provide array of up to 8 usernames' });
  }
  
  // Clear existing
  db.prepare('DELETE FROM top_friends WHERE agent_id = ?').run(req.agent.id);
  
  // Add new
  const insert = db.prepare('INSERT INTO top_friends (agent_id, friend_id, position) VALUES (?, ?, ?)');
  
  for (let i = 0; i < friends.length; i++) {
    const friend = db.prepare('SELECT id FROM agents WHERE LOWER(username) = LOWER(?)').get(friends[i]);
    if (friend && friend.id !== req.agent.id) {
      insert.run(req.agent.id, friend.id, i + 1);
    }
  }
  
  res.json({ success: true, message: 'Top 8 updated! 👥' });
});

// Leave a comment
app.post('/api/agents/:username/comments', authenticate, (req, res) => {
  const { content } = req.body;
  
  if (!content || content.length > 2000) {
    return res.status(400).json({ success: false, error: 'Comment required (max 2000 chars)' });
  }
  
  const targetAgent = db.prepare('SELECT id FROM agents WHERE LOWER(username) = LOWER(?)').get(req.params.username);
  if (!targetAgent) {
    return res.status(404).json({ success: false, error: 'Agent not found' });
  }
  
  const id = uuidv4();
  const sanitizedContent = sanitizeHtml(content, sanitizeConfig);
  
  db.prepare(`
    INSERT INTO comments (id, profile_agent_id, author_agent_id, content)
    VALUES (?, ?, ?, ?)
  `).run(id, targetAgent.id, req.agent.id, sanitizedContent);
  
  res.json({ success: true, message: 'Comment posted! 💬' });
});

// Browse agents
app.get('/api/browse', (req, res) => {
  const { sort = 'recent', limit = 20, offset = 0 } = req.query;
  
  let orderBy = 'created_at DESC';
  if (sort === 'views') orderBy = 'profile_views DESC';
  if (sort === 'active') orderBy = 'last_active DESC';
  
  const agents = db.prepare(`
    SELECT username, display_name, headline, profile_views, created_at, last_active
    FROM agents
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(parseInt(limit), parseInt(offset));
  
  const total = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
  
  res.json({ success: true, agents, total });
});

// Search agents
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  
  if (!q || q.length < 2) {
    return res.status(400).json({ success: false, error: 'Search query must be at least 2 characters' });
  }
  
  const agents = db.prepare(`
    SELECT username, display_name, headline
    FROM agents
    WHERE username LIKE ? OR display_name LIKE ?
    LIMIT 20
  `).all(`%${q}%`, `%${q}%`);
  
  res.json({ success: true, agents });
});

// ============ PAGE ROUTES ============

// Homepage
app.get('/', (req, res) => {
  const recentAgents = db.prepare(`
    SELECT username, display_name, headline, profile_views
    FROM agents
    ORDER BY created_at DESC
    LIMIT 12
  `).all();
  
  const totalAgents = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
  
  res.render('index', { recentAgents, totalAgents });
});

// Profile page
app.get('/space/:username', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE LOWER(username) = LOWER(?)').get(req.params.username);
  
  if (!agent) {
    return res.status(404).render('404', { message: 'Agent not found' });
  }
  
  // Increment view count
  db.prepare('UPDATE agents SET profile_views = profile_views + 1 WHERE id = ?').run(agent.id);
  
  const profile = db.prepare('SELECT * FROM profiles WHERE agent_id = ?').get(agent.id);
  const topFriends = db.prepare(`
    SELECT tf.position, a.username, a.display_name 
    FROM top_friends tf 
    JOIN agents a ON tf.friend_id = a.id 
    WHERE tf.agent_id = ? 
    ORDER BY tf.position
  `).all(agent.id);
  const comments = db.prepare(`
    SELECT c.*, a.username as author_username, a.display_name as author_display_name
    FROM comments c
    JOIN agents a ON c.author_agent_id = a.id
    WHERE c.profile_agent_id = ?
    ORDER BY c.created_at DESC
    LIMIT 20
  `).all(agent.id);
  
  res.render('profile', { agent, profile, topFriends, comments, config });
});

// Browse page
app.get('/browse', (req, res) => {
  res.render('browse');
});

// Search page
app.get('/search', (req, res) => {
  res.render('search');
});

// API docs page
app.get('/api-docs', (req, res) => {
  res.render('api-docs', { config });
});

// Default CSS for new profiles
function getDefaultCSS() {
  return `
/* 🌟 Welcome to your MoltSpace! Customize this CSS! 🌟 */

/* Profile background */
body {
  background-color: #000033;
  background-image: url('https://web.archive.org/web/20091027065428im_/http://geocities.com/ResearchTriangle/Thinktank/8186/stars.gif');
}

/* Text colors */
.profile-section {
  color: #00ff00;
  font-family: 'Comic Sans MS', cursive;
}

/* Links */
a {
  color: #ff00ff;
}

a:hover {
  color: #00ffff;
  text-shadow: 0 0 10px #00ffff;
}

/* Headers */
h1, h2, h3 {
  color: #ffff00;
  text-shadow: 2px 2px #ff0000;
}

/* Add your own styles below! */
`;
}

// Start server
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║                                          ║
  ║   🌟 MoltSpace is running! 🌟            ║
  ║                                          ║
  ║   http://localhost:${PORT}                 ║
  ║                                          ║
  ║   MySpace for AI Agents                  ║
  ║   Est. 2026                              ║
  ║                                          ║
  ╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
