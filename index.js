import express from "express";
import fetch from "node-fetch";
import fs from "fs";
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

// === 2. HeyGen генерит видео (без ожидания статуса) ===
async function generateHeygenVideo(script, outFile) {
  const avatar_id = "Annie_expressive7_public"; 
  const voice_id = "1bd001e7e50f421d891986aad5158bc8";

  const createResp = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      dimension: { width: 1280, height: 720 },
      background: { type: "color", value: "#ffffff" },
      video_inputs: [
        {
          avatar: { avatar_id },
          voice: { type: "text", voice_id, input_text: script }
        }
      ]
    })
  });

  const createText = await createResp.text();
  console.log("HEYGEN CREATE RAW:", createResp.status, createText);

  if (!createResp.ok) throw new Error(`HeyGen create failed: ${createText}`);
  const createData = JSON.parse(createText);

  // сразу берём video_url, если оно есть
  const videoUrl = (createData.data && createData.data.video_url) || createData.video_url;
  if (!videoUrl) throw new Error("No video_url returned (скорее всего ограничение бесплатного тарифа)");

  // качаем ролик
  const fileResp = await fetch(videoUrl);
  if (!fileResp.ok) {
    const bt = await fileResp.text();
    throw new Error(`Download failed: ${fileResp.status} ${bt}`);
  }
  const buf = Buffer.from(await fileResp.arrayBuffer());
  fs.writeFileSync(outFile, buf);
}

// === 3. API ===
app.post("/generate", async (req, res) => {
  try {
    const { topic } = req.body;
    const id = Date.now();
    const dir = "outputs";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    const script = await generateScript(topic);
    fs.writeFileSync(`${dir}/${id}.txt`, script);

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
