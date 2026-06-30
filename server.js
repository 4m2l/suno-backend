const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// ⭐ تعريف INTERNAL_WEBHOOK
// ============================================================
const INTERNAL_WEBHOOK = `https://suno-backend-production.up.railway.app/webhook`;

// ============================================================
// ⭐ نقاط النهاية التي تحتاج callBackUrl
// ============================================================
const endpointsWithCallback = [
    'generate',
    'generate/extend',
    'generate/upload-cover',
    'generate/upload-extend',
    'generate/add-instrumental',
    'generate/add-vocals',
    'generate/sounds',
    'generate/replace-section',
    'generate/generate-persona',
    'generate/get-timestamped-lyrics',
    'mp4/generate',
    'lyrics',
    'style/generate',
    'suno/cover/generate',
    'wav/generate',
    'midi/generate',
    'vocal-removal/generate'
];

// ============================================================
// إعدادات CORS
// ============================================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));

// ============================================================
// إعدادات
// ============================================================
const CONFIG = {
    DATA_FILE: path.join(__dirname, 'data.json'),
    MAX_SONGS_PER_USER: 1000
};

// ============================================================
// قاعدة البيانات
// ============================================================
class Database {
    constructor() {
        this.data = { users: [], songs: [], sharedSongs: [], comments: [], likes: [], auditLogs: [] };
        this.load();
    }
    load() {
        try {
            if (fs.existsSync(CONFIG.DATA_FILE)) {
                this.data = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
                console.log('📂 تم تحميل البيانات');
            }
        } catch (e) { console.error('⚠️ خطأ في تحميل البيانات:', e.message); }
    }
    save() {
        try {
            fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(this.data, null, 2));
        } catch (e) { console.error('❌ خطأ في حفظ البيانات:', e.message); }
    }
    get users() { return this.data.users; }
    set users(v) { this.data.users = v; this.save(); }
    get songs() { return this.data.songs; }
    set songs(v) { this.data.songs = v; this.save(); }
    get sharedSongs() { return this.data.sharedSongs; }
    set sharedSongs(v) { this.data.sharedSongs = v; this.save(); }
    get comments() { return this.data.comments; }
    set comments(v) { this.data.comments = v; this.save(); }
    get likes() { return this.data.likes; }
    set likes(v) { this.data.likes = v; this.save(); }
    get auditLogs() { return this.data.auditLogs; }
    set auditLogs(v) { this.data.auditLogs = v; this.save(); }
    addAuditLog(action, userId, details) {
        this.auditLogs.push({
            id: crypto.randomBytes(8).toString('hex'),
            userId: userId || 'system',
            action,
            details,
            timestamp: new Date().toISOString()
        });
        if (this.auditLogs.length > 1000) this.auditLogs = this.auditLogs.slice(-1000);
        this.save();
    }
}

const db = new Database();

// ============================================================
// دوال مساعدة
// ============================================================
function hashPassword(p) { return crypto.createHash('sha256').update(p).digest('hex'); }
function generateToken() { return 'sk-' + crypto.randomBytes(32).toString('hex'); }
function findUserByEmail(email) { return db.users.find(u => u.email.toLowerCase() === email.toLowerCase()); }
function findUserById(id) { return db.users.find(u => u.id === id); }
function findUserByToken(token) { return db.users.find(u => u.apiKey === token); }
function findSongById(id) { return db.songs.find(s => s.id === id); }
function findSharedSongById(id) { return db.sharedSongs.find(s => s.id === id); }

// ============================================================
// Middleware للمصادقة
// ============================================================
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.substring(7);
    const user = findUserByToken(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
}

// ============================================================
// إنشاء Admin
// ============================================================
if (!db.users.find(u => u.username === 'admin')) {
    const admin = {
        id: 'admin-' + crypto.randomBytes(4).toString('hex'),
        username: 'admin',
        email: 'admin@example.com',
        password: hashPassword('admin123'),
        apiKey: generateToken(),
        createdAt: new Date().toISOString(),
        totalSongs: 0,
        isActive: true,
        role: 'admin'
    };
    db.users.push(admin);
    db.save();
    console.log('👑 Admin created: admin@example.com / admin123');
}

// ============================================================
// نقاط نهاية المصادقة (نفسها بدون تغيير)
// ============================================================
app.post('/api/auth/login', (req, res) => {
    try {
        const { email, password } = req.body;
        const user = findUserByEmail(email);
        if (!user || user.password !== hashPassword(password)) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        const token = generateToken();
        user.apiKey = token;
        user.lastLogin = new Date().toISOString();
        db.save();
        db.addAuditLog('user_login', user.id, { email: user.email });
        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                totalSongs: user.totalSongs || 0,
                apiKey: token
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/register', (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        if (findUserByEmail(email)) return res.status(409).json({ error: 'Email already exists' });
        const newUser = {
            id: 'user-' + Date.now(),
            username,
            email: email.toLowerCase(),
            password: hashPassword(password),
            apiKey: generateToken(),
            createdAt: new Date().toISOString(),
            totalSongs: 0,
            isActive: true,
            role: 'user'
        };
        db.users.push(newUser);
        db.save();
        db.addAuditLog('user_registered', newUser.id, { email: newUser.email });
        res.status(201).json({
            success: true,
            message: 'Account created',
            user: { id: newUser.id, username: newUser.username, email: newUser.email, apiKey: newUser.apiKey }
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.get('/api/users/me', authMiddleware, (req, res) => {
    const user = req.user;
    res.json({ id: user.id, username: user.username, email: user.email, totalSongs: user.totalSongs || 0, createdAt: user.createdAt });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
    try {
        const user = req.user;
        user.apiKey = null;
        db.save();
        db.addAuditLog('user_logout', user.id, { email: user.email });
        res.json({ success: true, message: 'Logged out' });
    } catch (error) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

// ============================================================
// نقاط نهاية الأغاني (خاصة بالمستخدم) - نفسها بدون تغيير
// ============================================================
function getUserSongs(userId) {
    return db.songs.filter(s => s.userId === userId);
}

app.get('/api/songs', authMiddleware, (req, res) => {
    try {
        const userSongs = getUserSongs(req.user.id);
        console.log(`📥 جلب أغاني المستخدم ${req.user.id}: ${userSongs.length} أغنية`);
        res.json({ total: userSongs.length, data: userSongs });
    } catch (error) {
        console.error('Error fetching songs:', error);
        res.status(500).json({ error: 'Failed to fetch songs' });
    }
});

app.get('/songs-debug', (req, res) => {
    try {
        res.json({
            total: db.songs.length,
            data: db.songs.map(s => ({ id: s.id, userId: s.userId, title: s.title, audioUrl: s.audioUrl, status: s.status, videoUrl: s.videoUrl, taskId: s.taskId, audioId: s.audioId, wavUrl: s.wavUrl, midiUrl: s.midiUrl, lyrics: s.lyrics }))
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/songs/user/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const userSongs = getUserSongs(userId);
        res.json({ total: userSongs.length, data: userSongs });
    } catch (error) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/songs', authMiddleware, (req, res) => {
    try {
        const { title, style, audioUrl, downloadUrl, imageUrl, prompt, duration, taskId, audioId } = req.body;
        if (!title || !audioUrl) return res.status(400).json({ error: 'Title and audio URL are required' });
        const song = {
            id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
            userId: req.user.id,
            taskId: taskId || 'task-' + Date.now(),
            audioId: audioId || 'audio-' + Date.now(),
            title,
            style: style || '',
            audioUrl,
            downloadUrl: downloadUrl || audioUrl,
            imageUrl: imageUrl || null,
            prompt: prompt || '',
            duration: duration || null,
            videoUrl: null,
            status: 'success',
            isShared: false,
            likes: 0,
            commentsCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lyrics: null,
            instrumentalUrl: null,
            vocalsUrl: null,
            wavUrl: null,
            midiUrl: null
        };
        db.songs.push(song);
        req.user.totalSongs = (req.user.totalSongs || 0) + 1;
        db.save();
        db.addAuditLog('song_created', req.user.id, { title: song.title });
        res.status(201).json({ success: true, song });
    } catch (error) {
        console.error('Error creating song:', error);
        res.status(500).json({ error: 'Failed to create song' });
    }
});

app.delete('/api/songs/:songId', authMiddleware, (req, res) => {
    try {
        const songId = req.params.songId;
        const index = db.songs.findIndex(s => s.id === songId && s.userId === req.user.id);
        if (index === -1) return res.status(404).json({ error: 'Song not found' });
        const deleted = db.songs.splice(index, 1)[0];
        req.user.totalSongs = (req.user.totalSongs || 1) - 1;
        db.save();
        db.sharedSongs = db.sharedSongs.filter(s => s.songId !== songId);
        db.comments = db.comments.filter(c => c.songId !== songId);
        db.likes = db.likes.filter(l => l.songId !== songId);
        db.save();
        db.addAuditLog('song_deleted', req.user.id, { title: deleted.title });
        res.json({ success: true, message: 'Song deleted' });
    } catch (error) {
        console.error('Error deleting song:', error);
        res.status(500).json({ error: 'Failed to delete song' });
    }
});

app.put('/api/songs/:songId', authMiddleware, (req, res) => {
    try {
        const songId = req.params.songId;
        const song = findSongById(songId);
        if (!song || song.userId !== req.user.id) return res.status(404).json({ error: 'Song not found' });
        const { title, style, prompt, isShared, audioUrl, downloadUrl, imageUrl, duration, status, videoUrl, lyrics, instrumentalUrl, vocalsUrl, wavUrl, midiUrl } = req.body;
        if (title) song.title = title;
        if (style) song.style = style;
        if (prompt) song.prompt = prompt;
        if (isShared !== undefined) song.isShared = isShared;
        if (audioUrl) { song.audioUrl = audioUrl; song.downloadUrl = audioUrl; song.status = 'success'; }
        if (downloadUrl) song.downloadUrl = downloadUrl;
        if (imageUrl) song.imageUrl = imageUrl;
        if (duration) song.duration = duration;
        if (status) song.status = status;
        if (videoUrl) song.videoUrl = videoUrl;
        if (lyrics) song.lyrics = lyrics;
        if (instrumentalUrl) song.instrumentalUrl = instrumentalUrl;
        if (vocalsUrl) song.vocalsUrl = vocalsUrl;
        if (wavUrl) song.wavUrl = wavUrl;
        if (midiUrl) song.midiUrl = midiUrl;
        song.updatedAt = new Date().toISOString();
        db.save();
        db.addAuditLog('song_updated', req.user.id, { title: song.title });
        res.json({ success: true, song });
    } catch (error) {
        console.error('Error updating song:', error);
        res.status(500).json({ error: 'Failed to update song' });
    }
});

app.post('/api/songs/update/:songId', authMiddleware, (req, res) => {
    try {
        const songId = req.params.songId;
        const song = findSongById(songId);
        if (!song || song.userId !== req.user.id) return res.status(404).json({ error: 'Song not found' });
        const { audioUrl, downloadUrl, imageUrl, duration, status, videoUrl, lyrics, instrumentalUrl, vocalsUrl, wavUrl, midiUrl } = req.body;
        let updated = false;
        if (audioUrl && audioUrl.startsWith('https://')) {
            song.audioUrl = audioUrl;
            song.downloadUrl = audioUrl;
            song.status = 'success';
            updated = true;
        }
        if (downloadUrl) song.downloadUrl = downloadUrl;
        if (imageUrl) song.imageUrl = imageUrl;
        if (duration) song.duration = duration;
        if (status) song.status = status;
        if (videoUrl) { song.videoUrl = videoUrl; updated = true; }
        if (lyrics) { song.lyrics = lyrics; updated = true; }
        if (instrumentalUrl) { song.instrumentalUrl = instrumentalUrl; updated = true; }
        if (vocalsUrl) { song.vocalsUrl = vocalsUrl; updated = true; }
        if (wavUrl) { song.wavUrl = wavUrl; updated = true; }
        if (midiUrl) { song.midiUrl = midiUrl; updated = true; }
        if (updated) {
            song.updatedAt = new Date().toISOString();
            db.save();
            db.addAuditLog('song_updated_manually', req.user.id, { title: song.title });
            res.json({ success: true, message: 'Song updated', song });
        } else {
            res.json({ success: false, message: 'No valid data provided' });
        }
    } catch (error) {
        console.error('Error updating song manually:', error);
        res.status(500).json({ error: 'Failed to update song' });
    }
});

app.post('/api/songs/:songId/share', authMiddleware, (req, res) => {
    try {
        const songId = req.params.songId;
        const song = findSongById(songId);
        if (!song || song.userId !== req.user.id) return res.status(404).json({ error: 'Song not found' });
        if (db.sharedSongs.find(s => s.songId === songId)) {
            return res.status(400).json({ error: 'Already shared' });
        }
        const shared = {
            id: 'shared-' + Date.now(),
            songId: song.id,
            userId: req.user.id,
            username: req.user.username,
            title: song.title,
            style: song.style,
            audioUrl: song.audioUrl,
            downloadUrl: song.downloadUrl,
            imageUrl: song.imageUrl,
            duration: song.duration,
            videoUrl: song.videoUrl,
            likes: 0,
            commentsCount: 0,
            sharedAt: new Date().toISOString()
        };
        db.sharedSongs.push(shared);
        song.isShared = true;
        db.save();
        db.addAuditLog('song_shared', req.user.id, { title: song.title });
        res.json({ success: true, shared });
    } catch (error) {
        console.error('Error sharing song:', error);
        res.status(500).json({ error: 'Failed to share song' });
    }
});

app.delete('/api/songs/:songId/share', authMiddleware, (req, res) => {
    try {
        const songId = req.params.songId;
        const song = findSongById(songId);
        if (!song || song.userId !== req.user.id) return res.status(404).json({ error: 'Song not found' });
        db.sharedSongs = db.sharedSongs.filter(s => s.songId !== songId);
        song.isShared = false;
        db.save();
        db.addAuditLog('song_unshared', req.user.id, { songId });
        res.json({ success: true, message: 'Unshared' });
    } catch (error) {
        console.error('Error unsharing song:', error);
        res.status(500).json({ error: 'Failed to unshare song' });
    }
});

// ============================================================
// الأغاني المشتركة (عامة)
// ============================================================
app.get('/api/shared-songs', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const shared = db.sharedSongs
            .sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt))
            .slice(0, limit);
        const result = shared.map(s => {
            const likes = db.likes.filter(l => l.sharedSongId === s.id).length;
            const comments = db.comments.filter(c => c.sharedSongId === s.id).length;
            return { ...s, likes, commentsCount: comments, userLiked: false };
        });
        res.json({ total: db.sharedSongs.length, data: result });
    } catch (error) {
        console.error('Error fetching shared songs:', error);
        res.status(500).json({ error: 'Failed to fetch shared songs' });
    }
});

app.get('/api/users/:userId/songs', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = findUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const userSongs = db.songs.filter(s => s.userId === userId && s.isShared === true);
        res.json({ username: user.username, total: userSongs.length, data: userSongs });
    } catch (error) {
        console.error('Error fetching user songs:', error);
        res.status(500).json({ error: 'Failed to fetch user songs' });
    }
});

// ============================================================
// الإعجابات والتعليقات
// ============================================================
app.post('/api/shared-songs/:sharedId/like', authMiddleware, (req, res) => {
    try {
        const sharedId = req.params.sharedId;
        const shared = findSharedSongById(sharedId);
        if (!shared) return res.status(404).json({ error: 'Shared song not found' });
        if (db.likes.find(l => l.sharedSongId === sharedId && l.userId === req.user.id)) {
            return res.status(400).json({ error: 'Already liked' });
        }
        const like = { id: 'like-' + Date.now(), sharedSongId: sharedId, userId: req.user.id, username: req.user.username, createdAt: new Date().toISOString() };
        db.likes.push(like);
        shared.likes = (shared.likes || 0) + 1;
        db.save();
        db.addAuditLog('song_liked', req.user.id, { sharedId });
        res.json({ success: true, likes: shared.likes });
    } catch (error) {
        console.error('Error liking song:', error);
        res.status(500).json({ error: 'Failed to like song' });
    }
});

app.delete('/api/shared-songs/:sharedId/like', authMiddleware, (req, res) => {
    try {
        const sharedId = req.params.sharedId;
        const shared = findSharedSongById(sharedId);
        if (!shared) return res.status(404).json({ error: 'Shared song not found' });
        const index = db.likes.findIndex(l => l.sharedSongId === sharedId && l.userId === req.user.id);
        if (index === -1) return res.status(400).json({ error: 'Not liked' });
        db.likes.splice(index, 1);
        shared.likes = (shared.likes || 1) - 1;
        db.save();
        db.addAuditLog('song_unliked', req.user.id, { sharedId });
        res.json({ success: true, likes: shared.likes });
    } catch (error) {
        console.error('Error unliking song:', error);
        res.status(500).json({ error: 'Failed to unlike song' });
    }
});

app.post('/api/shared-songs/:sharedId/comments', authMiddleware, (req, res) => {
    try {
        const sharedId = req.params.sharedId;
        const { text } = req.body;
        if (!text || text.trim().length === 0) return res.status(400).json({ error: 'Comment text is required' });
        const shared = findSharedSongById(sharedId);
        if (!shared) return res.status(404).json({ error: 'Shared song not found' });
        const comment = { id: 'comment-' + Date.now(), sharedSongId: sharedId, userId: req.user.id, username: req.user.username, text: text.trim(), createdAt: new Date().toISOString() };
        db.comments.push(comment);
        shared.commentsCount = (shared.commentsCount || 0) + 1;
        db.save();
        db.addAuditLog('comment_added', req.user.id, { sharedId });
        res.json({ success: true, comment, commentsCount: shared.commentsCount });
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

app.get('/api/shared-songs/:sharedId/comments', (req, res) => {
    try {
        const sharedId = req.params.sharedId;
        const comments = db.comments.filter(c => c.sharedSongId === sharedId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ total: comments.length, data: comments });
    } catch (error) {
        console.error('Error fetching comments:', error);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

app.delete('/api/comments/:commentId', authMiddleware, (req, res) => {
    try {
        const commentId = req.params.commentId;
        const index = db.comments.findIndex(c => c.id === commentId && c.userId === req.user.id);
        if (index === -1) return res.status(404).json({ error: 'Comment not found' });
        const comment = db.comments[index];
        const shared = findSharedSongById(comment.sharedSongId);
        if (shared) shared.commentsCount = (shared.commentsCount || 1) - 1;
        db.comments.splice(index, 1);
        db.save();
        db.addAuditLog('comment_deleted', req.user.id, { commentId });
        res.json({ success: true, message: 'Comment deleted' });
    } catch (error) {
        console.error('Error deleting comment:', error);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// ============================================================
// الإحصائيات
// ============================================================
app.get('/api/stats', authMiddleware, (req, res) => {
    try {
        const userSongs = db.songs.filter(s => s.userId === req.user.id);
        const total = userSongs.length;
        const sharedCount = userSongs.filter(s => s.isShared).length;
        const styleCount = {};
        userSongs.forEach(s => {
            if (s.style) {
                s.style.split(',').map(st => st.trim()).forEach(st => { if (st) styleCount[st] = (styleCount[st] || 0) + 1; });
            }
        });
        const topStyles = Object.entries(styleCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([style, count]) => ({ style, count }));
        const sharedSongs = db.sharedSongs.filter(s => s.userId === req.user.id);
        const totalLikes = sharedSongs.reduce((sum, s) => sum + (s.likes || 0), 0);
        const totalComments = sharedSongs.reduce((sum, s) => sum + (s.commentsCount || 0), 0);
        res.json({
            totalSongs: total,
            sharedSongs: sharedCount,
            topStyles,
            totalLikes,
            totalComments,
            averageDuration: userSongs.filter(s => s.duration).reduce((sum, s) => sum + (s.duration || 0), 0) / (userSongs.filter(s => s.duration).length || 1)
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ============================================================
// ⭐ Webhook المحسّن (يدعم جميع أنواع الردود ويستخدم tempTaskId)
// ============================================================
app.post('/webhook', (req, res) => {
    console.log('📨 [WEBHOOK] تم استقبال طلب في', new Date().toISOString());
    console.log('📦 [WEBHOOK] كامل الجسم:', JSON.stringify(req.body, null, 2));
    console.log('🔍 [WEBHOOK] Query:', req.query);

    try {
        const body = req.body;
        const userId = req.query.userId || null;
        const tempTaskId = req.query.tempTaskId || null; // المفتاح المؤقت من Proxy
        console.log(`👤 [WEBHOOK] userId: ${userId}, tempTaskId: ${tempTaskId}`);

        let clips = [];
        let taskId = null;
        let wavUrl = null;
        let videoUrl = null;
        let instrumentalUrl = null;
        let vocalsUrl = null;

        // ============================================================
        // ⭐ الحالة 1: توليد الأغنية (data.data مصفوفة)
        // ============================================================
        if (body?.data?.data && Array.isArray(body.data.data)) {
            clips = body.data.data;
            taskId = body.data.task_id || body.task_id || null;
            console.log(`📌 [WEBHOOK] حالة توليد الأغنية: ${clips.length} مقطع`);
        }
        // ============================================================
        // ⭐ الحالة 2: تحويل إلى WAV (audio_wav_url)
        // ============================================================
        else if (body?.data?.audio_wav_url) {
            wavUrl = body.data.audio_wav_url;
            taskId = body.data.task_id || body.task_id || null;
            console.log(`🎵 [WEBHOOK] حالة WAV: ${wavUrl}`);
            
            // البحث عن السجل المعلق باستخدام tempTaskId
            let found = false;
            if (tempTaskId) {
                const pendingSong = db.songs.find(s => s.taskId === tempTaskId && s.userId === userId);
                if (pendingSong) {
                    pendingSong.wavUrl = wavUrl;
                    pendingSong.status = 'success';
                    pendingSong.updatedAt = new Date().toISOString();
                    // تحديث taskId الحقيقي
                    if (taskId) pendingSong.taskId = taskId;
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث WAV للأغنية: ${pendingSong.title} (tempTaskId: ${tempTaskId})`);
                    found = true;
                }
            }
            
            // إذا لم يتم العثور، نحاول البحث باستخدام taskId الحقيقي
            if (!found && taskId) {
                const existing = db.songs.find(s => s.taskId === taskId || s.taskId.includes(taskId) || taskId.includes(s.taskId));
                if (existing) {
                    existing.wavUrl = wavUrl;
                    existing.status = 'success';
                    existing.updatedAt = new Date().toISOString();
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث WAV للأغنية: ${existing.title} (taskId: ${taskId})`);
                    found = true;
                }
            }
            
            // إذا لم يتم العثور، ننشئ سجلاً جديداً
            if (!found) {
                const newSong = {
                    id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                    userId: userId,
                    taskId: taskId || 'wav-' + Date.now(),
                    audioId: 'wav-' + Date.now(),
                    audioUrl: null,
                    downloadUrl: null,
                    imageUrl: null,
                    title: 'تحويل WAV',
                    style: '',
                    prompt: '',
                    duration: null,
                    videoUrl: null,
                    status: 'success',
                    isShared: false,
                    likes: 0,
                    commentsCount: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lyrics: null,
                    instrumentalUrl: null,
                    vocalsUrl: null,
                    wavUrl: wavUrl,
                    midiUrl: null
                };
                db.songs.push(newSong);
                if (userId) {
                    const user = findUserById(userId);
                    if (user) user.totalSongs = (user.totalSongs || 0) + 1;
                }
                db.save();
                console.log(`✅ [WEBHOOK] تم حفظ WAV جديد: ${wavUrl}`);
            }
            
            return res.status(200).json({ received: true, saved: 1, type: 'wav' });
        }
        // ============================================================
        // ⭐ الحالة 3: إنشاء فيديو (video_url)
        // ============================================================
        else if (body?.data?.video_url) {
            videoUrl = body.data.video_url;
            taskId = body.data.task_id || body.task_id || null;
            console.log(`🎬 [WEBHOOK] حالة فيديو: ${videoUrl}`);
            
            let found = false;
            if (tempTaskId) {
                const pendingSong = db.songs.find(s => s.taskId === tempTaskId && s.userId === userId);
                if (pendingSong) {
                    pendingSong.videoUrl = videoUrl;
                    pendingSong.status = 'success';
                    pendingSong.updatedAt = new Date().toISOString();
                    if (taskId) pendingSong.taskId = taskId;
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث الفيديو للأغنية: ${pendingSong.title} (tempTaskId: ${tempTaskId})`);
                    found = true;
                }
            }
            
            if (!found && taskId) {
                const existing = db.songs.find(s => s.taskId === taskId || s.taskId.includes(taskId) || taskId.includes(s.taskId));
                if (existing) {
                    existing.videoUrl = videoUrl;
                    existing.status = 'success';
                    existing.updatedAt = new Date().toISOString();
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث الفيديو للأغنية: ${existing.title} (taskId: ${taskId})`);
                    found = true;
                }
            }
            
            if (!found) {
                const newSong = {
                    id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                    userId: userId,
                    taskId: taskId || 'video-' + Date.now(),
                    audioId: 'video-' + Date.now(),
                    audioUrl: null,
                    downloadUrl: null,
                    imageUrl: null,
                    title: 'فيديو موسيقي',
                    style: '',
                    prompt: '',
                    duration: null,
                    videoUrl: videoUrl,
                    status: 'success',
                    isShared: false,
                    likes: 0,
                    commentsCount: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lyrics: null,
                    instrumentalUrl: null,
                    vocalsUrl: null,
                    wavUrl: null,
                    midiUrl: null
                };
                db.songs.push(newSong);
                if (userId) {
                    const user = findUserById(userId);
                    if (user) user.totalSongs = (user.totalSongs || 0) + 1;
                }
                db.save();
                console.log(`✅ [WEBHOOK] تم حفظ فيديو جديد: ${videoUrl}`);
            }
            
            return res.status(200).json({ received: true, saved: 1, type: 'video' });
        }
        // ============================================================
        // ⭐ الحالة 4: فصل الصوت (vocal-removal) - قد يحتوي على instrumentals و vocals
        // ============================================================
        else if (body?.data?.vocal_removal_info) {
            const removalData = body.data.vocal_removal_info;
            // قد يكون الهيكل مختلفاً حسب الرد
            const audioUrl = body.data.audio_url || null;
            const instrumental = body.data.instrumental_url || null;
            const vocal = body.data.vocal_url || null;
            taskId = body.data.task_id || body.task_id || null;
            
            console.log(`🎤 [WEBHOOK] حالة فصل الصوت: audio=${audioUrl}, instrumental=${instrumental}, vocal=${vocal}`);
            
            // البحث عن السجل المعلق
            let found = false;
            if (tempTaskId) {
                const pendingSong = db.songs.find(s => s.taskId === tempTaskId && s.userId === userId);
                if (pendingSong) {
                    if (instrumental) pendingSong.instrumentalUrl = instrumental;
                    if (vocal) pendingSong.vocalsUrl = vocal;
                    if (audioUrl) pendingSong.audioUrl = audioUrl;
                    pendingSong.status = 'success';
                    pendingSong.updatedAt = new Date().toISOString();
                    if (taskId) pendingSong.taskId = taskId;
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث فصل الصوت للأغنية: ${pendingSong.title} (tempTaskId: ${tempTaskId})`);
                    found = true;
                }
            }
            
            if (!found && taskId) {
                const existing = db.songs.find(s => s.taskId === taskId || s.taskId.includes(taskId) || taskId.includes(s.taskId));
                if (existing) {
                    if (instrumental) existing.instrumentalUrl = instrumental;
                    if (vocal) existing.vocalsUrl = vocal;
                    if (audioUrl) existing.audioUrl = audioUrl;
                    existing.status = 'success';
                    existing.updatedAt = new Date().toISOString();
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث فصل الصوت للأغنية: ${existing.title} (taskId: ${taskId})`);
                    found = true;
                }
            }
            
            if (!found) {
                // إنشاء سجل جديد
                const newSong = {
                    id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                    userId: userId,
                    taskId: taskId || 'vocal-removal-' + Date.now(),
                    audioId: 'vocal-removal-' + Date.now(),
                    audioUrl: audioUrl || null,
                    downloadUrl: audioUrl || null,
                    imageUrl: null,
                    title: 'فصل الصوت',
                    style: '',
                    prompt: '',
                    duration: null,
                    videoUrl: null,
                    status: 'success',
                    isShared: false,
                    likes: 0,
                    commentsCount: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lyrics: null,
                    instrumentalUrl: instrumental || null,
                    vocalsUrl: vocal || null,
                    wavUrl: null,
                    midiUrl: null
                };
                db.songs.push(newSong);
                if (userId) {
                    const user = findUserById(userId);
                    if (user) user.totalSongs = (user.totalSongs || 0) + 1;
                }
                db.save();
                console.log(`✅ [WEBHOOK] تم حفظ فصل الصوت جديد`);
            }
            
            return res.status(200).json({ received: true, saved: 1, type: 'vocal-removal' });
        }
        // ============================================================
        // ⭐ الحالة 5: بيانات أخرى (محاولة البحث العام)
        // ============================================================
        else {
            // البحث عن أي رابط في البيانات
            if (body?.data) {
                const dataObj = body.data;
                for (const key in dataObj) {
                    const value = dataObj[key];
                    if (typeof value === 'string' && value.startsWith('https://') && (value.includes('.wav') || value.includes('.mp4') || value.includes('.mp3'))) {
                        console.log(`🔍 [WEBHOOK] وجدت رابط في المفتاح: ${key} -> ${value}`);
                        if (key.includes('wav') || key === 'audio_wav_url') {
                            wavUrl = value;
                        } else if (key.includes('video') || key === 'video_url') {
                            videoUrl = value;
                        } else if (key.includes('instrumental')) {
                            instrumentalUrl = value;
                        } else if (key.includes('vocal')) {
                            vocalsUrl = value;
                        }
                    }
                }
            }
            
            if (wavUrl || videoUrl || instrumentalUrl || vocalsUrl) {
                // محاولة تحديث السجل المعلق
                let found = false;
                if (tempTaskId) {
                    const pendingSong = db.songs.find(s => s.taskId === tempTaskId && s.userId === userId);
                    if (pendingSong) {
                        if (wavUrl) pendingSong.wavUrl = wavUrl;
                        if (videoUrl) pendingSong.videoUrl = videoUrl;
                        if (instrumentalUrl) pendingSong.instrumentalUrl = instrumentalUrl;
                        if (vocalsUrl) pendingSong.vocalsUrl = vocalsUrl;
                        pendingSong.status = 'success';
                        pendingSong.updatedAt = new Date().toISOString();
                        if (taskId) pendingSong.taskId = taskId;
                        db.save();
                        console.log(`✅ [WEBHOOK] تم تحديث السجل المعلق (tempTaskId: ${tempTaskId})`);
                        found = true;
                    }
                }
                if (!found && taskId) {
                    const existing = db.songs.find(s => s.taskId === taskId || s.taskId.includes(taskId) || taskId.includes(s.taskId));
                    if (existing) {
                        if (wavUrl) existing.wavUrl = wavUrl;
                        if (videoUrl) existing.videoUrl = videoUrl;
                        if (instrumentalUrl) existing.instrumentalUrl = instrumentalUrl;
                        if (vocalsUrl) existing.vocalsUrl = vocalsUrl;
                        existing.status = 'success';
                        existing.updatedAt = new Date().toISOString();
                        db.save();
                        console.log(`✅ [WEBHOOK] تم تحديث السجل المعلق (taskId: ${taskId})`);
                        found = true;
                    }
                }
                if (!found) {
                    // إنشاء سجل جديد
                    const newSong = {
                        id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                        userId: userId,
                        taskId: taskId || 'unknown-' + Date.now(),
                        audioId: 'unknown-' + Date.now(),
                        audioUrl: null,
                        downloadUrl: null,
                        imageUrl: null,
                        title: 'عملية غير معروفة',
                        style: '',
                        prompt: '',
                        duration: null,
                        videoUrl: videoUrl || null,
                        status: 'success',
                        isShared: false,
                        likes: 0,
                        commentsCount: 0,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        lyrics: null,
                        instrumentalUrl: instrumentalUrl || null,
                        vocalsUrl: vocalsUrl || null,
                        wavUrl: wavUrl || null,
                        midiUrl: null
                    };
                    db.songs.push(newSong);
                    if (userId) {
                        const user = findUserById(userId);
                        if (user) user.totalSongs = (user.totalSongs || 0) + 1;
                    }
                    db.save();
                    console.log(`✅ [WEBHOOK] تم حفظ سجل جديد`);
                }
                return res.status(200).json({ received: true, saved: 1 });
            }
            
            console.warn('⚠️ [WEBHOOK] لم يتم العثور على مقاطع أو روابط');
            return res.status(200).json({ received: true, error: 'No clips or links found' });
        }

        // ============================================================
        // معالجة الحالة 1 (توليد الأغنية) - المتابعة من هنا
        // ============================================================
        if (clips.length === 0) {
            console.warn('⚠️ [WEBHOOK] لم يتم العثور على مقاطع');
            return res.status(200).json({ received: true, error: 'No clips found' });
        }

        console.log(`🎵 [WEBHOOK] عدد المقاطع: ${clips.length}`);
        let savedCount = 0;
        let updatedCount = 0;

        clips.forEach((clip, index) => {
            const audioUrl = clip.audio_url || clip.audioUrl || clip.url || clip.downloadUrl || clip.streamUrl || null;
            const videoUrl = clip.video_url || clip.videoUrl || clip.mp4_url || clip.mp4Url || clip.video || null;
            const imageUrl = clip.image_url || clip.imageUrl || clip.coverUrl || clip.cover_url || null;
            const title = clip.title || clip.name || clip.songName || clip.song_title || `مقطع ${index + 1}`;
            const style = clip.tags || clip.style || clip.genre || '';
            const duration = clip.duration || clip.duration_sec || clip.duration_ms ? clip.duration_ms / 1000 : null;
            const prompt = clip.prompt || clip.lyrics || clip.text || '';
            const audioId = clip.id || clip.audioId || clip.clip_id || clip.audio_id || `clip-${index}`;
            const clipTaskId = clip.task_id || clip.taskId || taskId || `unknown-${Date.now()}`;
            const lyrics = clip.lyrics || clip.text || null;
            const instrumentalUrl = clip.instrumental_url || clip.instrumentalUrl || null;
            const vocalsUrl = clip.vocals_url || clip.vocalsUrl || null;
            const wavUrl = clip.wav_url || clip.wavUrl || null;
            const midiUrl = clip.midi_url || clip.midiUrl || null;

            console.log(`🔄 [WEBHOOK] المقطع ${index + 1}:`);
            console.log(`   - العنوان: ${title}`);
            console.log(`   - الصوت: ${audioUrl ? '✅' : '❌'}`);
            console.log(`   - الفيديو: ${videoUrl ? '✅' : '❌'}`);
            console.log(`   - الصورة: ${imageUrl ? '✅' : '❌'}`);

            // محاولة العثور على السجل المعلق باستخدام tempTaskId أو taskId
            let existingSong = null;
            if (tempTaskId) {
                existingSong = db.songs.find(s => s.taskId === tempTaskId && s.userId === userId);
            }
            if (!existingSong) {
                existingSong = db.songs.find(s => s.taskId === clipTaskId && s.audioId === audioId);
            }
            if (!existingSong) {
                existingSong = db.songs.find(s => s.taskId === clipTaskId || s.taskId === taskId);
            }

            if (existingSong) {
                let updated = false;
                if (audioUrl && !existingSong.audioUrl) {
                    existingSong.audioUrl = audioUrl;
                    existingSong.downloadUrl = audioUrl;
                    existingSong.status = 'success';
                    updated = true;
                }
                if (videoUrl && !existingSong.videoUrl) {
                    existingSong.videoUrl = videoUrl;
                    updated = true;
                    console.log(`🎬 [WEBHOOK] تم تحديث الفيديو: ${videoUrl}`);
                }
                if (lyrics && !existingSong.lyrics) {
                    existingSong.lyrics = lyrics;
                    updated = true;
                }
                if (instrumentalUrl && !existingSong.instrumentalUrl) {
                    existingSong.instrumentalUrl = instrumentalUrl;
                    updated = true;
                }
                if (vocalsUrl && !existingSong.vocalsUrl) {
                    existingSong.vocalsUrl = vocalsUrl;
                    updated = true;
                }
                if (wavUrl && !existingSong.wavUrl) {
                    existingSong.wavUrl = wavUrl;
                    updated = true;
                }
                if (midiUrl && !existingSong.midiUrl) {
                    existingSong.midiUrl = midiUrl;
                    updated = true;
                }
                if (imageUrl && !existingSong.imageUrl) {
                    existingSong.imageUrl = imageUrl;
                    updated = true;
                }
                if (duration && !existingSong.duration) {
                    existingSong.duration = duration;
                    updated = true;
                }
                if (title && !existingSong.title) {
                    existingSong.title = title;
                    updated = true;
                }
                if (style && !existingSong.style) {
                    existingSong.style = style;
                    updated = true;
                }
                if (updated) {
                    existingSong.updatedAt = new Date().toISOString();
                    // تحديث taskId إذا كان مختلفاً
                    if (clipTaskId && !existingSong.taskId.startsWith('temp-') && existingSong.taskId !== clipTaskId) {
                        existingSong.taskId = clipTaskId;
                    }
                    updatedCount++;
                    console.log(`🔄 [WEBHOOK] تم تحديث الأغنية: "${existingSong.title}"`);
                }
            } else {
                const song = {
                    id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                    userId: userId,
                    taskId: clipTaskId,
                    audioId: audioId,
                    audioUrl: audioUrl,
                    downloadUrl: audioUrl || null,
                    imageUrl: imageUrl || null,
                    title: title || 'بدون عنوان',
                    style: style || '',
                    prompt: prompt || '',
                    duration: duration || null,
                    videoUrl: videoUrl || null,
                    status: audioUrl ? 'success' : 'pending',
                    isShared: false,
                    likes: 0,
                    commentsCount: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lyrics: lyrics || null,
                    instrumentalUrl: instrumentalUrl || null,
                    vocalsUrl: vocalsUrl || null,
                    wavUrl: wavUrl || null,
                    midiUrl: midiUrl || null
                };
                db.songs.push(song);
                savedCount++;
                if (userId) {
                    const user = findUserById(userId);
                    if (user) {
                        user.totalSongs = (user.totalSongs || 0) + 1;
                        console.log(`✅ [WEBHOOK] تم تحديث عدد أغاني المستخدم ${user.username} إلى ${user.totalSongs}`);
                    }
                }
                console.log(`✅ [WEBHOOK] تم حفظ الأغنية الجديدة: "${song.title}" (فيديو: ${videoUrl ? '✅' : '❌'})`);
            }
        });

        db.save();
        console.log(`💾 [WEBHOOK] حفظ ${savedCount} جديدة وتحديث ${updatedCount}`);
        return res.status(200).json({ received: true, saved: savedCount, updated: updatedCount });

    } catch (error) {
        console.error('❌ [WEBHOOK] خطأ:', error);
        res.status(500).json({ error: 'Webhook processing failed', details: error.message });
    }
});

// ============================================================
// ⭐⭐⭐ PROXY FOR SUNO API (مع إضافة tempTaskId إلى callBackUrl)
// ============================================================
app.post('/api/proxy/suno/*', authMiddleware, async (req, res) => {
    try {
        const endpoint = req.params[0] || req.path.replace('/api/proxy/suno/', '');
        const apiKey = req.body.apiKey || req.headers['x-api-key'];
        if (!apiKey) {
            return res.status(400).json({ error: 'API Key required' });
        }

        const { apiKey: _, ...payload } = req.body;

        // إنشاء معرف مؤقت لربط السجل المعلق
        const tempTaskId = `temp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        if (endpointsWithCallback.includes(endpoint)) {
            // إضافة tempTaskId إلى callBackUrl
            payload.callBackUrl = `${INTERNAL_WEBHOOK}?userId=${req.user.id}&tempTaskId=${tempTaskId}`;
        }

        const sunoUrl = `https://api.sunoapi.org/api/v1/${endpoint}`;
        console.log(`🔄 Proxy to Suno: ${sunoUrl}`);
        console.log('📦 Payload:', JSON.stringify(payload, null, 2));
        console.log(`🔑 tempTaskId: ${tempTaskId}`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(sunoUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeout);

        let data = null;
        let responseText = await response.text();
        try { data = JSON.parse(responseText); } catch (e) { data = { raw: responseText }; }

        console.log(`📊 Proxy response status: ${response.status}`);

        // إذا كانت الاستجابة ناجحة، نحاول حفظ النتيجة فوراً أو إنشاء سجل معلق
        if (response.ok) {
            let clips = [];
            let taskId = data.task_id || data.data?.task_id || null;

            // محاولة استخراج المقاطع
            if (data?.data?.data && Array.isArray(data.data.data)) {
                clips = data.data.data;
                taskId = data.data.task_id || data.task_id || taskId;
            } else if (data?.data && Array.isArray(data.data)) {
                clips = data.data;
            } else if (data?.clips && Array.isArray(data.clips)) {
                clips = data.clips;
            } else if (data?.data?.audio_url || data?.data?.video_url) {
                clips = [data.data];
            } else if (data?.audio_url || data?.video_url) {
                clips = [data];
            }

            if (clips.length > 0) {
                console.log(`✅ Proxy: استقبال ${clips.length} مقطع جديد (حفظ فوري)`);
                let savedCount = 0;
                clips.forEach(clip => {
                    const audioUrl = clip.audio_url || clip.audioUrl || clip.url || null;
                    const videoUrl = clip.video_url || clip.videoUrl || clip.mp4_url || clip.mp4Url || null;
                    const audioId = clip.id || clip.audioId || `clip-${Date.now()}`;
                    const clipTaskId = clip.task_id || clip.taskId || taskId || `task-${Date.now()}`;

                    const existing = db.songs.some(s => s.taskId === clipTaskId && s.audioId === audioId);
                    if (!existing && (audioUrl || videoUrl)) {
                        const song = {
                            id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                            userId: req.user.id,
                            taskId: clipTaskId,
                            audioId: audioId,
                            audioUrl: audioUrl,
                            downloadUrl: clip.audio_url || clip.audioUrl || audioUrl,
                            imageUrl: clip.image_url || clip.imageUrl || null,
                            title: clip.title || clip.name || 'بدون عنوان',
                            style: clip.tags || clip.style || clip.genre || '',
                            prompt: clip.prompt || clip.lyrics || '',
                            duration: clip.duration || null,
                            videoUrl: videoUrl,
                            status: audioUrl ? 'success' : 'pending',
                            isShared: false,
                            likes: 0,
                            commentsCount: 0,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            lyrics: clip.lyrics || null,
                            instrumentalUrl: clip.instrumental_url || clip.instrumentalUrl || null,
                            vocalsUrl: clip.vocals_url || clip.vocalsUrl || null,
                            wavUrl: clip.wav_url || clip.wavUrl || null,
                            midiUrl: clip.midi_url || clip.midiUrl || null
                        };
                        db.songs.push(song);
                        const user = findUserById(req.user.id);
                        if (user) user.totalSongs = (user.totalSongs || 0) + 1;
                        savedCount++;
                        console.log(`✅ Proxy: تم حفظ الأغنية (فيديو: ${videoUrl ? '✅' : '❌'})`);
                    } else if (existing) {
                        // تحديث الأغنية الموجودة إذا كان هناك فيديو جديد
                        const existingSong = db.songs.find(s => s.taskId === clipTaskId && s.audioId === audioId);
                        if (existingSong && videoUrl && !existingSong.videoUrl) {
                            existingSong.videoUrl = videoUrl;
                            existingSong.updatedAt = new Date().toISOString();
                            db.save();
                            console.log(`🔄 Proxy: تم تحديث الفيديو للأغنية: ${existingSong.title}`);
                        }
                    }
                });
                if (savedCount > 0) db.save();
                data._saved = savedCount;
            } else {
                // إنشاء سجل معلق باستخدام tempTaskId
                const audioId = `pending-${Date.now()}`;
                const existing = db.songs.some(s => s.taskId === tempTaskId);
                if (!existing) {
                    const song = {
                        id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                        userId: req.user.id,
                        taskId: tempTaskId, // نستخدم المعرف المؤقت هنا
                        audioId: audioId,
                        audioUrl: null,
                        downloadUrl: null,
                        imageUrl: null,
                        title: `⏳ جاري المعالجة... (${endpoint})`,
                        style: '',
                        prompt: '',
                        duration: null,
                        videoUrl: null,
                        status: 'pending',
                        isShared: false,
                        likes: 0,
                        commentsCount: 0,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        lyrics: null,
                        instrumentalUrl: null,
                        vocalsUrl: null,
                        wavUrl: null,
                        midiUrl: null
                    };
                    db.songs.push(song);
                    db.save();
                    console.log(`⏳ Proxy: تم إنشاء سجل معلق للمهمة: ${tempTaskId} (${endpoint})`);
                    data._pending = true;
                }
            }
        }

        if (!response.ok) {
            res.status(response.status).json({
                error: data?.message || data?.error || 'Suno API error',
                status: response.status,
                details: data
            });
        } else {
            res.status(response.status).json(data);
        }
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).json({ 
            error: 'Proxy request failed', 
            details: error.message
        });
    }
});

app.get('/api/proxy/suno/*', authMiddleware, async (req, res) => {
    try {
        const endpoint = req.params[0] || req.path.replace('/api/proxy/suno/', '');
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) {
            return res.status(400).json({ error: 'API Key required' });
        }

        const sunoUrl = `https://api.sunoapi.org/api/v1/${endpoint}`;
        console.log(`🔄 Proxy GET to Suno: ${sunoUrl}`);

        const response = await fetch(sunoUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        let data = null;
        try { data = await response.json(); } catch (e) {}

        res.status(response.status).json(data);
    } catch (error) {
        console.error('Proxy GET error:', error);
        res.status(500).json({ error: 'Proxy request failed' });
    }
});

// ============================================================
// فحص الصحة
// ============================================================
app.get('/healthz', (req, res) => {
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        usersCount: db.users.length,
        songsCount: db.songs.length,
        sharedCount: db.sharedSongs.length,
        commentsCount: db.comments.length,
        likesCount: db.likes.length
    });
});

// ============================================================
// تشغيل الخادم
// ============================================================
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📋 Endpoints:`);
    console.log(`   🔐 POST /api/auth/login`);
    console.log(`   ✨ POST /api/auth/register`);
    console.log(`   👤 GET  /api/users/me`);
    console.log(`   🎵 GET  /api/songs (auth required)`);
    console.log(`   📨 POST /webhook (Suno callback)`);
    console.log(`   🔄 POST /api/proxy/suno/* (proxy to Suno API)`);
    console.log(`   🔄 GET  /api/proxy/suno/* (proxy GET to Suno API)`);
    console.log(`   🏠 GET  /healthz`);
    console.log(`👑 Admin: admin@example.com / admin123`);
});
