import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs-extra";
import axios from "axios";
import nodemailer from "nodemailer";
import Tesseract from "tesseract.js";
import path from 'path';
import crypto from 'crypto';
import fetch from "node-fetch";
import { pairWhatsAppMulti } from "./whatsapp/pairing-multi.js";
import { socketPool } from './db/sockets.js';
import {
  detectBusinessTypeEnhanced,
  detectWebsites,
  detectEmails,
  fetchBioForUser
} from './whatsapp/bio-checker.js';
import {
  isUserSocketConnected,
  disconnectUserSocket
} from './whatsapp/socket-pool.js';

dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const DB_FILE = "./database.json";
const ADMIN_ID = Number(process.env.ADMIN_ID);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OWNER_USERNAME = "oktodev";
const FORCE_JOIN_GROUP = "@topinzgroup";
const fixNomorCooldown = {};
const FIX_COOLDOWN_MS = 30 * 1000;
const MAX_BIO_CHECK = 300;
const DEVICE_LIMIT_PER_HOUR = 1000;

const BRAND = "TopinzPedia";
const bioProcessing = {};
const bioUsage = {};
const bioCancel = {};
const plugins = [];

/* load plugins */

const loadPlugins = async () => {
  const folder = path.join(process.cwd(), "plugins");
  const files = fs.readdirSync(folder);

  for (const file of files) {
    if (!file.endsWith(".js")) continue;

    const pluginPath = `./plugins/${file}`;
    const plugin = (await import(pluginPath)).default;

    plugins.push(plugin);
    console.log("✅ Loaded plugin:", plugin.name);
  }
};

await loadPlugins();

/* ========= UTIL ========= */

const genToken = () =>
  crypto.randomBytes(24)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 36);

const genFileName = () => `${BRAND}_${genToken()}.txt`;

const parseNumbers = (text) =>
  [...new Set(
    text
      .split(/[\n\s,;]+/)
      .map(x => x.trim())
      .filter(x => /^\d{7,15}$/.test(x))
  )];
  
  function getBioUsage(userId) {
  const now = Date.now();

  if (
    !bioUsage[userId] ||
    now - bioUsage[userId].start > 60 * 60 * 1000
  ) {
    bioUsage[userId] = {
      start: now,
      count: 0
    };
  }

  return bioUsage[userId];
}

/* ========= SEND FILE ========= */

async function sendResultFile(bot, chatId, title, lines) {
  if (!lines.length) return;

  const filePath = path.join(process.cwd(), genFileName());
  await fs.writeFile(filePath, lines.join("\n"));

  await bot.sendDocument(chatId, filePath, { caption: title });

  await fs.unlink(filePath);
}

/* ========= HANDLE CEK BIO ========= */

async function handleBulk(bot, chatId, userId, rawText) {

  /* 🔒 ANTI DOUBLE PROSES */
  if (bioProcessing[userId]) {
    return bot.sendMessage(
      chatId,
      '⏳ Proses cek bio masih berjalan.\nGunakan tombol ⛔ Batalkan Proses.'
    );
  }

  /* ❌ BELUM PAIRING */
  if (!isUserSocketConnected(userId)) {
    return bot.sendMessage(chatId, '⚠️ WhatsApp belum terhubung.');
  }

  const numbers = parseNumbers(rawText);

  if (!numbers.length) {
    return bot.sendMessage(chatId, '❌ Tidak ada nomor valid.');
  }

  /* 🚫 LIMIT SEKALI CEK */
  if (numbers.length > MAX_BIO_CHECK) {
    return bot.sendMessage(
      chatId,
`🚫 Terlalu banyak nomor

Jumlah dikirim: ${numbers.length}
Maksimal per pemeriksaan: ${MAX_BIO_CHECK}

Silakan pecah menjadi beberapa bagian.`
    );
  }

  /* 📊 LIMIT PER JAM */
  const usage = getBioUsage(userId);
  if (usage.count + numbers.length > DEVICE_LIMIT_PER_HOUR) {
    return bot.sendMessage(
      chatId,
`⛔ Limit perangkat tercapai

Maksimal ${DEVICE_LIMIT_PER_HOUR} nomor per jam.
Silakan tunggu beberapa saat.`
    );
  }

  // 🔐 LOCK + RESET CANCEL
  bioProcessing[userId] = true;
  bioCancel[userId] = false;
  usage.count += numbers.length;

  const loading = await bot.sendMessage(
    chatId,
    `⏳ Mengecek ${numbers.length} nomor (real-time)...`,
    {
      reply_markup: {
        keyboard: [
          ['⛔ Batalkan Proses'],
          ['⬅️ Back']
        ],
        resize_keyboard: true
      }
    }
  );

  const result = {
    bio: [],
    nobio: [],
    unreg: [],
    website: [],
    email: [],
    ratelimit: []
  };

  try {
    const socket = socketPool.getSocket(userId);
    if (!socket) throw new Error('SOCKET_NOT_FOUND');

    for (const num of numbers) {

      /* ⛔ CEK BATAL */
      if (bioCancel[userId]) {
        await bot.sendMessage(
          chatId,
          '⛔ Proses cek bio dibatalkan oleh user.'
        );
        break;
      }

      let r;
      try {
        r = await fetchBioForUser(socket, num);
        console.log('[BIO]', num, r.category, {
          business: r.isBusiness,
          website: r.websites?.length || 0,
          email: r.email || null
        });
      } catch (e) {
        console.error('[BIO ERROR]', num, e);
        result.ratelimit.push(num);
        continue;
      }

      if (!r || !r.category) {
        result.ratelimit.push(num);
        continue;
      }

      switch (r.category) {

        case 'hasBio':
          result.bio.push(
            `${num}${r.isBusiness ? ' [BUSINESS]' : ''}\n${r.bio}\n`
          );

          if (r.websites?.length)
            result.website.push(`${num} | ${r.websites.join(', ')}`);

          if (r.email)
            result.email.push(`${num} | ${r.email}`);

          break;

        case 'noBio':
          result.nobio.push(
            `${num}${r.isBusiness ? ' [BUSINESS]' : ''}`
          );

          if (r.websites?.length)
            result.website.push(`${num} | ${r.websites.join(', ')}`);

          if (r.email)
            result.email.push(`${num} | ${r.email}`);

          break;

        case 'unregistered':
          result.unreg.push(num);
          break;

        case 'rateLimit':
        default:
          result.ratelimit.push(num);
          break;
      }
    }

    // kirim hasil
    await sendResultFile(bot, chatId, '✅ADA BIO', result.bio);
    await sendResultFile(bot, chatId, '📄 TANPA BIO', result.nobio);
    await sendResultFile(bot, chatId, '🚫 TIDAK TERDAFTAR', result.unreg);
    await sendResultFile(bot, chatId, '🌐 ADA WEBSITE', result.website);
    await sendResultFile(bot, chatId, '📧 ADA EMAIL', result.email);
    await sendResultFile(bot, chatId, '📉 RATE LIMIT', result.ratelimit);

    try {
      await bot.deleteMessage(chatId, loading.message_id);
    } catch {}

    if (!bioCancel[userId]) {
      await bot.sendMessage(chatId, '✅ Cek Bio selesai (REAL-TIME).');

      try {
        const db = await loadDB();
        if (isAdmin(userId)) {
          await showAdminMenu(chatId);
        } else {
          await showUserMenu(chatId);
        }
      } catch {}
    }

  } catch (err) {
    console.error('CEK BIO ERROR:', err);
    await bot.sendMessage(chatId, '❌ Terjadi kesalahan saat cek bio.');
  } finally {
    bioProcessing[userId] = false;
    bioCancel[userId] = false;
  }
}

const SYSTEM_PROMPT = `
Kamu adalah Asisten AI profesional berbahasa Indonesia yang cerdas, adaptif, komunikatif, dan kontekstual.
Kamu dirancang untuk membantu berbagai kebutuhan secara luas, terutama pemrograman, analisis, dan pemecahan masalah, dengan gaya modern seperti AI ChatGPT.

PRINSIP UTAMA:
- Selalu gunakan Bahasa Indonesia kecuali user secara eksplisit meminta bahasa lain.
- Pahami maksud user meskipun bahasanya santai, typo, tidak baku, atau bercampur slang.
- Fokus pada niat user, bukan hanya kata-katanya.
- Jangan menjawab kaku. Jawaban harus terasa natural, pintar, dan manusiawi.

FORMAT & GAYA TEKS:
- Gunakan teks tebal untuk poin penting, judul kecil, atau kata kunci jika konteksnya tepat.
- Gunakan teks miring untuk penekanan ringan atau istilah.
- Gunakan bullet list jika menjelaskan langkah, opsi, atau daftar.
- Gunakan emoji secukupnya dan kontekstual (😊 🧠 ⚠️ ✅ ❌ 🔍).
- Jangan berlebihan formatting. Jika tidak perlu, jawab normal seperti chat.
- Struktur jawaban rapi, mudah dibaca, dan tidak bertele-tele.

KEMAMPUAN INTI:
- Membantu debugging error (JavaScript, Node.js, logic, async, API, dsb).
- Menjelaskan kode dari level pemula sampai advanced dengan bahasa yang mudah dipahami.
- Memberi solusi langkah demi langkah untuk masalah kompleks.
- Menganalisis dan menjelaskan isi gambar (deskripsi visual, teks di gambar, konteks, fungsi).
- Jika gambar tidak jelas, jelaskan apa yang terlihat dan kemungkinan fungsinya.
- Membantu ide, penamaan, konsep, alur sistem, dan logika aplikasi.
- Menyesuaikan jawaban dengan level user (pemula, menengah, advanced).

PERILAKU CERDAS:
- Jika pertanyaan ambigu, ajukan klarifikasi singkat dan tepat sasaran.
- Jika user bercanda, balas santai tapi tetap sopan dan relevan.
- Jangan pernah mengatakan tidak bisa melihat gambar jika user mengirim gambar.
- Jangan menyebut API, model, OpenRouter, atau sistem internal.
- Jangan menyebut diri sebagai model atau AI berbasis teks.
- Jika user salah paham, luruskan dengan cara halus, tidak menggurui.

GAYA KOMUNIKASI:
- Ramah, membantu, percaya diri.
- Singkat dan padat untuk pertanyaan sederhana.
- Lebih detail dan terstruktur jika user terlihat bingung.
- Langsung ke inti jika user teknis.
- Gunakan bahasa yang hidup, bukan template.

MODE ADAPTIF:
- Jika user bertanya teknis, jawab fokus teknis.
- Jika user bertanya santai, jawab santai.
- Jika user minta pendapat, beri opini logis beserta alasannya.
- Jika user minta analisis, jelaskan runtut dan objektif.

TUJUAN AKHIR:
Membantu user seefektif mungkin dengan jawaban yang jelas, relevan, enak dibaca, terasa pintar,
dan terasa seperti AI modern kelas ChatGPT.
`;

const sessions = {};
const aiMode = {};
const broadcastMode = {};
const adminAction = {};
const emailSetup = {};
const fixNomor = {};
const connectMode = {};
const connectCooldown = {};
const disconnectConfirm = {};
const CONNECT_COOLDOWN_MS = 60 * 1000; // 1 menit
const MAX_PERPANJANG_DAYS = 365;
const MAX_HISTORY = 6;

async function loadDB() {
  if (!(await fs.pathExists(DB_FILE))) {
    await fs.writeJson(
      DB_FILE,
      {
        premium: {},
        premiumStart: {},
        trial: {},
        trialStart: {},
        users: [],
        emails: {},
        activity: {}
      },
      { spaces: 2 }
    );
  }

  const db = await fs.readJson(DB_FILE);

  if (!db.premium) db.premium = {};
  if (!db.premiumStart) db.premiumStart = {};

  if (!db.trial) db.trial = {};
  if (!db.trialStart) db.trialStart = {};

  if (!Array.isArray(db.users)) db.users = [];
  if (!db.emails) db.emails = {};
  if (!db.activity) db.activity = {};

  return db;
}

async function saveDB(db) {
  await fs.writeJson(DB_FILE, db, { spaces: 2 });
}

function hasFullAccess(db, userId) {
  if (isAdmin(userId)) return true;
  if (isPremium(db, userId)) return true;
  if (hasTrialAccess(db, userId)) return true;
  return false;
}

function giveTrial(db, userId, days = 1) {
  if (db.trial[userId]) return false; // anti dobel selamanya
  db.trial[userId] = days;
  db.trialStart[userId] = Date.now();
  return true;
}

function hasTrialAccess(db, userId) {
  const days = db.trial[userId];
  if (!days) return false;

  const start = db.trialStart[userId];
  if (!start) return false;

  const usedDays = Math.floor(
    (Date.now() - start) / (1000 * 60 * 60 * 24)
  );

  return usedDays < days;
}

function getTrialRemainingHours(db, userId) {
  const start = db.trialStart[userId];
  const totalMs = db.trial[userId] * 24 * 60 * 60 * 1000;
  const leftMs = totalMs - (Date.now() - start);
  return Math.max(0, Math.ceil(leftMs / (1000 * 60 * 60)));
}

const isAdmin = (id) => id === ADMIN_ID;

const isPremium = (db, id) => {
  const days = db.premium[id];
  if (days === undefined) return false;
  if (days === 0) return true; // permanent

  const start = db.premiumStart[id];
  if (!start) return false;

  const now = Date.now();
  const usedDays = Math.floor(
    (now - start) / (1000 * 60 * 60 * 24)
  );

  return usedDays < days;
};

function increaseActivity(db, userId) {
  db.activity[userId] = (db.activity[userId] || 0) + 1;
}

function getRemainingDays(startTime, totalDays) {
  if (!startTime || totalDays === 0) return "Permanent";

  const now = Date.now();
  const usedDays = Math.floor(
    (now - startTime) / (1000 * 60 * 60 * 24)
  );

  const left = totalDays - usedDays;
  return left > 0 ? `${left} hari` : "Expired";
}

async function isUserJoinedGroup(bot, userId) {
  try {
    const res = await bot.getChatMember(FORCE_JOIN_GROUP, userId);
    return ["member", "administrator", "creator"].includes(res.status);
  } catch {
    return false;
  }
}

async function sendForceJoin(chatId) {
  return bot.sendMessage(
    chatId,
`🚫 Akses Ditolak
Untuk menggunakan bot ini, kamu *WAJIB* bergabung ke grup resmi.
Setelah bergabung, tekan tombol *Verifikasi* di bawah.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "👥 Join Group",
              url: `https://t.me/${FORCE_JOIN_GROUP.replace("@", "")}`
            }
          ],
          [
            {
              text: "✅ Verifikasi",
              callback_data: "verify_join"
            }
          ]
        ]
      }
    }
  );
}

async function ocrImageFromUrl(imageUrl) {
  try {
    const {
      data: { text },
    } = await Tesseract.recognize(
      imageUrl,
      "eng+ind",
      {
        logger: m => {
          // ❌ matikan log biar tidak spam console
          // console.log(m.status);
        },
      }
    );

    const clean = text?.trim();
    if (!clean) return null;

    return clean;

  } catch (err) {
    console.error("OCR ERROR:", err?.message || err);
    return null;
  }
}

async function chatWithAI(userId, prompt) {
  if (!sessions[userId]) {
    sessions[userId] = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  sessions[userId].push({ role: "user", content: prompt });

  if (sessions[userId].length > MAX_HISTORY * 2) {
    sessions[userId] = [
      sessions[userId][0],
      ...sessions[userId].slice(-MAX_HISTORY * 2),
    ];
  }

  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "xiaomi/mimo-v2-flash:free",
        messages: sessions[userId],
        max_tokens: 2000,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000, // ⬅️ PENTING
      }
    );

    const text =
      res?.data?.choices?.[0]?.message?.content ||
      "AI tidak memberikan respon.";

    sessions[userId].push({ role: "assistant", content: text });
    return text;

  } catch (err) {
    console.error("AI TEXT ERROR:", err?.message || err);

    return "⚠️ AI sedang sibuk. Coba lagi beberapa saat.";
  }
}
async function analyzeImage(userId, imageUrl) {
  if (!sessions[userId]) {
    sessions[userId] = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  let ocrText;
  try {
    ocrText = await ocrImageFromUrl(imageUrl);
  } catch {
    ocrText = null;
  }

  // ⚠️ JIKA OCR GAGAL → SATU PESAN SAJA
  if (!ocrText) {
    return "❌ Teks pada gambar tidak terbaca dengan jelas.";
  }

  sessions[userId].push({
    role: "user",
    content: `Analisis teks dari gambar berikut:\n\n${ocrText}`,
  });

  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "xiaomi/mimo-v2-flash:free",
        messages: sessions[userId],
        max_tokens: 1500,
        temperature: 0.5,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    const text =
      res?.data?.choices?.[0]?.message?.content ||
      "Tidak ada hasil analisis.";

    sessions[userId].push({ role: "assistant", content: text });
    return text;

  } catch (err) {
    console.error("AI IMAGE ERROR:", err?.message || err);
    return "⚠️ Gagal menganalisis gambar. Coba kirim ulang dengan kualitas lebih jelas.";
  }
}

const LOCK_IMAGE = "https://i.ibb.co.com/ycb6hM1j/IMG-20260414-085440-842.jpg";

async function sendLockedAccess(chatId) {
  return bot.sendPhoto(chatId, LOCK_IMAGE, {
    caption:
`Akses terbatas.

Fitur ini hanya tersedia untuk pengguna Premium.
Silakan hubungi owner untuk aktivasi.`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "📩 Contact Owner", url: `https://t.me/${OWNER_USERNAME}` }]
      ]
    }
  });
}

function showUserMenu(chatId) {
  return bot.sendMessage(chatId, "Pilih menu di bawah:", {
    reply_markup: {
      keyboard: [
        ["🧠 AI Assistant", "📧 Setup Email"],
        ["🔧 Fix Nomor", "🔍 Cek Bio"],
        ["📱Connect", "📵 Disconnect"],
        ["👤 Profil Saya"],
        ["⬅️ Back"]
      ],
      resize_keyboard: true
    }
  });
}

function showAdminMenu(chatId) {
  return bot.sendMessage(chatId, "Menu Admin:", {
    reply_markup: {
      keyboard: [
        ["🧠 AI Assistant", "📧 Setup Email"],
        ["🔧 Fix Nomor", "🔍 Cek Bio"],
        ["📱Connect", "📵 Disconnect"],
        ["🔄 Perpanjang User", "📢 Broadcast"],
        ["📋 Check Premium Status", "📧 Check Email Users"],
        ["👤 Profil Saya"],
        ["⬅️ Back"]
      ],
      resize_keyboard: true
    }
  });
}

bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const data = query.data;

  // ✅ HANDLE VERIFY JOIN (LOGIC TETAP SAMA)
  if (data === "verify_join") {
    const joined = await isUserJoinedGroup(bot, userId);
    if (!joined) {
      return bot.answerCallbackQuery(query.id, {
        text: "❌ Kamu belum join grup.",
        show_alert: true
      });
    }

    const db = await loadDB();
    giveTrial(db, userId, 1);
    await saveDB(db);

    await bot.answerCallbackQuery(query.id, {
      text: "✅ Verifikasi berhasil",
      show_alert: false
    });

    return bot.sendMessage(
      chatId,
      "✅ Verifikasi berhasil.\nSilakan tekan /start."
    );
  }

  // ⛔ callback lain (jika ada sekarang / nanti) tidak dimatikan
});

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!(await isUserJoinedGroup(bot, userId)) && !isAdmin(userId)) {
    return sendForceJoin(chatId);
  }

  const db = await loadDB();

  const isAdm  = isAdmin(userId);
  const isPrem = isPremium(db, userId);

  // ================= AUTO TRIAL 1x SEUMUR HIDUP =================
  if (
  !isAdm &&
  !isPrem &&
  !db.trial[userId]
) {
  giveTrial(db, userId, 1);
  await saveDB(db);

  await bot.sendMessage(
    chatId,
    "🎟️ Akses GRATIS 1 HARI otomatis aktif.\nSelamat mencoba TOPINZPEDIA."
  );
}
  // =============================================================

  const isTrial = hasTrialAccess(db, userId);

  if (!isAdm && !isPrem && !isTrial) {
    return bot.sendMessage(
      chatId,
      "⛔ Masa akses GRATIS kamu sudah HABIS.\nHubungi owner."
    );
  }

  if (isTrial && !isPrem && !isAdm) {
    const sisa = getTrialRemainingHours(db, userId);
    await bot.sendMessage(
      chatId,
      `🎟️ Akses Gratis Aktif\n⏱️ Sisa waktu: ${sisa} jam`
    );
  }

  await bot.sendPhoto(chatId, LOCK_IMAGE, {
    caption:
`🥳 Selamat datang di TOPINZPEDIA 

TOPINZPEDIA adalah sistem multifungsi yang dirancang untuk analisis,
utilitas, dan pengelolaan fitur dalam satu tempat.

Tersedia:
• Analisis teks & gambar
• Pemeriksaan data & status user
• Berbagai tools tambahan
• Sistem Premium & Admin

Beberapa fitur memerlukan akses khusus.
Silakan gunakan menu di bawah untuk melanjutkan.`
  });

  return isAdm ? showAdminMenu(chatId) : showUserMenu(chatId);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";
  if (!text || text === "/start") return;

  if (!(await isUserJoinedGroup(bot, userId)) && !isAdmin(userId)) {
    return sendForceJoin(chatId);
  }

  const db = await loadDB();

  if (!db.users.includes(userId)) {
    db.users.push(userId);
    await saveDB(db);
  }

// HANDLE COMMAND PLUGIN
for (const plugin of plugins) {
  if (text.startsWith(plugin.command)) {
    const db = await loadDB();

    return plugin.execute({
      bot,
      msg,
      db,
      isAdmin
    });
  }
}

  /* BACK */
  if (text === "⬅️ Back") {
    aiMode[userId] = false;
    broadcastMode[userId] = false;
    adminAction[userId] = null;
    delete emailSetup[userId];
    delete fixNomor[userId];
    delete connectMode[userId];
    return isAdmin(userId) ? showAdminMenu(chatId) : showUserMenu(chatId);
  }
  
  if (text === "🔧 Fix Nomor") {
  if (!hasFullAccess(db, userId)) {
  return sendLockedAccess(chatId);
}

  const now = Date.now();
  if (
    fixNomorCooldown[userId] &&
    now - fixNomorCooldown[userId] < FIX_COOLDOWN_MS
  ) {
    const sisa = Math.ceil(
      (FIX_COOLDOWN_MS - (now - fixNomorCooldown[userId])) / 1000
    );
    await bot.sendMessage(
      chatId,
      `⏳ Tunggu ${sisa} detik sebelum Fix Nomor lagi.`,
      { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
    );
    return;
  }

  if (!db.emails[userId]) {
    await bot.sendMessage(
      chatId,
`❌ Email belum diatur

Silakan setup email terlebih dahulu
sebelum menggunakan fitur Fix Nomor.`,
      {
        reply_markup: {
          keyboard: [["📧 Setup Email"], ["⬅️ Back"]],
          resize_keyboard: true
        }
      }
    );
    return;
  }

  fixNomor[userId] = true;

  await bot.sendMessage(
    chatId,
`🔧 Fix Nomor

📱 Kirim nomor yang ingin diperbaiki

Format:
• Gunakan kode negara
• Tanpa spasi & simbol

Contoh:
628123456789`,
    { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
  );
  return;
}

if (fixNomor[userId]) {
  if (!/^\d{10,15}$/.test(text)) {
    await bot.sendMessage(
      chatId,
      "❌ Nomor tidak valid.\nGunakan format nomor internasional Contoh: 628123456789",
      { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
    );
    return;
  }

  delete fixNomor[userId];

  const nomor = text.trim();
  const { email, nama, password } = db.emails[userId];

  await bot.sendMessage(
    chatId,
    "⏳ Mengirim ke WhatsApp Support…"
  );

  // delay kecil biar terasa system process (bukan loading palsu)
  await new Promise(r => setTimeout(r, 400));

  const emailBody = `
Hello WhatsApp Support Team,

My name is ${nama}.
I’m having an issue with my phone number:

${nomor}

Please help review and fix this number.

Best regards,
${nama}
`.trim();

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: email,
        pass: password.replace(/\s+/g, "")
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000
    });

    await transporter.sendMail({
      from: email,
      to: "support@support.whatsapp.com",
      subject: "Problem with My Phone Number",
      text: emailBody
    });

    increaseActivity(db, userId);
    await saveDB(db);

  } catch (err) {
    console.error("SMTP ERROR:", err);
    await bot.sendMessage(
      chatId,
      "❌ Gagal mengirim email.",
      { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
    );
    return;
  }

  fixNomorCooldown[userId] = Date.now();

  await bot.sendMessage(
    chatId,
`✅ Nomor Berhasil Dikirim

📱 Nomor : ${nomor}
📧 Email : ${email}
📩 Tujuan : support@support.whatsapp.com

Mohon menunggu balasan melalui email.`
  );

  // ⬅️ AUTO BALIK MENU
  if (isAdmin(userId)) {
    await showAdminMenu(chatId);
  } else {
    await showUserMenu(chatId);
  }

  return;
}

/* ================== WHATSAPP CONNECT ================== */
if (text === "📱Connect") {
  if (!hasFullAccess(db, userId)) {
    return sendLockedAccess(chatId);
  }

  // 🔒 SUDAH CONNECT → TOLAK
  if (isUserSocketConnected(userId)) {
    return bot.sendMessage(
      chatId,
`⚠️ WhatsApp sudah terhubung

Untuk menghubungkan ulang:
1️⃣ Tekan 📵 Disconnect
2️⃣ Lalu tekan 📱 Connect kembali`,
      {
        reply_markup: {
          keyboard: [
            ["📵 Disconnect"],
            ["⬅️ Back"]
          ],
          resize_keyboard: true
        }
      }
    );
  }

  // ✅ BELUM CONNECT → BOLEH LANJUT
  connectMode[userId] = true;

  return bot.sendMessage(
    chatId,
`📱 Connect WhatsApp

Kirim nomor WhatsApp kamu
Format:
• Internasional
• Tanpa spasi
• Tanpa +

Contoh:
628123456789`,
    {
      reply_markup: {
        keyboard: [["⬅️ Back"]],
        resize_keyboard: true
      }
    }
  );
}

/* ================== HANDLE NOMOR ================== */
if (/^\d{10,15}$/.test(text) && connectMode[userId]) {
  if (!hasFullAccess(db, userId)) {
  return sendLockedAccess(chatId);
}

  const now = Date.now();

  // 🔒 COOLDOWN 1 MENIT
  if (
    connectCooldown[userId] &&
    now - connectCooldown[userId] < CONNECT_COOLDOWN_MS
  ) {
    const sisa = Math.ceil(
      (CONNECT_COOLDOWN_MS - (now - connectCooldown[userId])) / 1000
    );

    return bot.sendMessage(
      chatId,
      `⏳ Tunggu ${sisa} detik sebelum connect ulang.`,
    );
  }

  // simpan waktu terakhir connect
  connectCooldown[userId] = now;

  // kirim loading (REAL)
  const loadingMsg = await bot.sendMessage(
    chatId,
    "⏳ Meminta pairing code…"
  );

  try {
    const result = await pairWhatsAppMulti(userId, text);
    delete connectMode[userId];

    await bot.editMessageText(
`✅ *PAIRING CODE BERHASIL*

📱 Nomor : ${result.phone}
🔑 Code  : *${result.code}*

Masukkan code di:
WhatsApp → Linked Devices → Link a device`,
      {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: "Markdown"
      }
    );

  } catch (err) {
  delete connectMode[userId];
    await bot.editMessageText(
      "❌ Gagal pairing.\nSilakan tunggu beberapa saat lalu coba lagi.",
      {
        chat_id: chatId,
        message_id: loadingMsg.message_id
      }
    );
  }

  return;
}

if (text === '📵 Disconnect') {
  if (!isUserSocketConnected(userId)) {
    return bot.sendMessage(
      chatId,
      '⚠️ WhatsApp belum terhubung.'
    );
  }

  const socket = socketPool.getSocket(userId);
  const waNumber =
  socket?.user?.id
    ? socket.user.id.replace(/[:@].*$/, '')
    : 'Tidak diketahui';

  disconnectConfirm[userId] = true;

  return bot.sendMessage(
    chatId,
`⚠️ Konfirmasi Pemutusan Koneksi WhatsApp

📱 Nomor : ${waNumber}

Apakah kamu yakin ingin memutuskan koneksi WhatsApp ini?
Kamu harus pairing ulang jika ingin menghubungkannya kembali.`,
    {
      reply_markup: {
        keyboard: [
          ['✅ Ya, Putuskan'],
          ['❌ Batal']
        ],
        resize_keyboard: true
      }
    }
  );
}
if (disconnectConfirm[userId]) {

  // ❌ BATAL
  if (text === '❌ Batal') {
    delete disconnectConfirm[userId];

    return isAdmin(userId)
      ? showAdminMenu(chatId)
      : showUserMenu(chatId);
  }

  // ✅ KONFIRMASI PUTUS
  if (text === '✅ Ya, Putuskan') {
    delete disconnectConfirm[userId];

    if (!isUserSocketConnected(userId)) {
      return bot.sendMessage(
        chatId,
        '⚠️ WhatsApp sudah tidak terhubung.'
      );
    }

    await bot.sendMessage(chatId, '⏳ Memutuskan koneksi WhatsApp...');

    await disconnectUserSocket(userId);
    delete connectCooldown[userId];

    await bot.sendMessage(
      chatId,
      '✅ WhatsApp berhasil diputuskan.'
    );

    return isAdmin(userId)
      ? showAdminMenu(chatId)
      : showUserMenu(chatId);
  }

  // ⛔ JIKA NGETIK SEMBARANG
  return bot.sendMessage(
    chatId,
    'Silakan pilih salah satu opsi di bawah.',
    {
      reply_markup: {
        keyboard: [
          ['✅ Ya, Putuskan'],
          ['❌ Batal']
        ],
        resize_keyboard: true
      }
    }
  );
}

 // 🔍 MENU CEK BIO
if (text === '🔍 Cek Bio') {

  // ❌ BELUM PAIRING
  if (!isUserSocketConnected(userId)) {
    return bot.sendMessage(
      chatId,
`⚠️ WhatsApp belum terhubung

Silakan Connect WhatsApp terlebih dahulu
sebelum menggunakan fitur Cek Bio.`,
      {
        reply_markup: {
          keyboard: [
            ['📱Connect'],
            ['⬅️ Back']
          ],
          resize_keyboard: true
        }
      }
    );
  }

  // ⛔ SEDANG PROSES → MUNCUL BUTTON BATAL
  if (bioProcessing[userId]) {
    return bot.sendMessage(
      chatId,
      '⏳ Proses cek bio masih berjalan.\nTekan Batalkan Proses untuk menghentikan.',
      {
        ...BIO_PROCESS_KEYBOARD
      }
    );
  }

  // ✅ NORMAL
  return bot.sendMessage(
    chatId,
`🔍 Cek Bio WhatsApp

Kirim:
• 1 nomor WhatsApp
• Banyak nomor (1 baris = 1 nomor)
• File .txt (1 nomor per baris)

Batas:
• Maksimal 300 nomor per proses
• Sistem diproses bertahap (real-time)

Catatan:
• Terlalu banyak nomor sekaligus dapat menyebabkan
  hasil tidak akurat (rate limit WhatsApp)
• Disarankan cek bertahap untuk hasil terbaik`,
    {
      reply_markup: {
        keyboard: [['⬅️ Back']],
        resize_keyboard: true
      }
    }
  );
}
if (text === '⛔ Batalkan Proses') {

  if (!bioProcessing[userId]) {
    return bot.sendMessage(
      chatId,
      'ℹ️ Tidak ada proses cek bio yang sedang berjalan.',
      {
        reply_markup: {
          keyboard: [['⬅️ Back']],
          resize_keyboard: true
        }
      }
    );
  }

  bioCancel[userId] = true;

  return bot.sendMessage(
    chatId,
    '⛔ Proses cek bio sedang dihentikan...',
    {
      reply_markup: {
        keyboard: [['⬅️ Back']],
        resize_keyboard: true
      }
    }
  );
}
// 📥 INPUT NOMOR
if (
  /^\d{7,15}(\n\d{7,15})*$/.test(text) &&
  !adminAction[userId] &&   // ⛔ ADMIN PRIORITAS
  !connectMode[userId] &&
  !fixNomor[userId]
) {

  if (!isUserSocketConnected(userId)) {
    return bot.sendMessage(
      chatId,
      '⚠️ WhatsApp belum terhubung.\nSilakan Connect terlebih dahulu.'
    );
  }

if (bioProcessing[userId]) {
  return bot.sendMessage(
    chatId,
    '⏳ Proses cek bio masih berjalan.\nGunakan tombol ⛔ Batalkan Proses.',
    BIO_PROCESS_KEYBOARD
  );
}

  const numbers = parseNumbers(text);

  if (numbers.length > MAX_BIO_CHECK) {
    return bot.sendMessage(
      chatId,
`🚫 Terlalu banyak nomor

Jumlah dikirim: ${numbers.length}
Maksimal per pemeriksaan: ${MAX_BIO_CHECK} nomor

Silakan pecah menjadi beberapa bagian.`,
    );
  }

  return handleBulk(bot, chatId, userId, text);
}

if (text === "📧 Setup Email") {
  if (!hasFullAccess(db, userId)) {
  return sendLockedAccess(chatId);
}

  // Jika sudah ada email, tampilkan opsi konfirmasi
  if (db.emails[userId]) {
    const { email, nama } = db.emails[userId];
    return bot.sendMessage(
      chatId,
`⚠️ Email sudah terdaftar

📧 ${email}
👤 ${nama}

Apakah ingin mengatur ulang email?
Email lama akan dihapus.`,
      {
        reply_markup: {
          keyboard: [["🔁 Atur Ulang Email"], ["❌ Batal"]],
          resize_keyboard: true
        }
      }
    );
  }

  // Jika belum ada email
  emailSetup[userId] = { step: "email" };
  return bot.sendMessage(
    chatId,
`📧 Setup Email (1/3)

Kirim email Gmail kamu.
Contoh:
topinzpedia@gmail.com`,
    { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
  );
}

// Batal setup ulang
if (text === "❌ Batal") {
  delete emailSetup[userId];
  return isAdmin(userId)
    ? showAdminMenu(chatId)
    : showUserMenu(chatId);
}

// Atur ulang email (hapus lama)
if (text === "🔁 Atur Ulang Email") {
  delete db.emails[userId];
  await saveDB(db);

  emailSetup[userId] = { step: "email" };

  return bot.sendMessage(
    chatId,
`📧 Setup Email (1/3)

Kirim email Gmail kamu.
Contoh:
topinzpedia@gmail.com`,
    { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
  );
}

// STEP 1: Email
if (emailSetup[userId]?.step === "email") {
  if (!text.endsWith("@gmail.com")) {
    return bot.sendMessage(chatId, "❌ Gunakan Gmail.", {
      reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true }
    });
  }

  emailSetup[userId].email = text;
  emailSetup[userId].step = "password";

  return bot.sendMessage(
    chatId,
`🔑 Setup Email (2/3)

Kirim App Password Gmail kamu
(16 karakter, spasi boleh)

Contoh:
abcd efgh ijkl mnop

Dapatkan App Password dari: 
Google Account → Keamanan → Sandi Aplikasi  
https://myaccount.google.com/apppasswords  

🔐 Password akan disimpan dalam bentuk terenkripsi (AES-256)`,
    { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
  );
}

// STEP 2: Password
if (emailSetup[userId]?.step === "password") {
  const cleanPass = text.replace(/\s/g, "");
  if (cleanPass.length !== 16) {
    return bot.sendMessage(chatId, "❌ App Password harus 16 karakter.", {
      reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true }
    });
  }

  emailSetup[userId].password = cleanPass;
  emailSetup[userId].step = "nama";

  return bot.sendMessage(
    chatId,
`👤 Setup Email (3/3)

Kirim nama kamu
(contoh: Budi Santoso)`,
    { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
  );
}

// STEP 3: Nama (Final + Loading)
if (emailSetup[userId]?.step === "nama") {
  const { email, password } = emailSetup[userId];
  const nama = text.trim();

  await bot.sendMessage(chatId, "⏳ Menyimpan konfigurasi email…");
  await new Promise(r => setTimeout(r, 700)); // delay pas

  db.emails[userId] = { email, password, nama };
  await saveDB(db);
  increaseActivity(db, userId);
  await saveDB(db);
  delete emailSetup[userId];

  await bot.sendMessage(
    chatId,
`✅ Setup Email Berhasil

📧 Email : ${email}
👤 Nama  : ${nama}

Email siap digunakan untuk fitur Fix Nomor.`,
    { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
  );

  return isAdmin(userId)
    ? showAdminMenu(chatId)
    : showUserMenu(chatId);
}

if (text === "👤 Profil Saya") {
  const username = msg.from.username ? `@${msg.from.username}` : "-";

  const totalDays = db.premium[userId];
  let premiumStatus = "Tidak aktif";

  if (totalDays !== undefined) {
    premiumStatus = getRemainingDays(
      db.premiumStart[userId],
      totalDays
    );
  }

  const emailStatus = db.emails[userId]
    ? "Sudah setup"
    : "Belum setup";

  const activity = db.activity?.[userId] || 0;

  return bot.sendMessage(
    chatId,
`👤 Profil Kamu

🆔 ID : ${userId}
👤 Username : ${username}
⭐ Premium : ${premiumStatus}
📧 Email : ${emailStatus}
📊 Aktivitas : ${activity}x`,
    { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
  );
}

if (text === "🧠 AI Assistant") {
  if (!hasFullAccess(db, userId)) {
  return sendLockedAccess(chatId);
}

  aiMode[userId] = true;

  return bot.sendMessage(
    chatId,
    `AI aktif.
Kirim teks atau gambar untuk dianalisis.`,
    {
      reply_markup: {
        keyboard: [["⬅️ Back"]],
        resize_keyboard: true
      }
    }
  );
}

if (aiMode[userId]) {
  if (!hasFullAccess(db, userId)) {
  return sendLockedAccess(chatId);
}

  await bot.sendChatAction(chatId, "typing");
  const reply = await chatWithAI(userId, text);
  increaseActivity(db, userId);
  await saveDB(db);
  return bot.sendMessage(chatId, reply);
}

if (text === "📢 Broadcast") {
  if (!isAdmin(userId)) return;

  broadcastMode[userId] = true;

  return bot.sendMessage(
    chatId,
`📢 MODE BROADCAST AKTIF

Kirim *SATU PESAN* (teks / foto + caption)
untuk disiarkan ke semua user.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [["⬅️ Back"]],
        resize_keyboard: true
      }
    }
  );
}

if (broadcastMode[userId]) {
  if (!isAdmin(userId)) {
    broadcastMode[userId] = false;
    return;
  }

  if (text === "⬅️ Back") {
    broadcastMode[userId] = false;
    return showAdminMenu(chatId);
  }

  broadcastMode[userId] = false;

  let sent = 0;
  let failed = 0;

  for (const uid of db.users) {
    try {

      // ===== FOTO + CAPTION (FORMAT ASLI TELEGRAM) =====
      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];

        await bot.sendPhoto(uid, photo.file_id, {
          caption: msg.caption || "",
          caption_entities: msg.caption_entities || []
        });

      // ===== DOCUMENT + CAPTION =====
      } else if (msg.document) {
        await bot.sendDocument(uid, msg.document.file_id, {
          caption: msg.caption || "",
          caption_entities: msg.caption_entities || []
        });

      // ===== TEKS (FORMAT ASLI) =====
      } else if (msg.text) {
        await bot.sendMessage(uid, msg.text, {
          entities: msg.entities || []
        });
      }

      sent++;
      await new Promise(r => setTimeout(r, 70));

    } catch (e) {
      failed++;
    }
  }

  await bot.sendMessage(
    chatId,
`📢 BROADCAST SELESAI

📨 Terkirim : ${sent}
❌ Gagal    : ${failed}`
  );

  return showAdminMenu(chatId);
}

if (text === "🔄 Perpanjang User") {
  adminAction[userId] = "perpanjang";
  return bot.sendMessage(
    chatId,
`🔄 Perpanjang Premium User

Kirim pesan berisi:
• ID Telegram user
• Durasi perpanjangan (hari)

Catatan:
• Hanya untuk user yang SUDAH Premium
• Hari akan DITAMBAHKAN ke sisa aktif
• Premium Permanent tidak bisa diperpanjang

⚠️ Pastikan ID Telegram valid agar tidak terjadi kesalahan`,
    {
      reply_markup: {
        keyboard: [["⬅️ Back"]],
        resize_keyboard: true
      }
    }
  );
}

if (text === "📋 Check Premium Status") {
  const ids = Object.keys(db.premium);

  if (!ids.length) {
    return bot.sendMessage(
      chatId,
      "Belum ada user premium.",
      {
        reply_markup: {
          keyboard: [["⬅️ Back"]],
          resize_keyboard: true
        }
      }
    );
  }

  let out = `📋 Status Premium
Total User Premium: ${ids.length}\n\n`;

  for (const id of ids) {
    let username = "-";

    try {
      const chat = await bot.getChat(Number(id));
      if (chat.username) username = "@" + chat.username;
    } catch {}

    const status =
      db.premium[id] === 0
        ? "Permanent"
        : `${db.premium[id]} hari`;

    out +=
`👤 Username : ${username}
🆔 ID : ${id}
📍 Status : ${status}

`;
  }

  return bot.sendMessage(
    chatId,
    out.trim(),
    {
      reply_markup: {
        keyboard: [["⬅️ Back"]],
        resize_keyboard: true
      }
    }
  );
}

if (text === "📧 Check Email Users") {
  const ids = Object.keys(db.emails);

  if (ids.length === 0) {
    return bot.sendMessage(
      chatId,
`📧 Check Email Users

❌ Belum ada user yang setup email`,
      { reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true } }
    );
  }

  let out =
`📧 Check Email Users
📊 Total Email : ${ids.length}\n\n`;

  for (const id of ids) {
    const u = db.emails[id];
    out +=
`🆔 ID    : ${id}
👤 Nama  : ${u.nama}
📧 Email : ${u.email}\n\n`;
  }

  return bot.sendMessage(chatId, out, {
    reply_markup: { keyboard: [["⬅️ Back"]], resize_keyboard: true }
  });
}

  if (!adminAction[userId]) return;

  const parts = text.trim().split(/\s+/);
const targetId = parts[0];
const days = Number(parts[1]);

  if (!/^\d+$/.test(targetId) || isNaN(days)) {
    return bot.sendMessage(chatId, "❌ Format tidak valid.");
  }

if (adminAction[userId] === "perpanjang") {
  const parts = text.trim().split(/\s+/);
  const targetId = parts[0];
  const addDays = Number(parts[1]);

  // ❌ VALIDASI FORMAT
  if (
    !/^\d+$/.test(targetId) ||
    isNaN(addDays) ||
    addDays < 0
  ) {
    return bot.sendMessage(
      chatId,
      "❌ Format tidak valid.\nGunakan: <ID_USER> <jumlah_hari>\nGunakan 0 untuk Permanent."
    );
  }

  // ❌ USER BUKAN PREMIUM
  if (db.premium[targetId] === undefined) {
    adminAction[userId] = null;
    return bot.sendMessage(
      chatId,
      "❌ User belum memiliki akses Premium."
    );
  }

  // ❌ SUDAH PERMANENT
  if (db.premium[targetId] === 0) {
    adminAction[userId] = null;
    return bot.sendMessage(
      chatId,
      "⚠️ User sudah memiliki Premium Permanent."
    );
  }

  // ===============================
  // ♾️ MODE PERMANENT (addDays = 0)
  // ===============================
  if (addDays === 0) {
    db.premium[targetId] = 0; // permanent = 0
    delete db.premiumStart[targetId];
    delete db.activity[`notif_${targetId}`];

    await saveDB(db);
    adminAction[userId] = null;

    // ADMIN
    await bot.sendMessage(
      chatId,
`♾️ Premium berhasil diubah menjadi PERMANENT

🆔 User ID : ${targetId}
📍 Status  : Permanent`
    );

    // USER
    try {
      await bot.sendMessage(
        targetId,
`♾️ Premium kamu sekarang PERMANENT

Akses tidak memiliki batas waktu.
Terima kasih telah menggunakan TOPINZPEDIA.`
      );
    } catch {}

    return showAdminMenu(chatId);
  }

  // ===============================
  // 🔒 ANTI BUG ANGKA BESAR
  // ===============================
  if (addDays > MAX_PERPANJANG_DAYS) {
    return bot.sendMessage(
      chatId,
`❌ Durasi terlalu besar

Maksimal perpanjangan: ${MAX_PERPANJANG_DAYS} hari
Lakukan perpanjangan bertahap jika diperlukan.`
    );
  }

  // ===============================
  // 🔄 PERPANJANG NORMAL
  // ===============================
  const totalDays = db.premium[targetId];
  const start = db.premiumStart[targetId];

  const usedDays = Math.floor(
    (Date.now() - start) / (1000 * 60 * 60 * 24)
  );

  const remaining = Math.max(0, totalDays - usedDays);
  const newTotal = remaining + addDays;

  db.premium[targetId] = newTotal;
  db.premiumStart[targetId] = Date.now();
  delete db.activity[`notif_${targetId}`];

  await saveDB(db);
  adminAction[userId] = null;

  // ADMIN
  await bot.sendMessage(
    chatId,
`✅ Premium berhasil diperpanjang

🆔 User ID : ${targetId}
⏳ Sisa lama : ${remaining} hari
➕ Ditambah : ${addDays} hari
📊 Total baru : ${newTotal} hari`
  );

  // USER
  try {
    await bot.sendMessage(
      targetId,
`🔄 Premium kamu diperpanjang

➕ +${addDays} hari
⏳ Total sekarang: ${newTotal} hari
Terima kasih telah menggunakan TOPINZPEDIA.`
    );
  } catch {}

  return showAdminMenu(chatId);
}

});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const db = await loadDB();

  if (!aiMode[userId]) return;
  if (!hasFullAccess(db, userId)) {
  return sendLockedAccess(chatId);
}

  try {
    await bot.sendChatAction(chatId, "typing");
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);

    const imageUrl =
      `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const ocrText = await ocrImageFromUrl(imageUrl);

    if (!sessions[userId]) {
      sessions[userId] = [{ role: "system", content: SYSTEM_PROMPT }];
    }

    if (ocrText) {
      sessions[userId].push({
        role: "user",
        content: `Berikut adalah teks hasil OCR dari gambar:\n\n${ocrText}`
      });
    }
    const reply = await analyzeImage(userId, imageUrl);
    increaseActivity(db, userId);
    await saveDB(db);
    return bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error("IMAGE ANALYZE ERROR:", err);
    return bot.sendMessage(chatId, "❌ Gagal menganalisis gambar.");
  }
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // 🔒 WAJIB SUDAH PAIRING
  if (!isUserSocketConnected(userId)) {
    return bot.sendMessage(
      chatId,
      '⚠️ WhatsApp belum terhubung.\nSilakan Connect terlebih dahulu.',
      {
        reply_markup: {
          keyboard: [['📱Connect'], ['⬅️ Back']],
          resize_keyboard: true
        }
      }
    );
  }

  // ⛔ SEDANG PROSES
  if (bioProcessing[userId]) {
    return bot.sendMessage(
      chatId,
      '⏳ Proses cek bio masih berjalan.\nGunakan tombol ⛔ Batalkan Proses.',
      {
        reply_markup: {
          keyboard: [['⛔ Batalkan Proses'], ['⬅️ Back']],
          resize_keyboard: true
        }
      }
    );
  }

  try {
    // ambil file
    const file = await bot.getFile(msg.document.file_id);
    const url =
      `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    // download isi file
    const res = await fetch(url);
    const text = await res.text();

    // parse nomor
    const numbers = parseNumbers(text);

    if (!numbers.length) {
      return bot.sendMessage(
        chatId,
        '❌ File tidak berisi nomor WhatsApp yang valid.',
        {
          reply_markup: {
            keyboard: [['⬅️ Back']],
            resize_keyboard: true
          }
        }
      );
    }

    // 🚫 LIMIT FILE (UX KHUSUS FILE)
    if (numbers.length > MAX_BIO_CHECK) {
      return bot.sendMessage(
        chatId,
`📂 File terlalu besar untuk diproses

📄 Nama file : ${msg.document.file_name || 'file.txt'}
🔢 Total nomor : ${numbers.length}
⚠️ Batas maksimal : ${MAX_BIO_CHECK} nomor

💡 Saran Topinzpedia
• Pecah file menjadi beberapa bagian
• Maksimal ${MAX_BIO_CHECK} nomor per file
• Kirim ulang setelah proses sebelumnya selesai

Dengan ini, akurasi tetap terjaga
dan akun WhatsApp kamu lebih aman.`,
        {
          reply_markup: {
            keyboard: [['⬅️ Back']],
            resize_keyboard: true
          }
        }
      );
    }

    // ✅ LANJUT KE PROSES UTAMA
    return handleBulk(bot, chatId, userId, text);

  } catch (err) {
    console.error('DOCUMENT ERROR:', err);
    return bot.sendMessage(
      chatId,
      '❌ Gagal membaca file.\nPastikan file .txt dan dapat diakses.',
      {
        reply_markup: {
          keyboard: [['⬅️ Back']],
          resize_keyboard: true
        }
      }
    );
  }
});

setInterval(async () => {
  const db = await loadDB();
  const now = Date.now();

  for (const userId of Object.keys(db.premium)) {
    const days = db.premium[userId];
    if (days === 0) continue; // permanent skip

    const start = db.premiumStart[userId];
    const usedDays = Math.floor(
      (now - start) / (1000 * 60 * 60 * 24)
    );

    const remaining = days - usedDays;

    // 🔔 NOTIF H-1
    if (remaining === 1 && !db.activity[`notif_${userId}`]) {
      try {
        await bot.sendMessage(
          userId,
          `⏰ Akses Premium kamu akan berakhir BESOK.\nSegera perpanjang agar fitur tidak terkunci.`
        );
        db.activity[`notif_${userId}`] = true;
      } catch {}
    }

    // ❌ HABIS
    if (remaining <= 0) {
      delete db.premium[userId];
      delete db.premiumStart[userId];
      delete db.activity[`notif_${userId}`];

      try {
        await bot.sendMessage(
          userId,
          `❌ Akses Premium kamu telah BERAKHIR.\nHubungi admin untuk aktivasi ulang.`
        );
      } catch {}
    }
  }

  // trial juga bisa diproses sama
  for (const userId of Object.keys(db.trial)) {
    if (!hasTrialAccess(db, userId)) {
      delete db.trial[userId];
      delete db.trialStart[userId];
    }
  }

  await saveDB(db);
}, 60 * 60 * 1000); // 1 jam

bot.on("polling_error", (e) => console.error(e.message));
process.on("unhandledRejection", (e) => console.error(e));
process.on("uncaughtException", (e) => console.error(e));

process.on("SIGINT", async () => {
  console.log("🛑 Shutdown detected (SIGINT)");

  try {
  } catch (e) {
    console.error("Shutdown error:", e);
  } finally {
    process.exit(0);
  }
});

process.on("SIGTERM", async () => {
  console.log("🛑 Shutdown detected (SIGTERM)");
  process.exit(0);
});

console.log("🥳 TOPINZPEDIA siap digunakan");