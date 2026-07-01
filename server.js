const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

// ============================================================
// إصلاح مشكلة Premature close مع Google APIs
// ============================================================
try {
    const gaxios = require('gaxios');
    const originalRequest = gaxios.Gaxios.prototype.request;
    gaxios.Gaxios.prototype.request = async function (opts) {
        if (opts.url && opts.url.includes('googleapis.com/oauth2')) {
            const fetch = global.fetch;
            const response = await fetch(opts.url, {
                method: opts.method || 'POST',
                headers: opts.headers || {},
                body: opts.data ? JSON.stringify(opts.data) : undefined,
            });
            const data = await response.json();
            return {
                data: data,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                config: opts,
            };
        }
        return originalRequest.call(this, opts);
    };
    console.log('✅ تم تفعيل إصلاح Premature close لـ Google APIs');
} catch (error) {
    console.warn('⚠️ فشل تفعيل إصلاح Google APIs:', error.message);
}

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
// Google Drive Backup - الإعدادات
// ============================================================
let googleAuth = null;
let driveService = null;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

console.log('🔍 [ENV] GOOGLE_DRIVE_CREDENTIALS:', process.env.GOOGLE_DRIVE_CREDENTIALS ? '✅ موجود (طول: ' + process.env.GOOGLE_DRIVE_CREDENTIALS.length + ' حرف)' : '❌ غير موجود');
console.log('🔍 [ENV] GOOGLE_DRIVE_FOLDER_ID:', GOOGLE_DRIVE_FOLDER_ID || '❌ غير موجود');

if (process.env.GOOGLE_DRIVE_CREDENTIALS) {
    try {
        let credsRaw = process.env.GOOGLE_DRIVE_CREDENTIALS.trim();
        const credentials = JSON.parse(credsRaw);
        console.log('✅ تم تحميل بيانات الاعتماد بنجاح');
        googleAuth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/drive']  // ✅ النطاق الأوسع
        });
        driveService = google.drive({ version: 'v3', auth: googleAuth });
        console.log('✅ تم تفعيل Google Drive Backup');
    } catch (error) {
        console.error('❌ فشل تحميل بيانات اعتماد Google Drive:', error.message);
    }
} else {
    console.warn('⚠️ GOOGLE_DRIVE_CREDENTIALS غير موجودة، لن يتم رفع النسخ الاحتياطية إلى Google Drive');
}

// دالة رفع الملف إلى Google Drive
async function uploadToGoogleDrive(filePath, fileName) {
    if (!driveService || !GOOGLE_DRIVE_FOLDER_ID) {
        console.warn('⚠️ Google Drive غير مفعّل، تخطي الرفع');
        return false;
    }
    try {
        const fileMetadata = {
            name: fileName || path.basename(filePath),
            parents: [GOOGLE_DRIVE_FOLDER_ID]
        };
        const media = {
            mimeType: 'application/json',
            body: fs.createReadStream(filePath)
        };
        const response = await driveService.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink'
        });
        console.log(`✅ تم رفع النسخة الاحتياطية إلى Google Drive: ${response.data.name} (ID: ${response.data.id})`);
        return response.data;
    } catch (error) {
        console.error('❌ فشل رفع النسخة إلى Google Drive:', error.message);
        if (error.message.includes('permission') || error.message.includes('403')) {
            console.error('❌ تحقق من أن حساب الخدمة لديه صلاحية الكتابة على المجلد المشترك');
            console.error('❌ تحقق من أن المجلد مشترك مع: ' + (process.env.GOOGLE_DRIVE_CREDENTIALS ? JSON.parse(process.env.GOOGLE_DRIVE_CREDENTIALS).client_email : 'غير معروف'));
        }
        return false;
    }
}

// دالة إنشاء نسخة احتياطية محلية + رفع إلى Google Drive
function createBackup() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        const backupFile = path.join(backupDir, `data_${timestamp}.json`);
        const currentData = fs.readFileSync(CONFIG.DATA_FILE, 'utf8');
        fs.writeFileSync(backupFile, currentData);
        console.log(`✅ نسخة احتياطية محلية: ${backupFile}`);
        
        if (driveService && GOOGLE_DRIVE_FOLDER_ID) {
            uploadToGoogleDrive(backupFile, `data_${timestamp}.json`).catch(console.error);
        }
        
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('data_') && f.endsWith('.json'))
            .sort();
        if (files.length > 20) {
            const toDelete = files.slice(0, files.length - 20);
            toDelete.forEach(f => {
                fs.unlinkSync(path.join(backupDir, f));
                console.log(`🗑️ تم حذف نسخة محلية قديمة: ${f}`);
            });
        }
        return backupFile;
    } catch (error) {
        console.error('❌ فشل إنشاء النسخة الاحتياطية:', error);
        return null;
    }
}

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
            if (typeof createBackup === 'function') {
                createBackup();
            }
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
// نقاط نهاية النسخ الاحتياطي
// ============================================================
app.get('/api/backup/drive-list', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'غير مصرح لك' });
    }
    if (!driveService || !GOOGLE_DRIVE_FOLDER_ID) {
        return res.status(503).json({ error: 'Google Drive غير مفعّل' });
    }
    try {
        const response = await driveService.files.list({
            q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType='application/json'`,
            fields: 'files(id, name, createdTime, size)',
            orderBy: 'createdTime desc'
        });
        res.json({ data: response.data.files });
    } catch (error) {
        console.error('Error listing drive files:', error);
        res.status(500).json({ error: 'فشل جلب القائمة من Google Drive' });
    }
});

app.get('/api/backup/drive-download/:fileId', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'غير مصرح لك' });
    }
    if (!driveService) {
        return res.status(503).json({ error: 'Google Drive غير مفعّل' });
    }
    try {
        const fileId = req.params.fileId;
        const response = await driveService.files.get({
            fileId: fileId,
            alt: 'media'
        }, { responseType: 'stream' });
        res.setHeader('Content-Disposition', `attachment; filename="backup_${fileId}.json"`);
        response.data.pipe(res);
    } catch (error) {
        console.error('Error downloading file from drive:', error);
        res.status(500).json({ error: 'فشل تحميل الملف من Google Drive' });
    }
});

app.post('/api/backup/manual', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'غير مصرح لك' });
    }
    const backupFile = createBackup();
    if (backupFile) {
        res.json({ success: true, file: backupFile });
    } else {
        res.status(500).json({ error: 'فشل إنشاء النسخة الاحتياطية' });
    }
});

app.get('/api/backup/latest-local', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'غير مصرح لك' });
    }
    try {
        const backupDir = path.join(__dirname, 'backups');
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('data_') && f.endsWith('.json'))
            .sort();
        if (files.length === 0) {
            return res.status(404).json({ error: 'لا توجد نسخ احتياطية محلية' });
        }
        const latest = files[files.length - 1];
        const filePath = path.join(backupDir, latest);
        res.download(filePath, `backup_${latest}`);
    } catch (error) {
        res.status(500).json({ error: 'فشل تحميل النسخة الاحتياطية' });
    }
});

// ============================================================
// نقاط نهاية المصادقة والأغاني والمستخدمين والمراسلة والإحصائيات والـ Proxy
// ============================================================
// (باقي الكود كما هو - تم حذفه للاختصار، لكنه موجود في الملف الأصلي)
// ============================================================

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`👑 Admin: info@msproductions.com / Msm12345`);
    console.log(`📋 Endpoints ready.`);
    if (driveService && GOOGLE_DRIVE_FOLDER_ID) {
        console.log(`✅ Google Drive Backup active. Folder ID: ${GOOGLE_DRIVE_FOLDER_ID}`);
    } else {
        console.warn(`⚠️ Google Drive Backup not configured. Set GOOGLE_DRIVE_CREDENTIALS and GOOGLE_DRIVE_FOLDER_ID`);
    }
});
