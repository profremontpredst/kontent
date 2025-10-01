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

// ===== 1) GPT пишет скрипт =====
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

  const text = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI failed: ${resp.status} ${text}`);
  const data = JSON.parse(text);
  return data.choices[0].message.content.trim();
}

// ===== 2) HeyGen генерит видео (V2 create + V1 status) =====
const AVATAR_ID = "Annie_expressive7_public"; // <- из твоего списка avatars.json

async function generateHeygenVideo(script, outFile) {
  // --- create (V2)
  const createBody = {
    dimension: { width: 1280, height: 720 },
    video_inputs: [
      {
        character: { type: "avatar", avatar_id: AVATAR_ID },
        voice: { type: "silence", duration: 1.0 }, // valid SilenceVoiceSettings
        background: { type: "color", value: "#ffffff" }
      }
    ]
  };

  const createResp = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(createBody)
  });

  const createText = await createResp.text();
  console.log("HEYGEN CREATE RAW:", createResp.status, createText);
  if (!createResp.ok) throw new Error(`HeyGen create failed: ${createText}`);

  const createData = JSON.parse(createText);
  const videoId =
    (createData.data && createData.data.video_id) || createData.video_id;
  if (!videoId) throw new Error("No video_id in create response");

  // --- poll status (V1 /video_status.get)
  let videoUrl;
  while (true) {
    await new Promise(r => setTimeout(r, 4000));

    const st = await fetch(
  `https://api.heygen.com/v2/video/status?video_id=${encodeURIComponent(videoId)}`,
  { headers: { "X-Api-Key": process.env.HEYGEN_KEY } }
);

    const stText = await st.text();
    console.log("HEYGEN STATUS RAW:", st.status, stText);

    if (!st.ok) throw new Error(`HeyGen status failed: ${stText}`);

    const stData = JSON.parse(stText);
    const d = stData.data || {};
    if (d.status === "completed") {
      videoUrl = d.video_url;
      if (!videoUrl) throw new Error("Status completed but video_url missing");
      break;
    }
    if (d.status === "failed") {
      throw new Error(`HeyGen failed: ${JSON.stringify(d.error)}`);
    }
    // pending/processing -> продолжаем ждать
  }

  // --- download mp4
  const fileResp = await fetch(videoUrl);
  if (!fileResp.ok) {
    const bt = await fileResp.text();
    throw new Error(`Download failed: ${fileResp.status} ${bt}`);
  }
  const buf = Buffer.from(await fileResp.arrayBuffer());
  fs.writeFileSync(outFile, buf);
}

// ===== 3) API =====
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

    res.json({ status: "ok", script, video: `/outputs/${id}.mp4` });
  } catch (err) {
    console.error("🔥 ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.use("/outputs", express.static("outputs"));

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
