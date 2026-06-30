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
// قاعدة البيانات (موسعة)
// ============================================================
class Database {
    constructor() {
        this.data = {
            users: [],
            songs: [],
            sharedSongs: [],
            comments: [],
            likes: [],
            auditLogs: [],
            follows: [],
            notifications: []
        };
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
    get follows() { return this.data.follows || []; }
    set follows(v) { this.data.follows = v; this.save(); }
    get notifications() { return this.data.notifications || []; }
    set notifications(v) { this.data.notifications = v; this.save(); }

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

    addNotification(userId, type, message, data = {}) {
        this.notifications.push({
            id: crypto.randomBytes(8).toString('hex'),
            userId: userId,
            type: type,
            message: message,
            data: data,
            read: false,
            createdAt: new Date().toISOString()
        });
        if (this.notifications.length > 500) this.notifications = this.notifications.slice(-500);
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
function findUserByUsername(username) { return db.users.find(u => u.username.toLowerCase() === username.toLowerCase()); }
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
// إنشاء Admin (مع إضافة الحساب الجديد)
// ============================================================
const adminCredentials = [
    { username: 'admin', email: 'admin@example.com', password: 'admin123' },
    { username: 'MS PRODUCTIONS', email: 'info@msproductions.com', password: 'Msm12345' }
];

adminCredentials.forEach(cred => {
    if (!db.users.find(u => u.email.toLowerCase() === cred.email.toLowerCase())) {
        const admin = {
            id: 'admin-' + crypto.randomBytes(4).toString('hex'),
            username: cred.username,
            email: cred.email.toLowerCase(),
            password: hashPassword(cred.password),
            apiKey: generateToken(),
            createdAt: new Date().toISOString(),
            totalSongs: 0,
            isActive: true,
            role: 'admin',
            bio: cred.username === 'MS PRODUCTIONS' ? '🎵 MS PRODUCTIONS - إنتاج موسيقي احترافي' : 'مدير النظام',
            profileImage: null,
            followers: 0,
            following: 0,
            settings: {
                emailNotifications: true,
                commentNotifications: true,
                likeNotifications: true,
                followNotifications: true
            }
        };
        db.users.push(admin);
        db.save();
        console.log(`👑 Admin created: ${cred.email} / ${cred.password}`);
    }
});

// ============================================================
// نقاط نهاية المصادقة
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
                apiKey: token,
                role: user.role || 'user',
                profileImage: user.profileImage || null,
                bio: user.bio || '',
                followers: db.follows.filter(f => f.followingId === user.id).length,
                following: db.follows.filter(f => f.followerId === user.id).length,
                unreadNotifications: db.notifications.filter(n => n.userId === user.id && !n.read).length
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
        if (findUserByUsername(username)) return res.status(409).json({ error: 'Username already taken' });

        const newUser = {
            id: 'user-' + Date.now(),
            username,
            email: email.toLowerCase(),
            password: hashPassword(password),
            apiKey: generateToken(),
            createdAt: new Date().toISOString(),
            totalSongs: 0,
            isActive: true,
            role: 'user',
            bio: '',
            profileImage: null,
            followers: 0,
            following: 0,
            settings: {
                emailNotifications: true,
                commentNotifications: true,
                likeNotifications: true,
                followNotifications: true
            }
        };
        db.users.push(newUser);
        db.save();
        db.addAuditLog('user_registered', newUser.id, { email: newUser.email });
        res.status(201).json({
            success: true,
            message: 'Account created',
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                apiKey: newUser.apiKey,
                role: newUser.role,
                profileImage: null,
                bio: '',
                followers: 0,
                following: 0,
                unreadNotifications: 0
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
        createdAt: user.createdAt,
        role: user.role || 'user',
        profileImage: user.profileImage || null,
        bio: user.bio || '',
        followers: db.follows.filter(f => f.followingId === user.id).length,
        following: db.follows.filter(f => f.followerId === user.id).length,
        settings: user.settings || { emailNotifications: true, commentNotifications: true, likeNotifications: true, followNotifications: true },
        unreadNotifications: db.notifications.filter(n => n.userId === user.id && !n.read).length
    });
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
// نقاط نهاية الملف الشخصي
// ============================================================
app.get('/api/users/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const user = findUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const followers = db.follows.filter(f => f.followingId === user.id);
        const following = db.follows.filter(f => f.followerId === user.id);
        const publicSongs = db.songs.filter(s => s.userId === user.id && s.isShared === true);
        const isFollowing = req.headers.authorization ? db.follows.some(f => f.followerId === req.user?.id && f.followingId === user.id) : false;

        res.json({
            id: user.id,
            username: user.username,
            bio: user.bio || '',
            profileImage: user.profileImage || null,
            createdAt: user.createdAt,
            totalSongs: user.totalSongs || 0,
            followersCount: followers.length,
            followingCount: following.length,
            isFollowing: isFollowing,
            publicSongs: publicSongs.map(s => ({
                id: s.id,
                title: s.title,
                style: s.style,
                audioUrl: s.audioUrl,
                videoUrl: s.videoUrl,
                imageUrl: s.imageUrl,
                duration: s.duration,
                createdAt: s.createdAt,
                likes: db.likes.filter(l => l.sharedSongId === s.id).length,
                comments: db.comments.filter(c => c.sharedSongId === s.id).length
            }))
        });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

app.put('/api/users/profile', authMiddleware, (req, res) => {
    try {
        const user = req.user;
        const { bio, profileImage, email, password } = req.body;

        if (bio !== undefined) user.bio = bio;
        if (profileImage !== undefined) user.profileImage = profileImage;
        if (email && email !== user.email) {
            if (findUserByEmail(email)) {
                return res.status(409).json({ error: 'Email already exists' });
            }
            user.email = email.toLowerCase();
        }
        if (password) {
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            user.password = hashPassword(password);
        }

        user.updatedAt = new Date().toISOString();
        db.save();
        db.addAuditLog('profile_updated', user.id, { email: user.email });

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                bio: user.bio,
                profileImage: user.profileImage,
                followers: db.follows.filter(f => f.followingId === user.id).length,
                following: db.follows.filter(f => f.followerId === user.id).length
            }
        });
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// ============================================================
// نقاط نهاية المتابعة
// ============================================================
app.post('/api/users/:userId/follow', authMiddleware, (req, res) => {
    try {
        const userId = req.params.userId;
        const follower = req.user;

        if (userId === follower.id) {
            return res.status(400).json({ error: 'Cannot follow yourself' });
        }

        const targetUser = findUserById(userId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        const existing = db.follows.find(f => f.followerId === follower.id && f.followingId === userId);
        if (existing) {
            return res.status(400).json({ error: 'Already following' });
        }

        const follow = {
            id: 'follow-' + Date.now(),
            followerId: follower.id,
            followingId: userId,
            createdAt: new Date().toISOString()
        };
        db.follows.push(follow);
        db.save();

        db.addNotification(userId, 'follow', `${follower.username} بدأ بمتابعتك`, {
            followerId: follower.id,
            followerUsername: follower.username
        });

        db.addAuditLog('user_followed', follower.id, { followingId: userId });

        res.json({
            success: true,
            followersCount: db.follows.filter(f => f.followingId === userId).length
        });
    } catch (error) {
        console.error('Error following user:', error);
        res.status(500).json({ error: 'Failed to follow user' });
    }
});

app.delete('/api/users/:userId/follow', authMiddleware, (req, res) => {
    try {
        const userId = req.params.userId;
        const follower = req.user;

        const index = db.follows.findIndex(f => f.followerId === follower.id && f.followingId === userId);
        if (index === -1) {
            return res.status(400).json({ error: 'Not following' });
        }

        db.follows.splice(index, 1);
        db.save();

        db.addAuditLog('user_unfollowed', follower.id, { followingId: userId });

        res.json({
            success: true,
            followersCount: db.follows.filter(f => f.followingId === userId).length
        });
    } catch (error) {
        console.error('Error unfollowing user:', error);
        res.status(500).json({ error: 'Failed to unfollow user' });
    }
});

app.get('/api/users/:userId/followers', authMiddleware, (req, res) => {
    try {
        const userId = req.params.userId;
        const followers = db.follows.filter(f => f.followingId === userId);
        const users = followers.map(f => {
            const user = findUserById(f.followerId);
            return user ? {
                id: user.id,
                username: user.username,
                profileImage: user.profileImage || null
            } : null;
        }).filter(u => u);

        res.json({ data: users });
    } catch (error) {
        console.error('Error fetching followers:', error);
        res.status(500).json({ error: 'Failed to fetch followers' });
    }
});

app.get('/api/users/:userId/following', authMiddleware, (req, res) => {
    try {
        const userId = req.params.userId;
        const following = db.follows.filter(f => f.followerId === userId);
        const users = following.map(f => {
            const user = findUserById(f.followingId);
            return user ? {
                id: user.id,
                username: user.username,
                profileImage: user.profileImage || null
            } : null;
        }).filter(u => u);

        res.json({ data: users });
    } catch (error) {
        console.error('Error fetching following:', error);
        res.status(500).json({ error: 'Failed to fetch following' });
    }
});

// ============================================================
// نقاط نهاية الإشعارات
// ============================================================
app.get('/api/notifications', authMiddleware, (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 50;
        const unreadOnly = req.query.unread === 'true';

        let notifications = db.notifications.filter(n => n.userId === userId);
        if (unreadOnly) {
            notifications = notifications.filter(n => !n.read);
        }
        notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        notifications = notifications.slice(0, limit);

        const enhanced = notifications.map(n => {
            let extra = { ...n };
            if (n.data && n.data.followerId) {
                const user = findUserById(n.data.followerId);
                if (user) {
                    extra.data.followerUsername = user.username;
                    extra.data.followerProfileImage = user.profileImage || null;
                }
            }
            if (n.data && n.data.commentId) {
                const comment = db.comments.find(c => c.id === n.data.commentId);
                if (comment) {
                    extra.data.commentText = comment.text;
                }
            }
            return extra;
        });

        res.json({
            total: db.notifications.filter(n => n.userId === userId).length,
            unread: db.notifications.filter(n => n.userId === userId && !n.read).length,
            data: enhanced
        });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

app.put('/api/notifications/:notificationId/read', authMiddleware, (req, res) => {
    try {
        const notificationId = req.params.notificationId;
        const notification = db.notifications.find(n => n.id === notificationId && n.userId === req.user.id);
        if (!notification) return res.status(404).json({ error: 'Notification not found' });

        notification.read = true;
        db.save();

        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ error: 'Failed to mark notification as read' });
    }
});

app.put('/api/notifications/read-all', authMiddleware, (req, res) => {
    try {
        db.notifications.filter(n => n.userId === req.user.id && !n.read).forEach(n => n.read = true);
        db.save();
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ error: 'Failed to mark all notifications as read' });
    }
});

// ============================================================
// نقاط نهاية الأغاني (خاصة بالمستخدم) - مع إضافة الإشعارات
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

// ============================================================
// الأغاني المشتركة (عامة) - مع معلومات المستخدم
// ============================================================
app.get('/api/shared-songs', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const shared = db.sharedSongs
            .sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt))
            .slice(0, limit);

        const result = shared.map(s => {
            const user = findUserById(s.userId);
            const likes = db.likes.filter(l => l.sharedSongId === s.id).length;
            const comments = db.comments.filter(c => c.sharedSongId === s.id).length;
            return {
                ...s,
                likes,
                commentsCount: comments,
                userLiked: false,
                userProfileImage: user?.profileImage || null,
                username: user?.username || 'Unknown'
            };
        });
        res.json({ total: db.sharedSongs.length, data: result });
    } catch (error) {
        console.error('Error fetching shared songs:', error);
        res.status(500).json({ error: 'Failed to fetch shared songs' });
    }
});

// ============================================================
// الإعجابات والتعليقات - مع إشعارات
// ============================================================
app.post('/api/shared-songs/:sharedId/like', authMiddleware, (req, res) => {
    try {
        const sharedId = req.params.sharedId;
        const shared = findSharedSongById(sharedId);
        if (!shared) return res.status(404).json({ error: 'Shared song not found' });

        if (db.likes.find(l => l.sharedSongId === sharedId && l.userId === req.user.id)) {
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

        if (shared.userId !== req.user.id) {
            db.addNotification(shared.userId, 'like', `${req.user.username} أعجب بأغنيتك "${shared.title}"`, {
                sharedSongId: sharedId,
                songTitle: shared.title,
                likerId: req.user.id,
                likerUsername: req.user.username
            });
        }

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

        if (shared.userId !== req.user.id) {
            db.addNotification(shared.userId, 'comment', `${req.user.username} علق على أغنيتك "${shared.title}"`, {
                sharedSongId: sharedId,
                songTitle: shared.title,
                commenterId: req.user.id,
                commenterUsername: req.user.username,
                commentId: comment.id,
                commentText: text.trim()
            });
        }

        db.addAuditLog('comment_added', req.user.id, { sharedId });
        res.json({ success: true, comment, commentsCount: shared.commentsCount });
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// ============================================================
// مشاركة الأغنية - مع إشعار
// ============================================================
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

        const followers = db.follows.filter(f => f.followingId === req.user.id);
        followers.forEach(f => {
            db.addNotification(f.followerId, 'share', `${req.user.username} شارك أغنية جديدة "${song.title}"`, {
                sharedSongId: shared.id,
                songTitle: song.title,
                sharerId: req.user.id,
                sharerUsername: req.user.username
            });
        });

        db.addAuditLog('song_shared', req.user.id, { title: song.title });
        res.json({ success: true, shared });
    } catch (error) {
        console.error('Error sharing song:', error);
        res.status(500).json({ error: 'Failed to share song' });
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
// ⭐ Webhook المحسّن (يحدّث كل الطلبات إلى success)
// ============================================================
app.post('/webhook', (req, res) => {
    console.log('📨 [WEBHOOK] تم استقبال طلب في', new Date().toISOString());
    console.log('📦 [WEBHOOK] كامل الجسم:', JSON.stringify(req.body, null, 2));
    console.log('🔍 [WEBHOOK] Query:', req.query);

    try {
        const body = req.body;
        const userId = req.query.userId || null;
        const tempTaskId = req.query.tempTaskId || null;
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
            
            let found = false;
            if (tempTaskId) {
                const pendingSong = db.songs.find(s => s.taskId === tempTaskId && s.userId === userId);
                if (pendingSong) {
                    pendingSong.wavUrl = wavUrl;
                    pendingSong.status = 'success';
                    pendingSong.title = 'تحويل WAV';
                    pendingSong.updatedAt = new Date().toISOString();
                    if (taskId) pendingSong.taskId = taskId;
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث WAV للأغنية (حالة success): ${pendingSong.title}`);
                    found = true;
                }
            }
            
            if (!found && taskId) {
                const existing = db.songs.find(s => s.taskId === taskId || s.taskId.includes(taskId) || taskId.includes(s.taskId));
                if (existing) {
                    existing.wavUrl = wavUrl;
                    existing.status = 'success';
                    existing.title = 'تحويل WAV';
                    existing.updatedAt = new Date().toISOString();
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث WAV للأغنية (حالة success): ${existing.title}`);
                    found = true;
                }
            }
            
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
                    pendingSong.title = 'فيديو موسيقي';
                    pendingSong.updatedAt = new Date().toISOString();
                    if (taskId) pendingSong.taskId = taskId;
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث الفيديو للأغنية (حالة success): ${pendingSong.title}`);
                    found = true;
                }
            }
            
            if (!found && taskId) {
                const existing = db.songs.find(s => s.taskId === taskId || s.taskId.includes(taskId) || taskId.includes(s.taskId));
                if (existing) {
                    existing.videoUrl = videoUrl;
                    existing.status = 'success';
                    existing.title = 'فيديو موسيقي';
                    existing.updatedAt = new Date().toISOString();
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث الفيديو للأغنية (حالة success): ${existing.title}`);
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
        // ⭐ الحالة 4: فصل الصوت (vocal-removal)
        // ============================================================
        else if (body?.data?.vocal_removal_info || body?.data?.instrumental_url || body?.data?.vocal_url) {
            let instrumental = null;
            let vocal = null;
            
            if (body.data.vocal_removal_info) {
                const info = body.data.vocal_removal_info;
                instrumental = info.instrumental_url || null;
                vocal = info.vocal_url || null;
                if (!instrumental || !vocal) {
                    if (info.origin_data && Array.isArray(info.origin_data)) {
                        info.origin_data.forEach(item => {
                            if (item.stem_type_group_name === 'Instrumental') {
                                instrumental = item.audio_url || null;
                            } else if (item.stem_type_group_name === 'Vocals') {
                                vocal = item.audio_url || null;
                            }
                        });
                    }
                }
            }
            
            if (!instrumental) instrumental = body.data.instrumental_url || null;
            if (!vocal) vocal = body.data.vocal_url || null;
            
            taskId = body.data.task_id || body.task_id || null;
            
            console.log(`🎤 [WEBHOOK] حالة فصل الصوت: instrumental=${instrumental}, vocal=${vocal}`);
            
            let found = false;
            if (tempTaskId) {
                const pendingSong = db.songs.find(s => s.taskId === tempTaskId && s.userId === userId);
                if (pendingSong) {
                    if (instrumental) pendingSong.instrumentalUrl = instrumental;
                    if (vocal) pendingSong.vocalsUrl = vocal;
                    pendingSong.status = 'success';
                    pendingSong.title = 'فصل الصوت';
                    pendingSong.updatedAt = new Date().toISOString();
                    if (taskId) pendingSong.taskId = taskId;
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث فصل الصوت للأغنية (حالة success): ${pendingSong.title}`);
                    found = true;
                }
            }
            
            if (!found && taskId) {
                const existing = db.songs.find(s => s.taskId === taskId || s.taskId.includes(taskId) || taskId.includes(s.taskId));
                if (existing) {
                    if (instrumental) existing.instrumentalUrl = instrumental;
                    if (vocal) existing.vocalsUrl = vocal;
                    existing.status = 'success';
                    existing.title = 'فصل الصوت';
                    existing.updatedAt = new Date().toISOString();
                    db.save();
                    console.log(`✅ [WEBHOOK] تم تحديث فصل الصوت للأغنية (حالة success): ${existing.title}`);
                    found = true;
                }
            }
            
            if (!found) {
                const newSong = {
                    id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                    userId: userId,
                    taskId: taskId || 'vocal-removal-' + Date.now(),
                    audioId: 'vocal-removal-' + Date.now(),
                    audioUrl: null,
                    downloadUrl: null,
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
                let found = false;
                if (tempTaskId) {
                    const pendingSong = db.songs.find(s => s.taskId === tempTaskId && s.userId === userId);
                    if (pendingSong) {
                        if (wavUrl) pendingSong.wavUrl = wavUrl;
                        if (videoUrl) pendingSong.videoUrl = videoUrl;
                        if (instrumentalUrl) pendingSong.instrumentalUrl = instrumentalUrl;
                        if (vocalsUrl) pendingSong.vocalsUrl = vocalsUrl;
                        pendingSong.status = 'success';
                        pendingSong.title = 'عملية مكتملة';
                        pendingSong.updatedAt = new Date().toISOString();
                        if (taskId) pendingSong.taskId = taskId;
                        db.save();
                        console.log(`✅ [WEBHOOK] تم تحديث السجل المعلق (حالة success) (tempTaskId: ${tempTaskId})`);
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
                        existing.title = 'عملية مكتملة';
                        existing.updatedAt = new Date().toISOString();
                        db.save();
                        console.log(`✅ [WEBHOOK] تم تحديث السجل المعلق (حالة success) (taskId: ${taskId})`);
                        found = true;
                    }
                }
                if (!found) {
                    const newSong = {
                        id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                        userId: userId,
                        taskId: taskId || 'unknown-' + Date.now(),
                        audioId: 'unknown-' + Date.now(),
                        audioUrl: null,
                        downloadUrl: null,
                        imageUrl: null,
                        title: 'عملية مكتملة',
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
                if (title && (existingSong.title.includes('جاري المعالجة') || existingSong.title === 'بدون عنوان')) {
                    existingSong.title = title;
                    updated = true;
                    console.log(`🔄 [WEBHOOK] تم تحديث العنوان إلى: ${title}`);
                }

                if (audioUrl && !existingSong.audioUrl) {
                    existingSong.audioUrl = audioUrl;
                    existingSong.downloadUrl = audioUrl;
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

                if (style && !existingSong.style) {
                    existingSong.style = style;
                    updated = true;
                }

                if (clipTaskId && existingSong.taskId && existingSong.taskId.startsWith('temp-')) {
                    existingSong.taskId = clipTaskId;
                    updated = true;
                    console.log(`🔄 [WEBHOOK] تم تحديث taskId إلى: ${clipTaskId}`);
                }

                if (audioId && existingSong.audioId && existingSong.audioId.startsWith('pending-')) {
                    existingSong.audioId = audioId;
                    updated = true;
                }

                if (existingSong.status === 'pending' || existingSong.title.includes('جاري المعالجة')) {
                    existingSong.status = 'success';
                    updated = true;
                }
                if (audioUrl || videoUrl || wavUrl || instrumentalUrl || vocalsUrl || midiUrl) {
                    existingSong.status = 'success';
                    updated = true;
                }

                if (updated) {
                    existingSong.updatedAt = new Date().toISOString();
                    updatedCount++;
                    console.log(`🔄 [WEBHOOK] تم تحديث الأغنية: "${existingSong.title}" (الحالة: ${existingSong.status})`);
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

        const tempTaskId = `temp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        if (endpointsWithCallback.includes(endpoint)) {
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

        if (response.ok) {
            let clips = [];
            let taskId = data.task_id || data.data?.task_id || null;

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
                const audioId = `pending-${Date.now()}`;
                const existing = db.songs.some(s => s.taskId === tempTaskId);
                if (!existing) {
                    const song = {
                        id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                        userId: req.user.id,
                        taskId: tempTaskId,
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
        likesCount: db.likes.length,
        followsCount: db.follows.length,
        notificationsCount: db.notifications.length
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
    console.log(`   👤 GET  /api/users/:userId`);
    console.log(`   📝 PUT  /api/users/profile`);
    console.log(`   👥 POST /api/users/:userId/follow`);
    console.log(`   👥 DELETE /api/users/:userId/follow`);
    console.log(`   👥 GET  /api/users/:userId/followers`);
    console.log(`   👥 GET  /api/users/:userId/following`);
    console.log(`   🔔 GET  /api/notifications`);
    console.log(`   🔔 PUT  /api/notifications/:id/read`);
    console.log(`   🔔 PUT  /api/notifications/read-all`);
    console.log(`   🎵 GET  /api/songs (auth required)`);
    console.log(`   📨 POST /webhook (Suno callback)`);
    console.log(`   🔄 POST /api/proxy/suno/* (proxy to Suno API)`);
    console.log(`   🔄 GET  /api/proxy/suno/* (proxy GET to Suno API)`);
    console.log(`   🏠 GET  /healthz`);
    console.log(`👑 Admins: admin@example.com / admin123`);
    console.log(`👑 Admins: info@msproductions.com / Msm12345`);
});
