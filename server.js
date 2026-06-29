const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

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
// نظام التخزين الدائم
// ============================================================
class Database {
    constructor() {
        this.data = {
            users: [],
            songs: [],
            sharedSongs: [],
            comments: [],
            likes: [],
            auditLogs: []
        };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(CONFIG.DATA_FILE)) {
                const raw = fs.readFileSync(CONFIG.DATA_FILE, 'utf8');
                this.data = JSON.parse(raw);
                console.log('📂 تم تحميل البيانات من الملف');
            }
        } catch (e) {
            console.error('⚠️ خطأ في تحميل البيانات:', e.message);
        }
    }

    save() {
        try {
            fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error('❌ خطأ في حفظ البيانات:', e.message);
        }
    }

    get users() { return this.data.users; }
    set users(val) { this.data.users = val; this.save(); }

    get songs() { return this.data.songs; }
    set songs(val) { this.data.songs = val; this.save(); }

    get sharedSongs() { return this.data.sharedSongs; }
    set sharedSongs(val) { this.data.sharedSongs = val; this.save(); }

    get comments() { return this.data.comments; }
    set comments(val) { this.data.comments = val; this.save(); }

    get likes() { return this.data.likes; }
    set likes(val) { this.data.likes = val; this.save(); }

    get auditLogs() { return this.data.auditLogs; }
    set auditLogs(val) { this.data.auditLogs = val; this.save(); }

    addAuditLog(action, userId, details) {
        this.auditLogs.push({
            id: crypto.randomBytes(8).toString('hex'),
            userId: userId || 'system',
            action: action,
            details: details,
            timestamp: new Date().toISOString()
        });
        if (this.auditLogs.length > 1000) {
            this.auditLogs = this.auditLogs.slice(-1000);
        }
        this.save();
    }
}

const db = new Database();

// ============================================================
// دوال مساعدة
// ============================================================
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
    return 'sk-' + crypto.randomBytes(32).toString('hex');
}

function findUserByEmail(email) {
    return db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
}

function findUserById(id) {
    return db.users.find(u => u.id === id);
}

function findUserByToken(token) {
    return db.users.find(u => u.apiKey === token);
}

function findSongById(id) {
    return db.songs.find(s => s.id === id);
}

function findSharedSongById(id) {
    return db.sharedSongs.find(s => s.id === id);
}

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

    if (!user) {
        return res.status(403).json({ error: 'Invalid token' });
    }

    req.user = user;
    next();
}

// ============================================================
// إنشاء مستخدم Admin
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
    console.log('👑 تم إنشاء مستخدم Admin:');
    console.log(`   📧 Email: admin@example.com`);
    console.log(`   🔑 Password: admin123`);
}

// ============================================================
// نقاط نهاية المصادقة
// ============================================================

app.post('/api/auth/login', (req, res) => {
    try {
        const { email, password } = req.body;
        console.log('🔐 محاولة تسجيل الدخول:', email);

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = findUserByEmail(email);
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        if (user.password !== hashPassword(password)) {
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
        console.log('📝 محاولة إنشاء حساب:', username, email);

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email and password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        if (findUserByEmail(email)) {
            return res.status(409).json({ error: 'Email already exists' });
        }

        const newUser = {
            id: 'user-' + Date.now(),
            username: username,
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
            message: 'Account created successfully',
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                apiKey: newUser.apiKey
            }
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.get('/api/users/me', authMiddleware, (req, res) => {
    const user = req.user;
    res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        totalSongs: user.totalSongs || 0,
        createdAt: user.createdAt
    });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
    try {
        const user = req.user;
        user.apiKey = null;
        db.save();
        db.addAuditLog('user_logout', user.id, { email: user.email });
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

// ============================================================
// نقاط نهاية الأغاني (خاصة بالمستخدم)
// ============================================================

function getUserSongs(userId) {
    return db.songs.filter(s => s.userId === userId);
}

// المسار الرئيسي مع /api
app.get('/api/songs', authMiddleware, (req, res) => {
    try {
        const userSongs = getUserSongs(req.user.id);
        console.log(`📥 جلب أغاني المستخدم ${req.user.id}: ${userSongs.length} أغنية`);
        res.json({
            total: userSongs.length,
            data: userSongs
        });
    } catch (error) {
        console.error('Error fetching songs:', error);
        res.status(500).json({ error: 'Failed to fetch songs' });
    }
});

// المسار بدون /api (نفس السلوك)
app.get('/songs', authMiddleware, (req, res) => {
    try {
        const userSongs = getUserSongs(req.user.id);
        console.log(`📥 جلب أغاني المستخدم ${req.user.id} (بدون api): ${userSongs.length} أغنية`);
        res.json({
            total: userSongs.length,
            data: userSongs
        });
    } catch (error) {
        console.error('Error fetching songs:', error);
        res.status(500).json({ error: 'Failed to fetch songs' });
    }
});

app.post('/api/songs', authMiddleware, (req, res) => {
    try {
        const { title, style, audioUrl, downloadUrl, imageUrl, prompt, duration } = req.body;

        if (!title || !audioUrl) {
            return res.status(400).json({ error: 'Title and audio URL are required' });
        }

        const song = {
            id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
            userId: req.user.id,
            taskId: 'task-' + Date.now(),
            audioId: 'audio-' + Date.now(),
            title: title,
            style: style || '',
            audioUrl: audioUrl,
            downloadUrl: downloadUrl || audioUrl,
            imageUrl: imageUrl || null,
            prompt: prompt || '',
            duration: duration || null,
            status: 'success',
            isShared: false,
            likes: 0,
            commentsCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        db.songs.push(song);
        req.user.totalSongs = (req.user.totalSongs || 0) + 1;
        db.save();
        db.addAuditLog('song_created', req.user.id, { title: song.title });

        res.status(201).json({
            success: true,
            song: song
        });
    } catch (error) {
        console.error('Error creating song:', error);
        res.status(500).json({ error: 'Failed to create song' });
    }
});

app.delete('/api/songs/:songId', authMiddleware, (req, res) => {
    try {
        const songId = req.params.songId;
        const index = db.songs.findIndex(s => s.id === songId && s.userId === req.user.id);

        if (index === -1) {
            return res.status(404).json({ error: 'Song not found' });
        }

        const deleted = db.songs.splice(index, 1)[0];
        req.user.totalSongs = (req.user.totalSongs || 1) - 1;
        db.save();
        db.addAuditLog('song_deleted', req.user.id, { title: deleted.title });

        db.sharedSongs = db.sharedSongs.filter(s => s.songId !== songId);
        db.comments = db.comments.filter(c => c.songId !== songId);
        db.likes = db.likes.filter(l => l.songId !== songId);
        db.save();

        res.json({
            success: true,
            message: 'Song deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting song:', error);
        res.status(500).json({ error: 'Failed to delete song' });
    }
});

app.put('/api/songs/:songId', authMiddleware, (req, res) => {
    try {
        const songId = req.params.songId;
        const song = findSongById(songId);

        if (!song || song.userId !== req.user.id) {
            return res.status(404).json({ error: 'Song not found' });
        }

        const { title, style, prompt, isShared } = req.body;
        if (title) song.title = title;
        if (style) song.style = style;
        if (prompt) song.prompt = prompt;
        if (isShared !== undefined) song.isShared = isShared;
        song.updatedAt = new Date().toISOString();

        db.save();
        db.addAuditLog('song_updated', req.user.id, { title: song.title });

        res.json({
            success: true,
            song: song
        });
    } catch (error) {
        console.error('Error updating song:', error);
        res.status(500).json({ error: 'Failed to update song' });
    }
});

app.post('/api/songs/:songId/share', authMiddleware, (req, res) => {
    try {
        const songId = req.params.songId;
        const song = findSongById(songId);

        if (!song || song.userId !== req.user.id) {
            return res.status(404).json({ error: 'Song not found' });
        }

        const existing = db.sharedSongs.find(s => s.songId === songId);
        if (existing) {
            return res.status(400).json({ error: 'Song already shared' });
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
            likes: 0,
            commentsCount: 0,
            sharedAt: new Date().toISOString()
        };

        db.sharedSongs.push(shared);
        song.isShared = true;
        db.save();
        db.addAuditLog('song_shared', req.user.id, { title: song.title });

        res.json({
            success: true,
            shared: shared
        });
    } catch (error) {
        console.error('Error sharing song:', error);
        res.status(500).json({ error: 'Failed to share song' });
    }
});

app.delete('/api/songs/:songId/share', authMiddleware, (req, res) => {
    try {
        const songId = req.params.songId;
        const song = findSongById(songId);

        if (!song || song.userId !== req.user.id) {
            return res.status(404).json({ error: 'Song not found' });
        }

        db.sharedSongs = db.sharedSongs.filter(s => s.songId !== songId);
        song.isShared = false;
        db.save();
        db.addAuditLog('song_unshared', req.user.id, { songId });

        res.json({
            success: true,
            message: 'Song unshared successfully'
        });
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
            return {
                ...s,
                likes: likes,
                commentsCount: comments,
                userLiked: false
            };
        });

        res.json({
            total: db.sharedSongs.length,
            data: result
        });
    } catch (error) {
        console.error('Error fetching shared songs:', error);
        res.status(500).json({ error: 'Failed to fetch shared songs' });
    }
});

app.get('/api/users/:userId/songs', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = findUserById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userSongs = db.songs.filter(s => s.userId === userId && s.isShared === true);
        res.json({
            username: user.username,
            total: userSongs.length,
            data: userSongs
        });
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

        if (!shared) {
            return res.status(404).json({ error: 'Shared song not found' });
        }

        const existing = db.likes.find(l => l.sharedSongId === sharedId && l.userId === req.user.id);
        if (existing) {
            return res.status(400).json({ error: 'Already liked' });
        }

        const like = {
            id: 'like-' + Date.now(),
            sharedSongId: sharedId,
            userId: req.user.id,
            username: req.user.username,
            createdAt: new Date().toISOString()
        };

        db.likes.push(like);
        shared.likes = (shared.likes || 0) + 1;
        db.save();
        db.addAuditLog('song_liked', req.user.id, { sharedId });

        res.json({
            success: true,
            likes: shared.likes
        });
    } catch (error) {
        console.error('Error liking song:', error);
        res.status(500).json({ error: 'Failed to like song' });
    }
});

app.delete('/api/shared-songs/:sharedId/like', authMiddleware, (req, res) => {
    try {
        const sharedId = req.params.sharedId;
        const shared = findSharedSongById(sharedId);

        if (!shared) {
            return res.status(404).json({ error: 'Shared song not found' });
        }

        const index = db.likes.findIndex(l => l.sharedSongId === sharedId && l.userId === req.user.id);
        if (index === -1) {
            return res.status(400).json({ error: 'Not liked' });
        }

        db.likes.splice(index, 1);
        shared.likes = (shared.likes || 1) - 1;
        db.save();
        db.addAuditLog('song_unliked', req.user.id, { sharedId });

        res.json({
            success: true,
            likes: shared.likes
        });
    } catch (error) {
        console.error('Error unliking song:', error);
        res.status(500).json({ error: 'Failed to unlike song' });
    }
});

app.post('/api/shared-songs/:sharedId/comments', authMiddleware, (req, res) => {
    try {
        const sharedId = req.params.sharedId;
        const { text } = req.body;

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'Comment text is required' });
        }

        const shared = findSharedSongById(sharedId);
        if (!shared) {
            return res.status(404).json({ error: 'Shared song not found' });
        }

        const comment = {
            id: 'comment-' + Date.now(),
            sharedSongId: sharedId,
            userId: req.user.id,
            username: req.user.username,
            text: text.trim(),
            createdAt: new Date().toISOString()
        };

        db.comments.push(comment);
        shared.commentsCount = (shared.commentsCount || 0) + 1;
        db.save();
        db.addAuditLog('comment_added', req.user.id, { sharedId });

        res.json({
            success: true,
            comment: comment,
            commentsCount: shared.commentsCount
        });
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

app.get('/api/shared-songs/:sharedId/comments', (req, res) => {
    try {
        const sharedId = req.params.sharedId;
        const comments = db.comments
            .filter(c => c.sharedSongId === sharedId)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({
            total: comments.length,
            data: comments
        });
    } catch (error) {
        console.error('Error fetching comments:', error);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

app.delete('/api/comments/:commentId', authMiddleware, (req, res) => {
    try {
        const commentId = req.params.commentId;
        const index = db.comments.findIndex(c => c.id === commentId && c.userId === req.user.id);

        if (index === -1) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const comment = db.comments[index];
        const shared = findSharedSongById(comment.sharedSongId);
        if (shared) {
            shared.commentsCount = (shared.commentsCount || 1) - 1;
        }

        db.comments.splice(index, 1);
        db.save();
        db.addAuditLog('comment_deleted', req.user.id, { commentId });

        res.json({
            success: true,
            message: 'Comment deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting comment:', error);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// ============================================================
// الإحصائيات الشخصية
// ============================================================

app.get('/api/stats', authMiddleware, (req, res) => {
    try {
        const userSongs = db.songs.filter(s => s.userId === req.user.id);
        const total = userSongs.length;
        const sharedCount = userSongs.filter(s => s.isShared).length;

        const styleCount = {};
        userSongs.forEach(s => {
            if (s.style) {
                const styles = s.style.split(',').map(st => st.trim());
                styles.forEach(st => {
                    if (st) styleCount[st] = (styleCount[st] || 0) + 1;
                });
            }
        });

        const topStyles = Object.entries(styleCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([style, count]) => ({ style, count }));

        const sharedSongs = db.sharedSongs.filter(s => s.userId === req.user.id);
        const totalLikes = sharedSongs.reduce((sum, s) => sum + (s.likes || 0), 0);
        const totalComments = sharedSongs.reduce((sum, s) => sum + (s.commentsCount || 0), 0);

        res.json({
            totalSongs: total,
            sharedSongs: sharedCount,
            topStyles: topStyles,
            totalLikes: totalLikes,
            totalComments: totalComments,
            averageDuration: userSongs
                .filter(s => s.duration)
                .reduce((sum, s) => sum + (s.duration || 0), 0) / (userSongs.filter(s => s.duration).length || 1)
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ============================================================
// Webhook (مع تصحيح وسجلات مفصلة)
// ============================================================

app.post('/webhook', (req, res) => {
    console.log('📨 تم استقبال Webhook');
    console.log('📦 البايلود:', JSON.stringify(req.body, null, 2));
    
    try {
        const body = req.body;
        const userId = req.query.userId || null;
        console.log(`👤 معرف المستخدم من query: ${userId}`);

        // محاولة استخراج البيانات من عدة أماكن مختلفة في البايلود
        let clips = [];
        let taskId = null;

        // الهيكل المتوقع من Suno API غالباً: body.data.data
        if (body?.data?.data && Array.isArray(body.data.data)) {
            clips = body.data.data;
            taskId = body.data.task_id || body.task_id || null;
            console.log(`📌 استخراج من body.data.data, taskId: ${taskId}`);
        } 
        // هيكل بديل: body.data مباشرة
        else if (body?.data && Array.isArray(body.data)) {
            clips = body.data;
            taskId = body.task_id || null;
            console.log(`📌 استخراج من body.data, taskId: ${taskId}`);
        }
        // هيكل بديل: body.clips
        else if (body?.clips && Array.isArray(body.clips)) {
            clips = body.clips;
            taskId = body.task_id || null;
            console.log(`📌 استخراج من body.clips, taskId: ${taskId}`);
        }
        // هيكل بديل: الجسم نفسه مصفوفة
        else if (Array.isArray(body)) {
            clips = body;
            console.log(`📌 استخراج من الجسم الرئيسي (مصفوفة)`);
        }

        if (clips.length === 0) {
            console.log('⚠️ لم يتم العثور على أي مقاطع صوتية في البايلود');
            return res.status(200).json({ received: true, error: 'No clips found' });
        }

        console.log(`🎵 عدد المقاطع المستلمة: ${clips.length}`);
        let savedCount = 0;

        clips.forEach((clip, index) => {
            // محاولة استخراج الرابط من عدة حقول محتملة
            const audioUrl = clip.audio_url || clip.audioUrl || clip.url || clip.downloadUrl || clip.streamUrl || null;
            const imageUrl = clip.image_url || clip.imageUrl || clip.coverUrl || clip.cover_url || null;
            const title = clip.title || clip.name || clip.songName || `مقطع ${index + 1}`;
            const style = clip.tags || clip.style || clip.genre || '';
            const duration = clip.duration || clip.duration_sec || null;
            const prompt = clip.prompt || clip.lyrics || '';
            
            // استخراج المعرفات
            const audioId = clip.id || clip.audioId || clip.clip_id || `clip-${index}`;
            const clipTaskId = clip.task_id || clip.taskId || taskId || `unknown-${Date.now()}`;

            console.log(`🔄 معالجة المقطع ${index + 1}: ${title} - رابط: ${audioUrl ? 'موجود ✅' : 'غير موجود ❌'}`);

            // نحفظ الأغنية حتى لو لم يكن الرابط موجوداً (قد يأتي لاحقاً)
            // لكن نفضل أن يكون الرابط موجوداً
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
                status: audioUrl ? 'success' : 'pending', // إذا لم يكن رابط، نضعها معلقة
                isShared: false,
                likes: 0,
                commentsCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            // نتحقق من التكرار باستخدام taskId و audioId
            const exists = db.songs.some(s =>
                s.taskId === song.taskId && s.audioId === song.audioId
            );

            if (!exists) {
                db.songs.push(song);
                savedCount++;
                
                if (userId) {
                    const user = findUserById(userId);
                    if (user) {
                        user.totalSongs = (user.totalSongs || 0) + 1;
                        console.log(`✅ تم تحديث عدد أغاني المستخدم ${user.username} إلى ${user.totalSongs}`);
                    } else {
                        console.log(`⚠️ المستخدم ذو المعرف ${userId} غير موجود في قاعدة البيانات!`);
                    }
                }
                console.log(`✅ تم حفظ الأغنية: ${song.title} (الحالة: ${song.status})`);
            } else {
                console.log(`⏭️ الأغنية مكررة: ${song.title} (${song.taskId}|${song.audioId})`);
            }
        });

        db.save();
        db.addAuditLog('webhook_received', userId || 'system', { count: savedCount });

        console.log(`💾 تم حفظ ${savedCount} أغنية جديدة من أصل ${clips.length}`);
        return res.status(200).json({ received: true, saved: savedCount });

    } catch (error) {
        console.error('❌ خطأ في معالجة Webhook:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
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
    console.log(`✅ الخادم يعمل على المنفذ ${PORT}`);
    console.log(`\n📋 نقاط النهاية المتاحة:`);
    console.log(`   🔐 POST /api/auth/login           - تسجيل الدخول`);
    console.log(`   ✨ POST /api/auth/register        - إنشاء حساب`);
    console.log(`   👤 GET  /api/users/me             - معلومات المستخدم`);
    console.log(`   🎵 GET  /api/songs                - جلب أغاني المستخدم`);
    console.log(`   🎵 GET  /songs                    - جلب أغاني المستخدم (بدون api)`);
    console.log(`   🗑️ DELETE /api/songs/:id          - حذف أغنية`);
    console.log(`   ✏️ PUT  /api/songs/:id            - تحديث أغنية`);
    console.log(`   🔗 POST /api/songs/:id/share      - مشاركة أغنية`);
    console.log(`   🌐 GET  /api/shared-songs         - الأغاني المشتركة`);
    console.log(`   ❤️ POST /api/shared-songs/:id/like - إعجاب`);
    console.log(`   💬 POST /api/shared-songs/:id/comments - تعليق`);
    console.log(`   📊 GET  /api/stats                - الإحصائيات`);
    console.log(`   📨 POST /webhook                  - Webhook`);
    console.log(`   🏠 GET  /healthz                  - فحص الصحة`);
    console.log(`\n👑 Admin: admin@example.com / admin123`);
});
