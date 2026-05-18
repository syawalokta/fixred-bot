// whatsapp/pairing-multi.js
import { requestPairingCodeForUser } from "./socket-pool.js";

export async function pairWhatsAppMulti(userId, phone) {
  const result = await requestPairingCodeForUser(userId, phone);

  if (!result || !result.code) {
    throw new Error("FAILED_PAIRING");
  }

  return {
    phone: result.phone,
    code: result.code
  };
}