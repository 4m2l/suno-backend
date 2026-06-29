const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// تخزين الأغاني والفيديوهات في الذاكرة (يمكنك استخدام قاعدة بيانات لاحقاً)
const songs = [];

// نقطة فحص الصحة (لـ Railway)
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// جلب جميع العناصر المخزنة
app.get('/songs', (req, res) => {
  res.status(200).json(songs);
});

// نقطة استقبال webhook من Suno API
app.post('/webhook', (req, res) => {
  console.log('=== Webhook received ===');
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const body = req.body;

    // --- 1. صيغة الأغاني (تحتوي على data.data كمصفوفة مقاطع) ---
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
          credits: 12 // يمكنك تعديله حسب منطق الرصيد لديك
        };
        // نتأكد من وجود رابط صوتي على الأقل
        if (song.audioUrl || song.audioId) {
          songs.push(song);
          console.log(`✅ تم حفظ الأغنية: ${song.title} (${song.audioId})`);
        } else {
          console.log('⚠️ تم تخطي المقطع - لا يوجد رابط صوتي:', clip);
        }
      });

      return res.status(200).json({ received: true, saved: clips.length, total: songs.length });
    }

    // --- 2. صيغة الفيديو (تحتوي على video_url) ---
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
        credits: 0
      };
      if (video.videoUrl) {
        songs.push(video);
        console.log(`✅ تم حفظ الفيديو: ${video.taskId}`);
      }
      return res.status(200).json({ received: true, saved: 1, total: songs.length });
    }

    // --- 3. صيغ أخرى غير معروفة ---
    console.log('⚠️ تنسيق webhook غير معروف:', body);
    res.status(200).json({ received: true, message: 'Unknown format, acknowledged' });

  } catch (error) {
    console.error('❌ خطأ في معالجة webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// بدء الخادم
app.listen(PORT, () => {
  console.log(`✅ الخادم يعمل على المنفذ ${PORT}`);
  console.log(`   - فحص الصحة: /healthz`);
  console.log(`   - الأغاني: /songs`);
  console.log(`   - Webhook: /webhook`);
});
