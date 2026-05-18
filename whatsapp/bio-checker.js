import { createLogger } from '../logger.js';

const log = createLogger('WhatsAppBioChecker');

// -- detectBusinessTypeEnhanced --
export const detectBusinessTypeEnhanced = async (socket, jid, bioText = '') => {
  try {
    let accountType = 'Akun Pribadi';
    let isBusiness = false;
    const isVerified = null;
    let businessProfile = null;

    const profile = await socket.getBusinessProfile(jid).catch(() => null);
    businessProfile = profile;

    if (profile?.businessName || profile?.wid) {
      accountType = 'WhatsApp Business';
      isBusiness = true;
      log.info(`[BUSINESS] ${jid}: WhatsApp Business`);
      return { accountType, isBusiness, isVerified, businessProfile };
    }

    const businessBioPatterns = [
      'Hello. I\'m using WhatsApp Business.',
      'Hello. I?m using WhatsApp Business.',
      'Hola. Estoy usando WhatsApp Business.',
      'WhatsApp Business',
    ];

    if (businessBioPatterns.some(p => bioText.includes(p))) {
      accountType = 'WhatsApp Business';
      isBusiness = true;
      log.info(`[BUSINESS] ${jid}: WhatsApp Business (detected from bio)`);
      return { accountType, isBusiness, isVerified, businessProfile };
    }

    log.info(`[BUSINESS] ${jid}: Personal account`);
    return { accountType, isBusiness, isVerified, businessProfile };
  } catch (error) {
    log.error({ error }, `Error detecting business type for ${jid}`);
    return {
      accountType: 'Akun Pribadi',
      isBusiness: false,
      isVerified: null,
      businessProfile: null,
    };
  }
};

// -- extractBusinessInfo --
export const extractBusinessInfo = (businessProfile) => {
  if (!businessProfile) {
    return {
      email: null,
      address: null,
      description: null,
      websites: [],
      category: null,
    };
  }

  return {
    email: businessProfile.email || null,
    address: businessProfile.address || null,
    description: businessProfile.description || null,
    websites: businessProfile.website || businessProfile.websites || [],
    category: businessProfile.category || businessProfile.vertical || null,
  };
};

// -- extractWebsites --
export const extractWebsites = (text) => {
  if (!text) {
    return [];
  }

  const urlPattern = /(?:https?:\/\/)(?:www\.)?[\w-]+\.[\w.-]+(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=]*)?/gi; // eslint-disable-line max-len
  const matches = text.match(urlPattern) || [];

  const websites = matches.filter((url) => {
    const normalized = url.toLowerCase();
    return (
      !normalized.includes('whatsapp.net') &&
      !normalized.includes('whatsapp.com') &&
      !normalized.includes('wa.me') &&
      !normalized.includes('t.me') &&
      !normalized.includes('telegram.me')
    );
  });

  return [...new Set(websites)];
};

// -- detectWebsites --
export const detectWebsites = (bioText, businessProfile = null) => {
  const websites = [];

  if (businessProfile?.website && Array.isArray(businessProfile.website)) {
    websites.push(...businessProfile.website);
  }

  if (businessProfile?.websites && Array.isArray(businessProfile.websites)) {
    websites.push(...businessProfile.websites);
  }

  if (bioText) {
    const bioWebsites = extractWebsites(bioText);
    websites.push(...bioWebsites);
  }

  if (businessProfile) {
    const safeFields = [
      businessProfile.description,
      businessProfile.address,
    ].filter(f => f && typeof f === 'string');

    const allProfileText = safeFields.join(' ');
    if (allProfileText.trim()) {
      const profileWebsites = extractWebsites(allProfileText);
      websites.push(...profileWebsites);
    }
  }

  const uniqueWebsites = [...new Set(websites)];

  if (uniqueWebsites.length > 0) {
    log.info('[WEBSITE] Found websites:', { count: uniqueWebsites.length });
  }

  return uniqueWebsites;
};

// -- detectEmails --
export const detectEmails = (bioText = '', businessProfile = null) => {
  const emails = new Set();

  const extract = (text) => {
    if (!text || typeof text !== 'string') return;
    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g;
    const matches = text.match(regex) || [];
    matches.forEach(e => emails.add(e.toLowerCase()));
  };

  // 1. dari bio
  extract(bioText);

  if (businessProfile) {
    // 2. dari field resmi (kalau ada)
    if (businessProfile.email) {
      if (Array.isArray(businessProfile.email)) {
        businessProfile.email.forEach(e => emails.add(e.toLowerCase()));
      } else {
        emails.add(businessProfile.email.toLowerCase());
      }
    }

    // 3. dari description & address
    extract(businessProfile.description);
    extract(businessProfile.address);
  }

  return [...emails];
};

export const fetchBioForUser = async (socket, number) => {
  try {
    const jid = `${number}@s.whatsapp.net`;

    const status = await socket.fetchStatus(jid).catch(() => null);
    if (!status) {
      return { category: 'unregistered', phone: number };
    }

    const bioText = status.status || '';

    const biz = await detectBusinessTypeEnhanced(socket, jid, bioText);

    const websites = detectWebsites(bioText, biz.businessProfile);

    const emails = detectEmails(bioText, biz.businessProfile);

    if (!bioText.trim()) {
      return {
        category: 'noBio',
        phone: number,
        isBusiness: biz.isBusiness,
        accountType: biz.accountType,
        websites,
        email: emails[0] || null,
      };
    }

    return {
      category: 'hasBio',
      phone: number,
      bio: bioText,
      setAt: status.setAt || null,
      isBusiness: biz.isBusiness,
      accountType: biz.accountType,
      websites,
      email: emails[0] || null,
    };
  } catch (e) {
    return { category: 'rateLimit', phone: number };
  }
};