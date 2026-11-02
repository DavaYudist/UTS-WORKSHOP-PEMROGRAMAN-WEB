const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const sendWhatsApp = async (message) => {
  const tokenFonnte = process.env.FONNTE_TOKEN;
  const targetPhone = process.env.ADMIN_WA_PHONE;

  if (!tokenFonnte || !targetPhone) {
    console.warn('[Fonnte WA] FONNTE_TOKEN or ADMIN_WA_PHONE is missing in .env. Skipping alert.');
    return false;
  }

  try {
    const params = new URLSearchParams();
    params.append('target', targetPhone);
    params.append('message', message);
    params.append('countryCode', '62');

    const response = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        'Authorization': tokenFonnte
      },
      body: params
    });

    const result = await response.json();
    console.log('[Fonnte WA Sent]:', result.status ? 'Success' : result.reason || 'Failed');
    return result;
  } catch (error) {
    console.error('[Fonnte WA Error]:', error.message);
    return false;
  }
};

module.exports = sendWhatsApp;
