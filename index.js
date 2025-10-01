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
        { role: "system", content: "Ты сценарист, напиши короткий скрипт для видео, не длиннее 40 секунд речи." },
        { role: "user", content: `Тема: ${topic}` }
      ],
      max_tokens: 150
    })
  });

  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

// === 2. HeyGen генерит видео по тексту ===
// === 2. HeyGen генерит видео по тексту ===
// === 2. HeyGen генерит видео по тексту ===
async function generateHeygenVideo(script, outFile) {
  const resp = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      background: "white",
      dimension: { width: 1280, height: 720 },
      video_inputs: [
        {
          character: { type: "preset", character_id: "Anna_public_3_20240108" },
          voice: { type: "preset", voice_id: "1bd001e7e50f421d891986aad5158bc8" },
          input_text: script
        }
      ]
    })
  });

  const text = await resp.text();
  console.log("HEYGEN RAW:", text);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("HeyGen вернул не JSON (скорее всего 401 Unauthorized). Проверь HEYGEN_KEY");
  }

  if (!data.data || !data.data.video_id) {
    throw new Error("HeyGen error: " + JSON.stringify(data));
  }

  const videoId = data.data.video_id;

  // ждём готовности
  let videoUrl;
  while (true) {
    const statusResp = await fetch(`https://api.heygen.com/v2/video/status?video_id=${videoId}`, {
      headers: { "X-Api-Key": process.env.HEYGEN_KEY }
    });
    const statusData = await statusResp.json();

    if (statusData.data.status === "completed") {
      videoUrl = statusData.data.video_url;
      break;
    }
    if (statusData.data.status === "failed") {
      throw new Error("HeyGen failed to generate video");
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  // скачиваем
  const videoResp = await fetch(videoUrl);
  const buffer = Buffer.from(await videoResp.arrayBuffer());
  fs.writeFileSync(outFile, buffer);
}

// === 3. API ===
app.post("/generate", async (req, res) => {
  try {
    const { topic } = req.body;
    const id = Date.now();
    const dir = "outputs";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    // скрипт
    const script = await generateScript(topic);
    fs.writeFileSync(`${dir}/${id}.txt`, script);

    // видео
    const videoFile = `${dir}/${id}.mp4`;
    await generateHeygenVideo(script, videoFile);

    res.json({
      status: "ok",
      script,
      video: `/outputs/${id}.mp4`
    });
  } catch (err) {
    console.error("🔥 ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.use("/outputs", express.static("outputs"));

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
