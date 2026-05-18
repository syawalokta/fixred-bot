export default {
  name: "addprem",
  command: "/addprem",

  async execute({ bot, msg, db, args, isAdmin, saveDB }) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) return;

    const [targetId, daysRaw] = args;
    const days = Number(daysRaw);

    if (!targetId || isNaN(days) || days < 0) {
      return bot.sendMessage(
        chatId,
        "❌ Format salah\nContoh:\n/addprem 123456789 30\n0 = permanent"
      );
    }

    if (db.premium[targetId] !== undefined) {
      return bot.sendMessage(
        chatId,
        "⚠️ User sudah premium."
      );
    }

    db.premium[targetId] = days;
    db.premiumStart[targetId] = Date.now();
    delete db.activity[`notif_${targetId}`];

    await saveDB(db);

    await bot.sendMessage(
      chatId,
`✅ Premium ditambahkan

🆔 ${targetId}
📍 ${days === 0 ? "Permanent" : `${days} hari`}`
    );

    try {
      await bot.sendMessage(
        targetId,
`🎉 Premium aktif
📍 ${days === 0 ? "Permanent" : `${days} hari`}`
      );
    } catch {}
  }
};