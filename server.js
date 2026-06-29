const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const songs = [];

app.get('/healthz', (req, res) => res.send('OK'));
app.get('/songs', (req, res) => res.json(songs));
app.post('/webhook', (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body, null, 2));
  const taskId = req.body?.data?.task_id || req.body?.task_id || null;
  const clips = req.body?.data?.data || req.body?.data?.clips || [];
  if (Array.isArray(clips)) {
    clips.forEach(clip => {
      songs.push({
        taskId: taskId || 'unknown',
        audioId: clip.id || 'unknown',
        audioUrl: clip.audio_url || null,
        downloadUrl: clip.audio_url || null,
        title: clip.title || 'بدون عنوان',
        style: clip.tags || '',
        prompt: clip.prompt || '',
        status: 'success',
        receivedAt: new Date().toISOString()
      });
    });
  }
  res.json({ received: true, total: songs.length });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
