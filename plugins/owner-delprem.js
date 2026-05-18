export default {
  name: "delprem",
  command: "/delprem",

  async execute({ bot, msg, db, args, isAdmin, saveDB }) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) return;

    const [targetId] = args;

    if (!targetId) {
      return bot.sendMessage(
        chatId,
        "❌ Format salah\nContoh:\n/delprem 123456789"
      );
    }

    if (db.premium[targetId] === undefined) {
      return bot.sendMessage(
        chatId,
        "⚠️ User bukan premium."
      );
    }

    const wasPermanent = db.premium[targetId] === 0;

    delete db.premium[targetId];
    delete db.premiumStart[targetId];
    delete db.activity[`notif_${targetId}`];

    await saveDB(db);

    await bot.sendMessage(
      chatId,
`🗑 Premium dicabut

🆔 ${targetId}
📍 ${wasPermanent ? "Permanent" : "Berjangka"}`
    );

    try {
      await bot.sendMessage(
        targetId,
        "⚠️ Premium kamu telah dicabut."
      );
    } catch {}
  }
};