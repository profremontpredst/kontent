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

// === берём первый доступный аватар ===
async function pickDefaultAvatarId() {
  const r = await fetch("https://api.heygen.com/v2/avatars", {
    headers: { "X-Api-Key": process.env.HEYGEN_KEY }
  });
  const t = await r.text();
  console.log("AVATARS RAW:", r.status, t);
  const data = JSON.parse(t);
  const list = (data.avatars || []).filter(a => a && typeof a.avatar_id === "string");
  if (!list.length) throw new Error("No avatars available");
  const nonPremium = list.find(a => a.premium === false) || list[0];
  return nonPremium.avatar_id;
}

// === берём первый доступный голос EN ===
async function pickDefaultVoiceId() {
  const r = await fetch("https://api.heygen.com/v2/voices", {
    headers: { "X-Api-Key": process.env.HEYGEN_KEY }
  });
  const t = await r.text();
  console.log("VOICES RAW:", r.status, t);
  const data = JSON.parse(t);
  const list = (data.voices || []).filter(v => v && typeof v.voice_id === "string");
  if (!list.length) throw new Error("No voices available");
  const en = list.find(v => (v.language || "").toLowerCase().startsWith("en"));
  return (en || list[0]).voice_id;
}

// === 2. HeyGen генерит видео ===
async function generateHeygenVideo(script, outFile) {
  const [avatar_id, voice_id] = await Promise.all([
    pickDefaultAvatarId(),
    pickDefaultVoiceId()
  ]);

  const createResp = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      dimension: { width: 1280, height: 720 },
      background: { type: "color", value: "#ffffff" },   // 👈 фон на верхнем уровне
      video_inputs: [
        {
          avatar: { avatar_id },                         // 👈 avatar, не character
          voice: { type: "text", voice_id, input_text: script }
        }
      ]
    })
  });

  const createText = await createResp.text();
  console.log("HEYGEN CREATE RAW:", createResp.status, createText);
  if (!createResp.ok) throw new Error(`HeyGen create failed: ${createText}`);
  const createData = JSON.parse(createText);
  const videoId = createData.video_id || (createData.data && createData.data.video_id);
  if (!videoId) throw new Error("No video_id in create response");

  // ждём готовности
  let videoUrl;
  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    const st = await fetch(`https://api.heygen.com/v2/video/status?video_id=${encodeURIComponent(videoId)}`, {
      headers: { "X-Api-Key": process.env.HEYGEN_KEY }
    });
    const stText = await st.text();
    console.log("HEYGEN STATUS RAW:", st.status, stText);
    if (!st.ok) throw new Error(`HeyGen status failed: ${stText}`);
    const stData = JSON.parse(stText);
    const status = (stData.data && stData.data.status) || stData.status;
    if (status === "completed") {
      videoUrl = (stData.data && stData.data.video_url) || stData.video_url;
      break;
    }
    if (status === "failed") throw new Error("HeyGen failed to generate video");
  }

  // скачиваем ролик
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
