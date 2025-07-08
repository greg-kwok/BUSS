const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const geolib = require('geolib');

const TELEGRAM_TOKEN = '6463127140:AAHHidnr-ppSb44ifS4lw7miwVc_Y4LTWlk';
const LTA_KEY = '4UQDy7mJS2q9eKq+E/sxAw==';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let allStops = [];
let alertWatchlist = [];

// Load all bus stops
async function loadStops() {
  let skip = 0;
  allStops = [];
  try {
    while (true) {
      const res = await axios.get('https://datamall2.mytransport.sg/ltaodataservice/BusStops', {
        headers: { 'AccountKey': LTA_KEY },
        params: { '$skip': skip }
      });
      allStops.push(...res.data.value);
      if (res.data.value.length < 500) break;
      skip += 500;
    }
    console.log(`✅ Loaded ${allStops.length} bus stops.`);
  } catch (err) {
    console.error('❌ Failed to load bus stops:', err);
  }
}
loadStops();

// Emoji helpers
const getBusEmoji = (feature, type) => {
  type = type?.toUpperCase();
  switch (type) {
    case 'DD': return `⏫`;
    case 'SD': return `🚌`;
    case 'BD': return `🔀`;
    default: return `🚌`;
  }
};

const getLoadEmoji = (load) => {
  switch (load) {
    case 'SEA': return '🟢';
    case 'SDA': return '🟡';
    case 'LSD': return '🔴';
    default: return '❓';
  }
};

// Format Arrival Display
function renderArrivalMessage(stopCode, stopName, services) {
  const now = new Date();
  let msg = `*Bus Arrivals @ ${stopName} (${stopCode})*\n\n\`\`\`\n`;
  msg += `Bus |    1st   |    2nd   |    3rd \n`;
  msg += `----+----------+----------+--------\n`;

  for (const bus of services) {
    const eta1 = new Date(bus.NextBus.EstimatedArrival);
    const eta2 = new Date(bus.NextBus2.EstimatedArrival);
    const eta3 = new Date(bus.NextBus3.EstimatedArrival);

    const raw1 = Math.round((eta1 - now) / 60000);
    const raw2 = Math.round((eta2 - now) / 60000);
    const raw3 = Math.round((eta3 - now) / 60000);

    const icon1 = getBusEmoji(bus.NextBus.Feature, bus.NextBus.Type);
    const icon2 = getBusEmoji(bus.NextBus2.Feature, bus.NextBus2.Type);
    const icon3 = getBusEmoji(bus.NextBus3.Feature, bus.NextBus3.Type);

    const load1 = getLoadEmoji(bus.NextBus.Load);
    const load2 = getLoadEmoji(bus.NextBus2.Load);
    const load3 = getLoadEmoji(bus.NextBus3.Load);

    const min1 = isNaN(eta1) ? '—' : raw1 <= 0 ? `ARR` : `${raw1}`;
    const min2 = isNaN(eta2) ? '—' : raw2 <= 0 ? `ARR` : `${raw2}`;
    const min3 = isNaN(eta3) ? '—' : raw3 <= 0 ? `ARR` : `${raw3}`;

    msg += `${bus.ServiceNo.padEnd(3)} | ${icon1}${min1.padStart(4)}${load1} | ${icon2}${min2.padStart(4)}${load2} | ${icon3}${min3.padStart(4)}${load3}\n`;
  }
  msg += '```';
  return msg;
}

// Start Command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Welcome! 🚏\nSend \"@your Location\" or\nChoose an option below:', {
    reply_markup: {
      keyboard: [
        [{ text: "📋 View Alerts" }, { text: "📍 Send Location", request_location: true }]
      ],
      resize_keyboard: true
    }
  });
});

// View Alerts
bot.onText(/📋 View Alerts/, (msg) => {
  const alerts = alertWatchlist.filter(a => a.chatId === msg.chat.id);
  if (alerts.length === 0) {
    return bot.sendMessage(msg.chat.id, "📭 You have no active bus alerts.");
  }

  const inlineButtons = alerts.map(alert => {
    const stop = allStops.find(s => s.BusStopCode === alert.busStopCode);
    const stopName = stop ? stop.Description : alert.busStopCode;
    return [{
      text: `Buss ${alert.serviceNo} @ ${stopName} (${alert.busStopCode})`,
      callback_data: `cancel_${alert.busStopCode}_${alert.serviceNo}`
    }];
  });

  bot.sendMessage(msg.chat.id, "📭 Below are your alerts:\n(press to cancel)", {
    reply_markup: { inline_keyboard: inlineButtons }
  });
});

// --- NEW: Handle Natural Language Location Lookup using OpenStreetMap Nominatim ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  // Ignore messages that don't start with '@'
  if (!text || !text.startsWith('@')) return;

  // Extract search query
  const query = text.substring(1).trim(); // remove '@'

  if (!query) return bot.sendMessage(chatId, `⚠️ Please type something after "@", e.g. "@ngee ann polytechnic"`);

  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: `${query} singapore`,   // Bias toward SG
        format: 'json',
        addressdetails: 0,
        limit: 1,
        countrycodes: 'SG'
      },
      headers: {
        'User-Agent': 'Telegram-Bus-Bot/1.0'
      }
    });

    const results = res.data;
    if (!results || results.length === 0) {
      return bot.sendMessage(chatId, `😕 No results found for *${query}*`, { parse_mode: 'Markdown' });
    }

    const best = results[0];
    const latitude = parseFloat(best.lat);
    const longitude = parseFloat(best.lon);

    // Find nearby bus stops
    const nearbyStops = allStops
      .map(stop => ({
        ...stop,
        distance: geolib.getDistance(
          { latitude, longitude },
          { latitude: parseFloat(stop.Latitude), longitude: parseFloat(stop.Longitude) }
        )
      }))
      .filter(stop => stop.distance <= 1000)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);

    if (nearbyStops.length === 0) {
      return bot.sendMessage(chatId, "😕 No bus stops found within 1KM of that location.");
    }

    const buttons = nearbyStops.map(stop => [{
      text: `${stop.Description} (${stop.BusStopCode})`,
      callback_data: `stop_${stop.BusStopCode}`
    }]);

    return bot.sendMessage(chatId, `🚏 Nearby Bus Stops From "${query}":`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (err) {
    console.error('❌ Location search error:', err.message);
    return bot.sendMessage(chatId, '⚠️ Error searching location. Please try again.');
  }
});

// Handle Location
bot.on('location', async (msg) => {
  const { latitude, longitude } = msg.location;

  const nearbyStops = allStops
    .map(stop => ({
      ...stop,
      distance: geolib.getDistance(
        { latitude, longitude },
        { latitude: parseFloat(stop.Latitude), longitude: parseFloat(stop.Longitude) }
      )
    }))
    .filter(stop => stop.distance <= 1000)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8);

  if (nearbyStops.length === 0) {
    return bot.sendMessage(msg.chat.id, "😕 No bus stops found within 1KM.");
  }

  const buttons = nearbyStops.map(stop => [{
    text: `${stop.Description} (${stop.BusStopCode})`,
    callback_data: `stop_${stop.BusStopCode}`
  }]);

  bot.sendMessage(msg.chat.id, "🚏 Nearby Bus Stops:", {
    reply_markup: { inline_keyboard: buttons }
  });
});

// Callback Queries
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    if (data.startsWith('cancel_')) {
      const [, stopCode, serviceNo] = data.split('_');
      alertWatchlist = alertWatchlist.filter(
        a => !(a.chatId === chatId && a.busStopCode === stopCode && a.serviceNo === serviceNo)
      );

      await bot.deleteMessage(chatId, query.message.message_id);

      const alerts = alertWatchlist.filter(a => a.chatId === chatId);
      if (alerts.length === 0) {
        return bot.sendMessage(chatId, "📭 You have no active bus alerts.");
      }

      const inlineButtons = alerts.map(alert => {
        const stop = allStops.find(s => s.BusStopCode === alert.busStopCode);
        const stopName = stop ? stop.Description : alert.busStopCode;
        return [{
          text: `Bus ${alert.serviceNo} @ ${stopName} (${alert.busStopCode})`,
          callback_data: `cancel_${alert.busStopCode}_${alert.serviceNo}`
        }];
      });

      await bot.sendMessage(chatId, '📭 Below are your alerts:\n(press to cancel)', {
        reply_markup: { inline_keyboard: inlineButtons }
      });

      return bot.answerCallbackQuery(query.id);
    }

    if (data.startsWith('alert_')) {
      const [, stopCode, serviceNo] = data.split('_');
      alertWatchlist.push({ chatId, busStopCode: stopCode, serviceNo });

      const stop = allStops.find(s => s.BusStopCode === stopCode);
      const stopName = stop ? stop.Description : stopCode;
      await bot.sendMessage(chatId, `⏰ *Alert set for Bus ${serviceNo} @ ${stopName} (${stopCode})*`, {
        parse_mode: 'Markdown'
      });

      const inlineButtons = [
        [{ text: '🔔 Get Notified When Arriving', callback_data: `getalerts_${stopCode}` }],
        [{ text: '🔄 Refresh', callback_data: `refresh_${stopCode}` }]
      ];
      await bot.editMessageReplyMarkup({ inline_keyboard: inlineButtons }, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      return bot.answerCallbackQuery(query.id);
    }

    if (data.startsWith('getalerts_')) {
      const [, stopCode] = data.split('_');
      const res = await axios.get('https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival', {
        headers: { 'AccountKey': LTA_KEY },
        params: { BusStopCode: stopCode }
      });

      const services = (res.data.Services || []).sort((a, b) =>
        a.ServiceNo.localeCompare(b.ServiceNo, 'en', { numeric: true })
      );

      const inlineButtons = services.map(bus => [{
        text: `🔔 ${bus.ServiceNo}`,
        callback_data: `alert_${stopCode}_${bus.ServiceNo}`
      }]);
      inlineButtons.push([{ text: '🔄 Refresh', callback_data: `refresh_${stopCode}` }]);

      await bot.editMessageReplyMarkup({ inline_keyboard: inlineButtons }, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      return bot.answerCallbackQuery(query.id);
    }

    if (data.startsWith('stop_') || data.startsWith('refresh_')) {
      const [, stopCode] = data.split('_');
      const res = await axios.get('https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival', {
        headers: { 'AccountKey': LTA_KEY },
        params: { BusStopCode: stopCode }
      });

      const services = (res.data.Services || []).sort((a, b) =>
        a.ServiceNo.localeCompare(b.ServiceNo, 'en', { numeric: true })
      );

      const stop = allStops.find(s => s.BusStopCode === stopCode);
      const stopName = stop ? stop.Description : stopCode;

      if (services.length === 0) {
        await bot.deleteMessage(chatId, query.message.message_id);
        await bot.sendMessage(chatId, `🛑 No buses currently available at ${stopName} (${stopCode}).`);
        return bot.answerCallbackQuery(query.id);
      }

      const message = renderArrivalMessage(stopCode, stopName, services);
      const inlineButtons = [
        [{ text: '🔔 Get Notified When Arriving', callback_data: `getalerts_${stopCode}` }],
        [{ text: '🔄 Refresh', callback_data: `refresh_${stopCode}` }]
      ];

      await bot.deleteMessage(chatId, query.message.message_id);
      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineButtons }
      });
      return bot.answerCallbackQuery(query.id);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
    await bot.answerCallbackQuery(query.id);
  }
});

// Alert Polling (sorted by bus number, includes type & capacity emoji)
setInterval(async () => {
  const groups = alertWatchlist.reduce((acc, item) => {
    if (!acc[item.busStopCode]) acc[item.busStopCode] = [];
    acc[item.busStopCode].push(item);
    return acc;
  }, {});

  for (const stopCode in groups) {
    try {
      const res = await axios.get('https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival', {
        headers: { 'AccountKey': LTA_KEY },
        params: { BusStopCode: stopCode }
      });

      const services = (res.data.Services || []).sort((a, b) =>
        a.ServiceNo.localeCompare(b.ServiceNo, 'en', { numeric: true })
      );

      const now = new Date();
      const stop = allStops.find(s => s.BusStopCode === stopCode);
      const stopName = stop ? stop.Description : stopCode;

      for (const { chatId, serviceNo } of groups[stopCode]) {
        const bus = services.find(s => s.ServiceNo === serviceNo);
        if (!bus) continue;

        const eta = new Date(bus.NextBus.EstimatedArrival);
        const mins = Math.round((eta - now) / 60000);
        if (mins <= 0) {
          const typeIcon = getBusEmoji(bus.NextBus.Feature, bus.NextBus.Type);
          const loadIcon = getLoadEmoji(bus.NextBus.Load);
          const message = `🔔 ${typeIcon} ${serviceNo}${loadIcon} is arriving now at ${stopName} (${stopCode})!`;

          await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

          alertWatchlist = alertWatchlist.filter(
            a => !(a.chatId === chatId && a.busStopCode === stopCode && a.serviceNo === serviceNo)
          );
        }else if(mins == 5){
          const typeIcon = getBusEmoji(bus.NextBus.Feature, bus.NextBus.Type);
          const loadIcon = getLoadEmoji(bus.NextBus.Load);
          const message = `⏰ ${typeIcon} ${serviceNo}${loadIcon} is *5 mins* away from ${stopName} (${stopCode})!`;

          await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        }
      }
    } catch (err) {
      console.error(`❌ Alert check failed at ${stopCode}:`, err.message);
    }
  }
}, 30000);



bot.onText(/\/princessmode/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Welcome Princess!', {
    reply_markup: {
      keyboard: [
        [{ text: "🥱 Im Bored" }, { text:"👶 Im just a baby"}]
      ],
      resize_keyboard: true
    }
  });
});

bot.onText(/🥱 Im Bored/, (msg) => {
  bot.sendMessage(msg.chat.id, "Hello bored im your personal bot at your service.",{
    reply_markup: {
      keyboard: [
        [{ text: "🥱 Im Bored" }, { text:"👶 Im just a baby"}]
      ],
      resize_keyboard: true
    }
  });
});

bot.onText(/👶 Im just a baby/, (msg) => {
  for(i in 100){
    bot.sendMessage(msg.chat.id, "Hello baby",{
      reply_markup: {
        keyboard: [
          [{ text: "🥱 Im Bored" }, { text:"👶 Im just a baby"}]
        ],
        resize_keyboard: true
      }
    });
  }
});