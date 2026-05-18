export default {
  name: "daftaruser",
  command: "/daftaruser",

  async execute({ bot, msg, db, isAdmin }) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) return;

    const users = db.users || [];
    const total = users.length;

    if (total === 0) {
      return bot.sendMessage(chatId, "👥 Belum ada user.");
    }

    let output = `👥 Daftar User\n\nTotal: ${total}\n\n`;

    for (const uid of users) {
      let username = "(tidak ada)";

      try {
        const chat = await bot.getChat(uid);
        if (chat.username) username = "@" + chat.username;
      } catch {}

      output +=
`🆔 ${uid}
👤 ${username}

`;
    }

    return bot.sendMessage(chatId, output.trim());
  }
};