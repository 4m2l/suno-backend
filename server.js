const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, 'database.json');

const readDB = () => {
    if (!fs.existsSync(DB_PATH)) return [];
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } 
    catch { return []; }
};
const writeDB = (data) => {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
};

// نقطة استقبال الأغاني من Suno
app.post('/webhook', (req, res) => {
    console.log('📩 تم استقبال أغنية جديدة!');
    const payload = req.body;

    const taskId = payload.taskId || payload.id || 'unknown';
    const audioId = payload.audioId || payload.data?.id || 'unknown';
    const audioUrl = payload.audioUrl || payload.data?.audio_url || null;
    const downloadUrl = payload.downloadUrl || payload.data?.download_url || null;
    const prompt = payload.prompt || payload.data?.prompt || 'بدون وصف';
    const title = payload.title || payload.data?.title || 'بدون عنوان';
    const style = payload.style || payload.data?.style || '';

    const db = readDB();
    const newEntry = { taskId, audioId, audioUrl, downloadUrl, title, prompt, style, receivedAt: new Date().toISOString() };
    
    // نضيفها في الأعلى عشان تظهر أولاً
    db.unshift(newEntry);
    writeDB(db);
    
    res.json({ received: true });
});

// نقطة عرض الأغاني لتطبيقك
app.get('/songs', (req, res) => {
    res.json(readDB());
});

app.listen(PORT, () => {
    console.log(`السيرفر شغال على المنفذ ${PORT}`);
});
