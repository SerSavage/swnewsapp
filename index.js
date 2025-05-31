const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;
const MAIN_NEWS_URL = 'https://www.starwars.com/news';
const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY;
const CATEGORIES = [
  'andor', 'ahsoka', 'the-mandalorian', 'skeleton-crew', 'the-acolyte',
  'obi-wan-kenobi', 'the-book-of-boba-fett', 'the-bad-batch', 'the-clone-wars',
  'visions', 'behind-the-scenes', 'books-comics', 'characters-histories',
  'collecting', 'creativity', 'disney-parks', 'disney', 'events', 'fans-community',
  'films', 'games-apps', 'ilm', 'interviews', 'lego-star-wars', 'lucasfilm',
  'merchandise', 'opinions', 'quizzes-polls', 'recipes', 'rogue-one', 'solo',
  'star-wars-day', 'star-wars-rebels', 'series', 'the-high-republic'
];
const DEBUG_DIR = path.join(__dirname, 'debug');
const MAX_RETRIES = 3;

// In-memory cache
let inMemoryCache = { categories: {}, lastResetDate: new Date().toISOString() };

// Ensure debug directory exists
async function ensureDebugDir() {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    console.log('Debug directory ready at', DEBUG_DIR);
  } catch (error) {
    console.error('Error creating debug directory:', error);
  }
}

// Clean up old debug files
async function cleanupDebugFiles() {
  try {
    const files = ['debug-main.html'];
    for (const file of files) {
      await fs.unlink(path.join(DEBUG_DIR, file)).catch(() => {});
    }
    console.log('Cleaned up debug files.');
  } catch (error) {
    console.error('Error cleaning up debug files:', error);
  }
}

function loadCache() {
  console.log('Loaded in-memory cache:', Object.keys(inMemoryCache.categories).length, 'categories');
  return inMemoryCache;
}

function saveCache(cache) {
  inMemoryCache = { ...cache };
  console.log('Saved in-memory cache:', Object.keys(inMemoryCache.categories).length, 'categories');
}

async function scrapeArticles() {
  let attempt = 1;

  while (attempt <= MAX_RETRIES) {
    try {
      console.log(`Scraping main news page (Attempt ${attempt}/${MAX_RETRIES}) with ZenRows...`);
      const zenrowsUrl = `https://api.zenrows.com/v1/?apikey=${ZENROWS_API_KEY}&url=${encodeURIComponent(MAIN_NEWS_URL)}&js_render=true&premium_proxy=true`;
      const response = await axios.get(zenrowsUrl);

      if (response.status !== 200) {
        throw new Error(`ZenRows API returned status ${response.status}: ${response.statusText}`);
      }

      const html = response.data;
      console.log(`Received HTML content length: ${html.length} characters`);

      await fs.writeFile(path.join(DEBUG_DIR, 'debug-main.html'), html).catch(err => console.error('Error saving HTML:', err));

      const articles = [];
      const articleRegex = /<article[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<time[^>]*>([^<]+)|<span[^>]+date[^>]*>([^<]+))[\s\S]*?<\/article>/gi;
      const categoryRegex = /<a[^>]+href="[^"]*\/(?:category|tag)\/([^"]+)"[^>]*>([^<]+?)<\/a>/gi;

      let match;
      while ((match = articleRegex.exec(html)) !== null) {
        const url = match[1].startsWith('http') ? match[1] : `https://www.starwars.com${match[1].startsWith('/') ? match[1] : '/' + match[1]}`;
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const date = (match[3] || match[4] || '').trim();

        const articleHtml = match[0];
        const categories = [];
        let catMatch;
        while ((catMatch = categoryRegex.exec(articleHtml)) !== null) {
          const cat = catMatch[1].toLowerCase();
          if (cat) categories.push(cat);
        }

        if (title && date && url) {
          articles.push({ title, url, date, categories });
        }
      }

      if (articles.length === 0 && html.includes('not fully armed and operational')) {
        console.error('No articles found. Page is a 404 error.');
      }

      console.log(`Scraped ${articles.length} articles from main news page.`);
      return articles;
    } catch (error) {
      console.error(`Error scraping main news page (Attempt ${attempt}/${MAX_RETRIES}):`, error.message);
      attempt++;
      if (attempt <= MAX_RETRIES) {
        console.log('Retrying in 10 seconds...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    } finally {
      await cleanupDebugFiles();
    }
  }
  console.error(`Failed to scrape main news page after ${MAX_RETRIES} attempts.`);
  return [];
}

async function sendDiscordNotification(category, articles) {
  if (!articles.length) return;

  try {
    const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    for (const article of articles) {
      await channel.send({
        content: `**New ${category.replace(/-/g, ' ').toUpperCase()} Article**\n**Title**: ${article.title}\n**Date**: ${article.date}\n**Categories**: ${article.categories.join(', ') || 'None'}\n**Link**: ${article.url}`,
      });
      console.log(`Sent Discord notification for ${category}: ${article.title}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error(`Error sending Discord notification for ${category}:`, error);
  }
}

async function checkForNewArticles() {
  console.log('Checking for new Star Wars news...');
  await ensureDebugDir();
  const cache = loadCache();

  const allArticles = await scrapeArticles();

  for (const category of CATEGORIES) {
    console.log(`Processing category: ${category}`);
    const cachedUrls = new Set((cache.categories[category] || []).map(article => article.url));
    const newArticles = allArticles.filter(article => 
      article.categories.some(cat => cat.toLowerCase().includes(category.toLowerCase())) &&
      !cachedUrls.has(article.url)
    );

    if (newArticles.length > 0) {
      console.log(`Found ${newArticles.length} new articles in ${category}:`, newArticles.map(a => a.title));
      await sendDiscordNotification(category, newArticles);
      cache.categories[category] = [...newArticles, ...(cache.categories[category] || [])].slice(0, 50);
      saveCache(cache);
    } else {
      console.log(`No new articles in ${category}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  cache.lastResetDate = new Date().toISOString();
  saveCache(cache);
}

// Express API with logging
app.get('/api/articles', (req, res) => {
  console.log('API /api/articles hit');
  try {
    const cache = loadCache();
    if (Object.keys(cache.categories).length === 0) {
      res.status(200).json({ message: 'No articles cached yet' });
    } else {
      res.json(cache.categories);
    }
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// Health check with cache status
app.get('/health', (req, res) => {
  const cache = loadCache();
  const hasCache = Object.keys(cache.categories).length > 0;
  res.status(200).send(`OK - In-memory cache ${hasCache ? 'has data' : 'is empty'}`);
});

// Initialize Discord client
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

discordClient.once('ready', () => {
  console.log(`Logged in as ${discordClient.user.tag}`);
});

async function startApp() {
  try {
    await discordClient.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Error logging into Discord:', error);
  }

  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setTimeout(() => {
      checkForNewArticles().then(() => console.log('Initial scrape completed')).catch(error => console.error('Initial scrape failed:', error));
      setInterval(checkForNewArticles, 2 * 60 * 60 * 1000); // Check every 2 hours
    }, 10000);
  });

  server.on('error', (error) => {
    console.error('Server error:', error);
  });
}

startApp().catch(error => console.error('Error starting app:', error));
