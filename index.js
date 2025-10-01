// index.js
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 3000;

// === 1. GPT пишет скрипт ===
async function generateScript(topic) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Ты сценарист, напиши короткий скрипт для видео" },
        { role: "user", content: `Тема: ${topic}` }
      ],
      max_tokens: 300
    })
  });
  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

// === 2. ElevenLabs озвучка ===
async function textToSpeech(text, outFile) {
  const resp = await fetch("https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL", {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVEN_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 }
    })
  });

  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outFile, buffer);
}

// === 3. HeyGen видео (говорящее лицо) ===
async function generateHeygenVideo(audioFile, outFile) {
  // Загружаем аудио
  const audioData = fs.readFileSync(audioFile);
  const uploadResp = await fetch("https://api.heygen.com/v1/media/upload", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.HEYGEN_KEY}` },
    body: audioData
  });
  const upload = await uploadResp.json();
  const audioUrl = upload.data?.url;

  // Запускаем видео-генерацию
  const resp = await fetch("https://api.heygen.com/v1/video/generate", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.HEYGEN_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      video_inputs: [{
        actor: "default", // можно заменить на актёра из библиотеки HeyGen
        audio_url: audioUrl
      }]
    })
  });

  const data = await resp.json();
  const videoId = data.data.video_id;

  // Ждём готовности
  let videoUrl;
  while (true) {
    const statusResp = await fetch(`https://api.heygen.com/v1/video/status?video_id=${videoId}`, {
      headers: { "Authorization": `Bearer ${process.env.HEYGEN_KEY}` }
    });
    const statusData = await statusResp.json();
    if (statusData.data.status === "completed") {
      videoUrl = statusData.data.video_url;
      break;
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  // Скачиваем
  const videoResp = await fetch(videoUrl);
  const buffer = Buffer.from(await videoResp.arrayBuffer());
  fs.writeFileSync(outFile, buffer);
}

// === 4. API ===
app.post("/generate", async (req, res) => {
  try {
    const { topic } = req.body;
    const id = Date.now();
    const dir = "outputs";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    // Скрипт
    const script = await generateScript(topic);
    fs.writeFileSync(`${dir}/${id}.txt`, script);

    // Голос
    const voiceFile = `${dir}/${id}.mp3`;
    await textToSpeech(script, voiceFile);

    // Видео
    const videoFile = `${dir}/${id}.mp4`;
    await generateHeygenVideo(voiceFile, videoFile);

    res.json({
      status: "ok",
      script,
      video: `/outputs/${id}.mp4`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.use("/outputs", express.static("outputs"));

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
