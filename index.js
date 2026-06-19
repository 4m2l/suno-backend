const express = require('express');
const axios = require('axios');
const cors = require('cors'); // لحل مشكلة حظر المتصفحات

const app = express();
app.use(express.json());
app.use(cors()); // السماح لواجهتك بالاتصال بالخادم

// 1. نقطة استلام الطلب من واجهتك (تطبيق محمود)
app.post('/api/generate-music', async (req, res) => {
    try {
        // استخراج مفتاح API السري من رأس الطلب
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: "Missing Authorization header" });
        }

        // استخراج البيانات القادمة من الواجهة
        const {
            prompt,
            tags,
            title,
            mv,
            make_instrumental,
            callback_url,
            negative_tags 
        } = req.body;

        // دمج الكلمات المستبعدة مع الستايل لمنع خطأ 500
        let finalTags = tags || "";
        if (negative_tags) {
            finalTags = `${finalTags}, avoid: ${negative_tags}`;
        }

        // بناء الطلب "النظيف" والمطابق 100% لشروط Suno
        const sunoPayload = {
            prompt: prompt,
            tags: finalTags,
            title: title,
            mv: mv || "v5.5",
            make_instrumental: make_instrumental || false,
            callback_url: callback_url || ""
        };

        console.log("Sending clean payload to Suno...");

        // إرسال الطلب إلى سيرفرات Suno
        const response = await axios.post('https://api.sunoapi.org/api/v1/generate', sunoPayload, {
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            }
        });

        // إرجاع رد Suno الحقيقي (والذي يحتوي على Task ID) لواجهتك
        res.status(200).json(response.data);

    } catch (error) {
        // التقاط الأخطاء بدقة وإرسالها للواجهة
        console.error("Suno API Error:", error.response ? error.response.data : error.message);
        res.status(error.response?.status || 500).json(error.response?.data || { error: "Internal Server Error" });
    }
});

// 2. نقطة استلام الـ Webhook (الأغنية الجاهزة)
app.post('/api/webhook/suno', (req, res) => {
    console.log("Webhook received successfully:", req.body);
    // يمكنك لاحقاً برمجة هذه النقطة لحفظ الرابط في قاعدة بيانات
    res.status(200).send("Webhook OK");
});

// تشغيل الخادم
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Mahmood's Server is running on port ${PORT}`);
});
