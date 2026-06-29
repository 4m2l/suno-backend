const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// إعدادات CORS الصحيحة
// ============================================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));

// ============================================================
// إعدادات متقدمة
// ============================================================
const CONFIG = {
    MAX_SONGS_PER_USER: 1000,
    RATE_LIMIT_WINDOW: 60000,
    MAX_REQUESTS_PER_WINDOW: 100,
    CACHE_TTL: 60000,
    DATA_FILE: path.join(__dirname, 'data.json'),
    LOG_FILE: path.join(__dirname, 'audit.log'),
    USERS_FILE: path.join(__dirname, 'users.json')
};

// ============================================================
// نظام التخزين الدائم
// ============================================================
class Database {
    constructor() {
        this.data = {
            songs: [],
            users: [],
            auditLogs: [],
            analytics: {
                totalRequests: 0,
                uniqueIps: new Set(),
                hourlyStats: {}
            }
        };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(CONFIG.DATA_FILE)) {
                const raw = fs.readFileSync(CONFIG.DATA_FILE, 'utf8');
                const loaded = JSON.parse(raw);
                if (loaded.analytics) {
                    loaded.analytics.uniqueIps = new Set(loaded.analytics.uniqueIps || []);
                }
                this.data = loaded;
                console.log('📂 تم تحميل البيانات من الملف');
            }
        } catch (e) {
            console.error('⚠️ خطأ في تحميل البيانات:', e.message);
        }
    }

    save() {
        try {
            const toSave = {
                ...this.data,
                analytics: {
                    ...this.data.analytics,
                    uniqueIps: Array.from(this.data.analytics.uniqueIps || [])
                }
            };
            fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(toSave, null, 2));
        } catch (e) {
            console.error('❌ خطأ في حفظ البيانات:', e.message);
        }
    }

    get songs() { return this.data.songs; }
    set songs(val) { this.data.songs = val; this.save(); }

    get users() { return this.data.users; }
    set users(val) { this.data.users = val; this.save(); }

    get auditLogs() { return this.data.auditLogs; }
    set auditLogs(val) { this.data.auditLogs = val; this.save(); }

    get analytics() { return this.data.analytics; }
    set analytics(val) { this.data.analytics = val; this.save(); }

    addAuditLog(action, userId, details) {
        this.auditLogs.push({
            id: crypto.randomBytes(8).toString('hex'),
            userId: userId || 'system',
            action: action,
            details: details,
            timestamp: new Date().toISOString(),
            ip: details?.ip || 'unknown'
        });
        if (this.auditLogs.length > 1000) {
            this.auditLogs = this.auditLogs.slice(-1000);
        }
        this.save();
    }

    trackRequest(ip) {
        this.analytics.totalRequests++;
        this.analytics.uniqueIps.add(ip);
        const hour = new Date().toISOString().slice(0, 13);
        if (!this.analytics.hourlyStats[hour]) {
            this.analytics.hourlyStats[hour] = 0;
        }
        this.analytics.hourlyStats[hour]++;
        this.save();
    }
}

const db = new Database();

// إنشاء مستخدم Admin إذا لم يكن موجوداً
if (!db.users.find(u => u.username === 'admin')) {
    const admin = {
        id: 'admin-' + crypto.randomBytes(4).toString('hex'),
        username: 'admin',
        email: 'admin@example.com',
        apiKey: 'sk-' + crypto.randomBytes(32).toString('hex'),
        credits: 9999,
        createdAt: new Date().toISOString(),
        totalSongs: 0,
        isActive: true,
        role: 'admin'
    };
    db.users.push(admin);
    db.save();
    console.log('👑 تم إنشاء مستخدم Admin:');
    console.log(`   📧 Email: ${admin.email}`);
    console.log(`   🔑 API Key: ${admin.apiKey}`);
}

// ============================================================
// نظام Rate Limiting
// ============================================================
class RateLimiter {
    constructor() {
        this.requests = new Map();
    }

    check(ip) {
        const now = Date.now();
        const windowStart = now - CONFIG.RATE_LIMIT_WINDOW;

        if (this.requests.has(ip)) {
            const requests = this.requests.get(ip).filter(time => time > windowStart);
            this.requests.set(ip, requests);
        }

        const currentRequests = this.requests.get(ip) || [];
        if (currentRequests.length >= CONFIG.MAX_REQUESTS_PER_WINDOW) {
            return { allowed: false, remaining: 0, resetIn: CONFIG.RATE_LIMIT_WINDOW - (now - currentRequests[0]) };
        }

        currentRequests.push(now);
        this.requests.set(ip, currentRequests);
        const remaining = CONFIG.MAX_REQUESTS_PER_WINDOW - currentRequests.length;
        const resetIn = CONFIG.RATE_LIMIT_WINDOW - (now - currentRequests[0]);

        return { allowed: true, remaining, resetIn: Math.max(0, resetIn) };
    }
}

const rateLimiter = new RateLimiter();

function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const result = rateLimiter.check(ip);

    res.setHeader('X-RateLimit-Limit', CONFIG.MAX_REQUESTS_PER_WINDOW);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetIn / 1000));

    if (!result.allowed) {
        return res.status(429).json({
            error: 'Too many requests',
            retryAfter: Math.ceil(result.resetIn / 1000),
            message: 'Please wait before making more requests'
        });
    }

    next();
}

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.substring(7);
    const user = db.users.find(u => u.apiKey === token);

    if (!user) {
        return res.status(403).json({ error: 'Invalid API key' });
    }

    req.user = user;
    next();
}

// ============================================================
// نظام Cache
// ============================================================
class Cache {
    constructor() {
        this.cache = new Map();
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expires) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }

    set(key, value, ttl = CONFIG.CACHE_TTL) {
        this.cache.set(key, {
            value: value,
            expires: Date.now() + ttl
        });
    }

    clear() {
        this.cache.clear();
    }

    invalidate(prefix) {
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
    }
}

const cache = new Cache();

// ============================================================
// نقاط النهاية العامة
// ============================================================
app.use(rateLimitMiddleware);

// 1. فحص الصحة
app.get('/healthz', (req, res) => {
    db.trackRequest(req.ip || 'unknown');
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        songsCount: db.songs.length,
        usersCount: db.users.length,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// ============================================================
// نقاط نهاية المستخدمين (مع إصلاح CORS)
// ============================================================

// 2. إنشاء مستخدم جديد
app.post('/api/users', (req, res) => {
    console.log('📝 محاولة إنشاء مستخدم:', req.body);
    try {
        const { username, email } = req.body;

        if (!username || !email) {
            return res.status(400).json({
                error: 'Username and email are required'
            });
        }

        // التحقق من عدم تكرار البريد
        if (db.users.find(u => u.email === email)) {
            return res.status(409).json({
                error: 'Email already exists'
            });
        }

        const newUser = {
            id: 'user-' + Date.now(),
            username: username,
            email: email,
            apiKey: 'sk-' + crypto.randomBytes(32).toString('hex'),
            credits: 50,
            createdAt: new Date().toISOString(),
            totalSongs: 0,
            isActive: true
        };

        db.users.push(newUser);
        db.save();

        console.log('✅ تم إنشاء مستخدم:', username);
        console.log(`   🔑 API Key: ${newUser.apiKey}`);

        res.status(201).json({
            message: 'User created successfully',
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                apiKey: newUser.apiKey,
                credits: newUser.credits
            }
        });
    } catch (error) {
        console.error('❌ Error creating user:', error);
        res.status(500).json({ error: 'Failed to create user: ' + error.message });
    }
});

// 3. الحصول على معلومات المستخدم الحالي
app.get('/api/users/me', (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        console.log('🔐 طلب معلومات المستخدم:', authHeader ? 'Headers present' : 'No auth');

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const token = authHeader.substring(7);
        const user = db.users.find(u => u.apiKey === token);

        if (!user) {
            return res.status(403).json({ error: 'Invalid API key' });
        }

        res.json({
            id: user.id,
            username: user.username,
            email: user.email,
            credits: user.credits,
            totalSongs: user.totalSongs || 0,
            createdAt: user.createdAt
        });
    } catch (error) {
        console.error('❌ Error getting user:', error);
        res.status(500).json({ error: 'Server error: ' + error.message });
    }
});

// 4. جلب جميع المستخدمين (للمشرفين فقط)
app.get('/api/users', authMiddleware, (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        res.status(200).json(db.users);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
// نقاط نهاية الأغاني
// ============================================================

// 5. جلب الأغاني
app.get('/songs', (req, res) => {
    try {
        db.trackRequest(req.ip || 'unknown');

        const cacheKey = 'songs_' + JSON.stringify(req.query);
        const cached = cache.get(cacheKey);
        if (cached) {
            return res.status(200).json({
                ...cached,
                fromCache: true
            });
        }

        let result = [...db.songs];

        if (req.query.userId) {
            result = result.filter(s => s.userId === req.query.userId);
        }
        if (req.query.title) {
            const title = req.query.title.toLowerCase();
            result = result.filter(s => s.title && s.title.toLowerCase().includes(title));
        }
        if (req.query.style) {
            const style = req.query.style.toLowerCase();
            result = result.filter(s => s.style && s.style.toLowerCase().includes(style));
        }
        if (req.query.type) {
            result = result.filter(s => s.type === req.query.type);
        }
        if (req.query.status) {
            result = result.filter(s => s.status === req.query.status);
        }
        if (req.query.fromDate) {
            const from = new Date(req.query.fromDate);
            result = result.filter(s => new Date(s.receivedAt) >= from);
        }
        if (req.query.toDate) {
            const to = new Date(req.query.toDate);
            result = result.filter(s => new Date(s.receivedAt) <= to);
        }
        if (req.query.search) {
            const search = req.query.search.toLowerCase();
            result = result.filter(s =>
                (s.title && s.title.toLowerCase().includes(search)) ||
                (s.style && s.style.toLowerCase().includes(search)) ||
                (s.prompt && s.prompt.toLowerCase().includes(search)) ||
                (s.tags && s.tags.toLowerCase().includes(search))
            );
        }

        const sortBy = req.query.sortBy || 'receivedAt';
        const sortOrder = req.query.sortOrder || 'desc';
        result.sort((a, b) => {
            const aVal = a[sortBy] || '';
            const bVal = b[sortBy] || '';
            if (sortOrder === 'asc') {
                return aVal > bVal ? 1 : -1;
            } else {
                return aVal < bVal ? 1 : -1;
            }
        });

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginated = result.slice(startIndex, endIndex);

        const response = {
            total: result.length,
            page: page,
            limit: limit,
            totalPages: Math.ceil(result.length / limit),
            data: paginated
        };

        cache.set(cacheKey, response, 30000);
        res.status(200).json(response);
    } catch (error) {
        console.error('Error fetching songs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 6. جلب أغنية واحدة
app.get('/songs/:taskId', (req, res) => {
    try {
        db.trackRequest(req.ip || 'unknown');
        const song = db.songs.find(s => s.taskId === req.params.taskId);
        if (!song) {
            return res.status(404).json({ error: 'Song not found' });
        }
        res.status(200).json(song);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 7. تحديث أغنية
app.put('/songs/:taskId', authMiddleware, (req, res) => {
    try {
        const taskId = req.params.taskId;
        const song = db.songs.find(s => s.taskId === taskId);

        if (!song) {
            return res.status(404).json({ error: 'Song not found' });
        }

        if (song.userId && song.userId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const allowedFields = ['title', 'style', 'status', 'tags', 'prompt', 'credits'];
        let updated = false;

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined && req.body[field] !== null) {
                song[field] = req.body[field];
                updated = true;
            }
        });

        if (updated) {
            song.updatedAt = new Date().toISOString();
            song.updatedBy = req.user.id;

            db.save();
            cache.invalidate('songs_');
            db.addAuditLog('song_updated', req.user.id, {
                taskId,
                fields: Object.keys(req.body).filter(f => allowedFields.includes(f))
            });

            res.status(200).json({
                message: 'Song updated successfully',
                song: song
            });
        } else {
            res.status(400).json({ error: 'No fields to update' });
        }
    } catch (error) {
        console.error('Error updating song:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 8. حذف أغنية
app.delete('/songs/:taskId', authMiddleware, (req, res) => {
    try {
        const taskId = req.params.taskId;
        const index = db.songs.findIndex(s => s.taskId === taskId);

        if (index === -1) {
            return res.status(404).json({ error: 'Song not found' });
        }

        const song = db.songs[index];

        if (song.userId && song.userId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        db.songs.splice(index, 1);
        db.save();
        cache.invalidate('songs_');
        db.addAuditLog('song_deleted', req.user.id, { taskId, title: song.title });

        res.status(200).json({
            message: 'Song deleted successfully',
            deleted: { taskId: song.taskId, title: song.title }
        });
    } catch (error) {
        console.error('Error deleting song:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 9. حذف كل الأغاني
app.delete('/songs', authMiddleware, (req, res) => {
    try {
        if (req.query.confirm !== 'yes') {
            return res.status(400).json({
                error: 'Confirmation required. Add ?confirm=yes to proceed'
            });
        }

        const count = db.songs.length;
        db.songs = [];
        db.save();
        cache.invalidate('songs_');
        db.addAuditLog('all_songs_deleted', req.user.id, { count });

        res.status(200).json({
            message: `All ${count} songs deleted successfully`,
            deletedCount: count
        });
    } catch (error) {
        console.error('Error deleting all songs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 10. الإحصائيات المتقدمة
app.get('/stats', (req, res) => {
    try {
        db.trackRequest(req.ip || 'unknown');
        const songs = db.songs;
        const total = songs.length;

        const stats = {
            total: total,
            byType: {
                music: songs.filter(s => s.type === 'music').length,
                video: songs.filter(s => s.type === 'video').length
            },
            byStatus: {
                success: songs.filter(s => s.status === 'success').length,
                pending: songs.filter(s => s.status === 'pending').length,
                error: songs.filter(s => s.status === 'error').length
            },
            credits: {
                total: songs.reduce((sum, s) => sum + (s.credits || 0), 0),
                average: songs.length > 0 ? songs.reduce((sum, s) => sum + (s.credits || 0), 0) / songs.length : 0
            },
            duration: {
                total: songs.reduce((sum, s) => sum + (s.duration || 0), 0),
                average: songs.filter(s => s.duration).length > 0 ?
                    songs.filter(s => s.duration).reduce((sum, s) => sum + (s.duration || 0), 0) / songs.filter(s => s.duration).length :
                    0,
                min: songs.filter(s => s.duration).length > 0 ?
                    Math.min(...songs.filter(s => s.duration).map(s => s.duration)) :
                    0,
                max: songs.filter(s => s.duration).length > 0 ?
                    Math.max(...songs.filter(s => s.duration).map(s => s.duration)) :
                    0
            },
            topStyles: (() => {
                const styleCount = {};
                songs.forEach(s => {
                    if (s.style) {
                        const styles = s.style.split(',').map(st => st.trim());
                        styles.forEach(st => {
                            if (st) styleCount[st] = (styleCount[st] || 0) + 1;
                        });
                    }
                });
                return Object.entries(styleCount)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
                    .map(([style, count]) => ({ style, count }));
            })(),
            timeline: (() => {
                const timeline = {};
                songs.forEach(s => {
                    const date = s.receivedAt ? new Date(s.receivedAt).toISOString().slice(0, 10) : 'unknown';
                    timeline[date] = (timeline[date] || 0) + 1;
                });
                return Object.entries(timeline)
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .slice(-30)
                    .map(([date, count]) => ({ date, count }));
            })(),
            users: {
                total: db.users.length,
                active: db.users.filter(u => u.isActive).length,
                totalSongs: db.users.reduce((sum, u) => sum + (u.totalSongs || 0), 0)
            },
            analytics: {
                totalRequests: db.analytics.totalRequests,
                uniqueIps: db.analytics.uniqueIps.size,
                requestsPerHour: Object.entries(db.analytics.hourlyStats || {})
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .slice(-24)
                    .map(([hour, count]) => ({ hour, count }))
            }
        };

        res.status(200).json(stats);
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 11. تصدير البيانات
app.get('/export', (req, res) => {
    try {
        db.trackRequest(req.ip || 'unknown');
        const format = req.query.format || 'json';
        const userId = req.query.userId;

        let data = db.songs;
        if (userId) {
            data = data.filter(s => s.userId === userId);
        }

        if (format === 'json') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename=songs-${Date.now()}.json`);
            return res.status(200).json(data);
        }

        if (format === 'csv') {
            const headers = ['taskId', 'title', 'style', 'status', 'type', 'credits', 'duration', 'receivedAt'];
            const csvRows = [headers.join(',')];

            data.forEach(s => {
                const row = headers.map(h => {
                    let value = s[h] || '';
                    if (typeof value === 'string' && value.includes(',')) {
                        value = `"${value}"`;
                    }
                    return value;
                });
                csvRows.push(row.join(','));
            });

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=songs-${Date.now()}.csv`);
            return res.status(200).send(csvRows.join('\n'));
        }

        if (format === 'json-pretty') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename=songs-${Date.now()}.json`);
            return res.status(200).send(JSON.stringify(data, null, 2));
        }

        res.status(400).json({ error: 'Invalid format. Use json, json-pretty, or csv' });
    } catch (error) {
        console.error('Error exporting:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 12. سجل العمليات
app.get('/audit', authMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const logs = db.auditLogs.slice(-limit).reverse();
        res.status(200).json(logs);
    } catch (error) {
        console.error('Error fetching audit logs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 13. إعادة ضبط الخادم
app.post('/reset', authMiddleware, (req, res) => {
    try {
        if (req.query.confirm !== 'yes') {
            return res.status(400).json({
                error: 'Confirmation required. Add ?confirm=yes to proceed'
            });
        }

        if (req.user.username !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const count = db.songs.length;
        db.songs = [];
        db.save();
        cache.invalidate('songs_');
        db.addAuditLog('server_reset', req.user.id, { count });

        res.status(200).json({
            message: 'Database reset successfully',
            deletedCount: count
        });
    } catch (error) {
        console.error('Error resetting:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// Webhook
// ============================================================
app.post('/webhook', (req, res) => {
    console.log('=== Webhook received ===');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    try {
        const body = req.body;
        let savedCount = 0;
        let userId = req.headers['x-user-id'] || null;

        if (body?.data?.data && Array.isArray(body.data.data)) {
            const taskId = body.data.task_id || body.task_id || null;
            const clips = body.data.data;

            clips.forEach((clip, index) => {
                const song = {
                    type: 'music',
                    taskId: taskId || `unknown-${Date.now()}`,
                    audioId: clip.id || clip.audioId || `clip-${index}`,
                    audioUrl: clip.audio_url || clip.audioUrl || null,
                    downloadUrl: clip.audio_url || clip.audioUrl || null,
                    imageUrl: clip.image_url || clip.imageUrl || null,
                    title: clip.title || clip.name || 'بدون عنوان',
                    style: clip.tags || clip.style || clip.genre || '',
                    prompt: clip.prompt || clip.lyrics || '',
                    status: 'success',
                    receivedAt: new Date().toISOString(),
                    duration: clip.duration || null,
                    modelName: clip.model_name || clip.model || null,
                    sourceAudioUrl: clip.source_audio_url || clip.sourceAudioUrl || null,
                    sourceImageUrl: clip.source_image_url || clip.sourceImageUrl || null,
                    tags: clip.tags || null,
                    credits: 12,
                    userId: userId,
                    createdAt: new Date().toISOString()
                };

                if (song.audioUrl || song.audioId) {
                    const exists = db.songs.some(s =>
                        s.taskId === song.taskId && s.audioId === song.audioId
                    );
                    if (!exists) {
                        db.songs.push(song);
                        savedCount++;
                        if (userId) {
                            const user = db.users.find(u => u.id === userId);
                            if (user) {
                                user.totalSongs = (user.totalSongs || 0) + 1;
                                user.credits = (user.credits || 0) - 12;
                            }
                        }
                        console.log(`✅ تم حفظ الأغنية: ${song.title} (${song.audioId})`);
                    }
                }
            });

            db.save();
            cache.invalidate('songs_');
            db.addAuditLog('webhook_received', userId || 'system', {
                count: savedCount,
                taskId: taskId
            });

            return res.status(200).json({
                received: true,
                saved: savedCount,
                total: db.songs.length
            });
        }

        if (body?.data?.video_url) {
            const taskId = body.data.task_id || body.task_id || null;
            const video = {
                type: 'video',
                taskId: taskId || `video-${Date.now()}`,
                videoUrl: body.data.video_url || null,
                audioId: null,
                audioUrl: null,
                downloadUrl: body.data.video_url || null,
                imageUrl: null,
                title: '🎬 فيديو',
                style: '',
                prompt: '',
                status: 'success',
                receivedAt: new Date().toISOString(),
                credits: 0,
                duration: null,
                modelName: null,
                userId: userId,
                createdAt: new Date().toISOString()
            };

            if (video.videoUrl) {
                const exists = db.songs.some(s => s.taskId === video.taskId);
                if (!exists) {
                    db.songs.push(video);
                    savedCount++;
                    if (userId) {
                        const user = db.users.find(u => u.id === userId);
                        if (user) user.totalSongs = (user.totalSongs || 0) + 1;
                    }
                }
            }

            db.save();
            cache.invalidate('songs_');
            return res.status(200).json({
                received: true,
                saved: savedCount,
                total: db.songs.length
            });
        }

        console.log('⚠️ تنسيق webhook غير معروف:', body);
        res.status(200).json({
            received: true,
            message: 'Unknown format, acknowledged'
        });

    } catch (error) {
        console.error('❌ خطأ في معالجة webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// تشغيل الخادم
// ============================================================
app.listen(PORT, () => {
    console.log(`✅ الخادم يعمل على المنفذ ${PORT}`);
    console.log(`\n📋 نقاط النهاية المتاحة:`);
    console.log(`   🏠 GET  /healthz               - فحص الصحة`);
    console.log(`   📊 GET  /songs                 - جلب الأغاني`);
    console.log(`   🔍 GET  /songs/:taskId         - جلب أغنية واحدة`);
    console.log(`   ✏️ PUT  /songs/:taskId         - تحديث أغنية (محمي)`);
    console.log(`   🗑️ DELETE /songs/:taskId       - حذف أغنية (محمي)`);
    console.log(`   🗑️ DELETE /songs?confirm=yes   - حذف كل الأغاني (محمي)`);
    console.log(`   📈 GET  /stats                 - إحصائيات متقدمة`);
    console.log(`   📥 GET  /export?format=json    - تصدير البيانات`);
    console.log(`   👤 POST /api/users             - إنشاء مستخدم جديد`);
    console.log(`   🔐 GET  /api/users/me          - معلومات المستخدم (محمي)`);
    console.log(`   📜 GET  /audit                 - سجل العمليات (محمي)`);
    console.log(`   🔄 POST /reset?confirm=yes     - إعادة ضبط الخادم (محمي)`);
    console.log(`   📨 POST /webhook               - استقبال Webhook`);
    console.log(`\n💡 عدد المستخدمين: ${db.users.length}`);
    console.log(`💡 عدد الأغاني: ${db.songs.length}`);
});
