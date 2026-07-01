const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// تعريف INTERNAL_WEBHOOK
// ============================================================
const INTERNAL_WEBHOOK = `https://suno-backend-production.up.railway.app/webhook`;

// ============================================================
// نقاط النهاية التي تحتاج callBackUrl
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
// قاعدة البيانات
// ============================================================
const CONFIG = {
    DATA_FILE: path.join(__dirname, 'data.json'),
    MAX_SONGS_PER_USER: 1000
};

class Database {
    constructor() {
        this.data = { 
            users: [], 
            songs: [], 
            sharedSongs: [], 
            comments: [], 
            likes: [], 
            auditLogs: [],
            notifications: [],
            messages: []
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
            console.log('💾 تم حفظ البيانات');
        } catch (e) { 
            console.error('❌ خطأ في حفظ البيانات:', e.message); 
        }
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
    get notifications() { return this.data.notifications; }
    set notifications(v) { this.data.notifications = v; this.save(); }
    get messages() { return this.data.messages; }
    set messages(v) { this.data.messages = v; this.save(); }
    
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
        const notif = {
            id: 'notif-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
            userId: userId,
            type: type,
            message: message,
            data: data,
            read: false,
            createdAt: new Date().toISOString()
        };
        this.notifications.push(notif);
        if (this.notifications.length > 500) this.notifications = this.notifications.slice(-500);
        this.save();
        return notif;
    }
    addMessage(fromUserId, toUserId, text) {
        const msg = {
            id: 'msg-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
            fromUserId: fromUserId,
            toUserId: toUserId,
            text: text,
            read: false,
            createdAt: new Date().toISOString()
        };
        this.messages.push(msg);
        if (this.messages.length > 2000) this.messages = this.messages.slice(-2000);
        this.save();
        return msg;
    }
    getConversation(userId1, userId2) {
        return this.messages
            .filter(m => 
                (m.fromUserId === userId1 && m.toUserId === userId2) ||
                (m.fromUserId === userId2 && m.toUserId === userId1)
            )
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    }
    getUnreadMessages(userId) {
        return this.messages.filter(m => m.toUserId === userId && !m.read);
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
const existingAdmin = db.users.find(u => u.role === 'admin');
if (!existingAdmin) {
    const admin = {
        id: 'admin-' + crypto.randomBytes(4).toString('hex'),
        username: 'MS PRODUCTIONS',
        email: 'info@msproductions.com',
        password: hashPassword('Msm12345'),
        apiKey: generateToken(),
        profileImage: 'https://i.imgur.com/c8qwfZf.png',
        bio: 'المدير العام للنظام',
        followers: [],
        following: [],
        createdAt: new Date().toISOString(),
        totalSongs: 0,
        isActive: true,
        role: 'admin'
    };
    db.users.push(admin);
    db.save();
    console.log('👑 Admin created: info@msproductions.com / Msm12345');
} else {
    if (existingAdmin.email !== 'info@msproductions.com' || existingAdmin.username !== 'MS PRODUCTIONS') {
        existingAdmin.email = 'info@msproductions.com';
        existingAdmin.username = 'MS PRODUCTIONS';
        existingAdmin.password = hashPassword('Msm12345');
        db.save();
        console.log('👑 Admin updated: info@msproductions.com / Msm12345');
    }
}

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
                profileImage: user.profileImage || '',
                bio: user.bio || '',
                totalSongs: user.totalSongs || 0,
                followers: user.followers || [],
                following: user.following || [],
                role: user.role || 'user',
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
            profileImage: 'https://i.imgur.com/c8qwfZf.png',
            bio: '',
            followers: [],
            following: [],
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
    res.json({ 
        id: user.id, 
        username: user.username, 
        email: user.email, 
        profileImage: user.profileImage || '',
        bio: user.bio || '',
        followers: user.followers || [],
        following: user.following || [],
        totalSongs: user.totalSongs || 0, 
        createdAt: user.createdAt,
        role: user.role || 'user'
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
// نقاط نهاية الأغاني
// ============================================================
function getUserSongs(userId) {
    return db.songs.filter(s => s.userId === userId);
}

app.get('/api/songs', authMiddleware, (req, res) => {
    try {
        const userSongs = getUserSongs(req.user.id);
        res.json({ total: userSongs.length, data: userSongs });
    } catch (error) {
        console.error('Error fetching songs:', error);
        res.status(500).json({ error: 'Failed to fetch songs' });
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
            profileImage: req.user.profileImage || 'https://i.imgur.com/c8qwfZf.png',
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
// الأغاني المشتركة (عامة) - مع دعم الفلتر
// ============================================================
app.get('/api/shared-songs', authMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const filter = req.query.filter || 'all';
        let shared = db.sharedSongs;
        if (filter === 'following') {
            const followingIds = req.user.following || [];
            shared = shared.filter(s => followingIds.includes(s.userId));
        }
        shared = shared.sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt)).slice(0, limit);
        const result = shared.map(s => {
            const likes = db.likes.filter(l => l.sharedSongId === s.id).length;
            const comments = db.comments.filter(c => c.sharedSongId === s.id).length;
            return { ...s, likes, commentsCount: comments, userLiked: false };
        });
        res.json({ total: db.sharedSongs.length, data: result, filter: filter });
    } catch (error) {
        console.error('Error fetching shared songs:', error);
        res.status(500).json({ error: 'Failed to fetch shared songs' });
    }
});

// ============================================================
// نقاط نهاية المستخدمين والملف الشخصي والمتابعة والإشعارات
// ============================================================

app.get('/api/users/:userId', authMiddleware, (req, res) => {
    try {
        const targetId = req.params.userId;
        const targetUser = findUserById(targetId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        const publicSongs = db.songs
            .filter(s => s.userId === targetId && s.isShared === true && s.audioUrl && s.audioUrl.startsWith('https://'))
            .map(s => ({
                id: s.id,
                title: s.title,
                style: s.style,
                audioUrl: s.audioUrl,
                videoUrl: s.videoUrl,
                duration: s.duration,
                imageUrl: s.imageUrl,
                likes: db.likes.filter(l => l.sharedSongId === s.id).length,
                comments: db.comments.filter(c => c.sharedSongId === s.id).length,
                createdAt: s.createdAt
            }));

        const isFollowing = (targetUser.followers || []).includes(req.user.id);

        res.json({
            id: targetUser.id,
            username: targetUser.username,
            profileImage: targetUser.profileImage || 'https://i.imgur.com/c8qwfZf.png',
            bio: targetUser.bio || '',
            role: targetUser.role || 'user',
            followersCount: (targetUser.followers || []).length,
            followingCount: (targetUser.following || []).length,
            totalSongs: targetUser.totalSongs || 0,
            isFollowing: isFollowing,
            publicSongs: publicSongs,
            createdAt: targetUser.createdAt
        });
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({ error: 'Failed to fetch user profile' });
    }
});

app.put('/api/users/profile', authMiddleware, (req, res) => {
    try {
        const user = req.user;
        const { email, password, profileImage, bio } = req.body;

        if (email) {
            const existing = findUserByEmail(email);
            if (existing && existing.id !== user.id) {
                return res.status(409).json({ error: 'Email already in use' });
            }
            user.email = email.toLowerCase();
        }

        if (password) {
            if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
            user.password = hashPassword(password);
        }

        if (profileImage) user.profileImage = profileImage;
        if (bio !== undefined) user.bio = bio;

        db.save();
        db.addAuditLog('profile_updated', user.id, { email: user.email });

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                profileImage: user.profileImage,
                bio: user.bio,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

app.post('/api/users/:userId/follow', authMiddleware, (req, res) => {
    try {
        const targetId = req.params.userId;
        if (targetId === req.user.id) {
            return res.status(400).json({ error: 'You cannot follow yourself' });
        }
        const targetUser = findUserById(targetId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        if (!targetUser.followers) targetUser.followers = [];
        if (targetUser.followers.includes(req.user.id)) {
            return res.status(400).json({ error: 'Already following' });
        }

        targetUser.followers.push(req.user.id);
        if (!req.user.following) req.user.following = [];
        req.user.following.push(targetId);

        db.save();
        db.addAuditLog('user_followed', req.user.id, { targetId });

        db.addNotification(targetId, 'follow', `${req.user.username} بدأ بمتابعتك`, {
            followerId: req.user.id,
            followerUsername: req.user.username,
            followerProfileImage: req.user.profileImage
        });

        res.json({ success: true, message: 'Followed successfully' });
    } catch (error) {
        console.error('Error following user:', error);
        res.status(500).json({ error: 'Failed to follow user' });
    }
});

app.delete('/api/users/:userId/follow', authMiddleware, (req, res) => {
    try {
        const targetId = req.params.userId;
        const targetUser = findUserById(targetId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        if (!targetUser.followers) targetUser.followers = [];
        const index = targetUser.followers.indexOf(req.user.id);
        if (index === -1) {
            return res.status(400).json({ error: 'Not following' });
        }
        targetUser.followers.splice(index, 1);
        if (req.user.following) {
            const idx = req.user.following.indexOf(targetId);
            if (idx !== -1) req.user.following.splice(idx, 1);
        }

        db.save();
        db.addAuditLog('user_unfollowed', req.user.id, { targetId });
        res.json({ success: true, message: 'Unfollowed successfully' });
    } catch (error) {
        console.error('Error unfollowing user:', error);
        res.status(500).json({ error: 'Failed to unfollow user' });
    }
});

app.get('/api/users/:userId/followers', authMiddleware, (req, res) => {
    try {
        const targetId = req.params.userId;
        const targetUser = findUserById(targetId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        const followers = (targetUser.followers || []).map(id => {
            const u = findUserById(id);
            return u ? { id: u.id, username: u.username, profileImage: u.profileImage } : null;
        }).filter(Boolean);

        res.json({ data: followers });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch followers' });
    }
});

app.get('/api/users/:userId/following', authMiddleware, (req, res) => {
    try {
        const targetId = req.params.userId;
        const targetUser = findUserById(targetId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        const following = (targetUser.following || []).map(id => {
            const u = findUserById(id);
            return u ? { id: u.id, username: u.username, profileImage: u.profileImage } : null;
        }).filter(Boolean);

        res.json({ data: following });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch following' });
    }
});

// ============================================================
// البحث عن المستخدمين
// ============================================================
app.get('/api/users/search', authMiddleware, (req, res) => {
    try {
        const query = req.query.q?.trim()?.toLowerCase() || '';
        if (!query || query.length < 2) {
            return res.json({ data: [] });
        }
        const users = db.users
            .filter(u => 
                u.id !== req.user.id &&
                (u.username.toLowerCase().includes(query) || 
                 u.email.toLowerCase().includes(query))
            )
            .map(u => ({
                id: u.id,
                username: u.username,
                profileImage: u.profileImage || 'https://i.imgur.com/c8qwfZf.png',
                followersCount: (u.followers || []).length,
                isFollowing: (u.followers || []).includes(req.user.id)
            }))
            .slice(0, 20);
        res.json({ data: users });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'فشل البحث' });
    }
});

// ============================================================
// نقاط نهاية المراسلة
// ============================================================
app.get('/api/messages/:userId', authMiddleware, (req, res) => {
    try {
        const otherUserId = req.params.userId;
        const conversation = db.getConversation(req.user.id, otherUserId);
        res.json({ data: conversation });
    } catch (error) {
        console.error('Messages error:', error);
        res.status(500).json({ error: 'فشل جلب الرسائل' });
    }
});

app.post('/api/messages/:userId', authMiddleware, (req, res) => {
    try {
        const toUserId = req.params.userId;
        const { text } = req.body;
        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'الرسالة فارغة' });
        }
        const toUser = findUserById(toUserId);
        if (!toUser) return res.status(404).json({ error: 'المستخدم غير موجود' });
        
        const msg = db.addMessage(req.user.id, toUserId, text.trim());
        db.addNotification(toUserId, 'message', `${req.user.username} أرسل لك رسالة`, {
            fromUserId: req.user.id,
            fromUsername: req.user.username,
            messageId: msg.id,
            preview: text.trim().substring(0, 50)
        });
        res.status(201).json({ success: true, message: msg });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'فشل إرسال الرسالة' });
    }
});

app.put('/api/messages/read', authMiddleware, (req, res) => {
    try {
        const { messageIds } = req.body;
        if (!messageIds || !Array.isArray(messageIds)) {
            return res.status(400).json({ error: 'Invalid request' });
        }
        let updated = 0;
        messageIds.forEach(id => {
            const msg = db.messages.find(m => m.id === id && m.toUserId === req.user.id);
            if (msg && !msg.read) {
                msg.read = true;
                updated++;
            }
        });
        db.save();
        res.json({ success: true, updated });
    } catch (error) {
        res.status(500).json({ error: 'فشل تحديث حالة القراءة' });
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

        const owner = findUserById(shared.userId);
        if (owner && owner.id !== req.user.id) {
            db.addNotification(owner.id, 'like', `${req.user.username} أعجب بأغنيتك "${shared.title}"`, {
                actorId: req.user.id,
                actorUsername: req.user.username,
                songId: shared.songId,
                songTitle: shared.title
            });
        }

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

        const owner = findUserById(shared.userId);
        if (owner && owner.id !== req.user.id) {
            db.addNotification(owner.id, 'comment', `${req.user.username} علق على أغنيتك "${shared.title}"`, {
                actorId: req.user.id,
                actorUsername: req.user.username,
                songId: shared.songId,
                songTitle: shared.title,
                commentText: text.trim()
            });
        }

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
// الإحصائيات المفصلة
// ============================================================
app.get('/api/stats', authMiddleware, (req, res) => {
    try {
        const user = req.user;
        const userSongs = db.songs.filter(s => s.userId === user.id);
        const total = userSongs.length;
        const sharedCount = userSongs.filter(s => s.isShared).length;
        const now = new Date();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0,0,0,0);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        
        const songsThisWeek = userSongs.filter(s => new Date(s.createdAt) >= startOfWeek).length;
        const songsThisMonth = userSongs.filter(s => new Date(s.createdAt) >= startOfMonth).length;

        const userSharedIds = db.sharedSongs.filter(s => s.userId === user.id).map(s => s.id);
        const totalLikesReceived = db.likes.filter(l => userSharedIds.includes(l.sharedSongId)).length;
        const totalLikesGiven = db.likes.filter(l => l.userId === user.id).length;

        const styleCount = {};
        userSongs.forEach(s => {
            if (s.style) {
                s.style.split(',').map(st => st.trim()).forEach(st => { if (st) styleCount[st] = (styleCount[st] || 0) + 1; });
            }
        });
        const topStyles = Object.entries(styleCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([style, count]) => ({ style, count }));

        const unreadMessages = db.getUnreadMessages(user.id).length;

        res.json({
            totalSongs: total,
            sharedSongs: sharedCount,
            followers: (user.followers || []).length,
            following: (user.following || []).length,
            totalLikesReceived: totalLikesReceived,
            totalLikesGiven: totalLikesGiven,
            songsThisWeek: songsThisWeek,
            songsThisMonth: songsThisMonth,
            topStyles,
            averageDuration: userSongs.filter(s => s.duration).reduce((sum, s) => sum + (s.duration || 0), 0) / (userSongs.filter(s => s.duration).length || 1),
            unreadMessages: unreadMessages
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ============================================================
// Webhook الرئيسي (معدل لدعم جميع الحقول)
// ============================================================
app.post('/webhook', (req, res) => {
    console.log('📨 [WEBHOOK] تم استقبال طلب في', new Date().toISOString());

    try {
        const body = req.body;
        const userId = req.query.userId || null;

        let clips = [];
        let taskId = null;

        if (body?.data?.data && Array.isArray(body.data.data)) {
            clips = body.data.data;
            taskId = body.data.task_id || body.task_id || null;
        } else if (body?.data && Array.isArray(body.data)) {
            clips = body.data;
            taskId = body.task_id || null;
        } else if (body?.clips && Array.isArray(body.clips)) {
            clips = body.clips;
            taskId = body.task_id || null;
        } else if (Array.isArray(body)) {
            clips = body;
        }

        if (clips.length === 0) {
            return res.status(200).json({ received: true, error: 'No clips found' });
        }

        let savedCount = 0;
        let updatedCount = 0;

        clips.forEach((clip, index) => {
            // استخراج جميع الحقول الممكنة
            const audioUrl = clip.audio_url || clip.audioUrl || clip.url || null;
            const videoUrl = clip.video_url || clip.videoUrl || null;
            const wavUrl = clip.wav_url || clip.wavUrl || null;
            const midiUrl = clip.midi_url || clip.midiUrl || null;
            const instrumentalUrl = clip.instrumental_url || clip.instrumentalUrl || null;
            const vocalsUrl = clip.vocals_url || clip.vocalsUrl || null;
            const lyrics = clip.lyrics || null;
            const title = clip.title || clip.name || `مقطع ${index + 1}`;
            const audioId = clip.id || clip.audioId || `clip-${index}`;
            const clipTaskId = clip.task_id || clip.taskId || taskId || `unknown-${Date.now()}`;
            const duration = clip.duration || null;
            const imageUrl = clip.image_url || clip.imageUrl || null;
            const style = clip.tags || clip.style || '';
            const prompt = clip.prompt || '';

            const existingSong = db.songs.find(s => s.taskId === clipTaskId && s.audioId === audioId);

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
                }
                if (wavUrl && !existingSong.wavUrl) {
                    existingSong.wavUrl = wavUrl;
                    updated = true;
                }
                if (midiUrl && !existingSong.midiUrl) {
                    existingSong.midiUrl = midiUrl;
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
                if (lyrics && !existingSong.lyrics) {
                    existingSong.lyrics = lyrics;
                    updated = true;
                }
                if (duration && !existingSong.duration) {
                    existingSong.duration = duration;
                    updated = true;
                }
                if (imageUrl && !existingSong.imageUrl) {
                    existingSong.imageUrl = imageUrl;
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
                if (prompt && !existingSong.prompt) {
                    existingSong.prompt = prompt;
                    updated = true;
                }

                if (updated) {
                    existingSong.updatedAt = new Date().toISOString();
                    updatedCount++;
                    console.log(`✅ تم تحديث الأغنية: ${existingSong.title} (${existingSong.id})`);
                }
            } else {
                // إنشاء أغنية جديدة مع جميع الحقول
                const song = {
                    id: 'song-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
                    userId: userId,
                    taskId: clipTaskId,
                    audioId: audioId,
                    audioUrl: audioUrl,
                    downloadUrl: audioUrl || null,
                    imageUrl: imageUrl || null,
                    title: title,
                    style: style || '',
                    prompt: prompt || '',
                    duration: duration || null,
                    videoUrl: videoUrl,
                    status: audioUrl ? 'success' : 'pending',
                    isShared: false,
                    likes: 0,
                    commentsCount: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lyrics: lyrics,
                    instrumentalUrl: instrumentalUrl,
                    vocalsUrl: vocalsUrl,
                    wavUrl: wavUrl,
                    midiUrl: midiUrl
                };
                db.songs.push(song);
                savedCount++;
                if (userId) {
                    const user = findUserById(userId);
                    if (user) user.totalSongs = (user.totalSongs || 0) + 1;
                }
                console.log(`✅ تم إنشاء أغنية جديدة: ${song.title} (${song.id})`);
            }
        });

        db.save();
        console.log(`📨 [WEBHOOK] تم حفظ ${savedCount} أغنية جديدة وتحديث ${updatedCount} أغنية`);
        return res.status(200).json({ received: true, saved: savedCount, updated: updatedCount });

    } catch (error) {
        console.error('❌ [WEBHOOK] خطأ:', error);
        res.status(500).json({ error: 'Webhook processing failed', details: error.message });
    }
});

// ============================================================
// Proxy لـ Suno API
// ============================================================
app.post('/api/proxy/suno/*', authMiddleware, async (req, res) => {
    try {
        const endpoint = req.params[0] || req.path.replace('/api/proxy/suno/', '');
        const apiKey = req.body.apiKey || req.headers['x-api-key'];
        if (!apiKey) {
            return res.status(400).json({ error: 'API Key required' });
        }

        const { apiKey: _, ...payload } = req.body;

        if (endpointsWithCallback.includes(endpoint)) {
            payload.callBackUrl = `${INTERNAL_WEBHOOK}?userId=${req.user.id}`;
        }

        const sunoUrl = `https://api.sunoapi.org/api/v1/${endpoint}`;
        console.log(`🔄 Proxy to Suno: ${sunoUrl}`);
        console.log('📦 Payload:', JSON.stringify(payload, null, 2));

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
    console.log(`👑 Admin: info@msproductions.com / Msm12345`);
    console.log(`📋 Endpoints ready.`);
});
