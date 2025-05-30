const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT; // Rely on Render's PORT
const BASE_URL = 'https://www.starwars.com/news/category/';
const CATEGORIES = [
  'andor', 'ahsoka', 'the-mandalorian', 'skeleton-crew', 'the-acolyte',
  'obi-wan-kenobi', 'the-book-of-boba-fett', 'the-bad-batch', 'the-clone-wars',
  'visions', 'behind-the-scenes', 'books-comics', 'characters-histories',
  'collecting', 'creativity', 'disney-parks', 'disney', 'events', 'fans-community',
  'films', 'games-apps', 'ilm', 'interviews', 'lego-star-wars', 'lucasfilm',
  'merchandise', 'opinions', 'quizzes-polls', 'recipes', 'rogue-one', 'solo',
  'star-wars-day', 'star-wars-rebels', 'series', 'the-high-republic'
];
const CACHE_FILE = path.join(__dirname, 'lastNews.json');
const DEBUG_DIR = path.join(__dirname, 'debug');
const MAX_RETRIES = 3;
const NAVIGATION_TIMEOUT = 120000; // 120 seconds

// Ensure directories exist
async function ensureDirectories() {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    console.log('Cache and debug directories ready.');
  } catch (error) {
    console.error('Error creating directories:', error);
  }
}

// Clean up old debug files
async function cleanupDebugFiles(category) {
  try {
    const files = [`debug-${category}.png`, `debug-${category}.html`];
    for (const file of files) {
      await fs.unlink(path.join(DEBUG_DIR, file)).catch(() => {});
    }
    console.log(`Cleaned up debug files for ${category}.`);
  } catch (error) {
    console.error(`Error cleaning up debug files for ${category}:`, error);
  }
}

async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    const cache = JSON.parse(data);
    console.log('Cache loaded successfully.');
    return cache;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Cache file not found, starting fresh.');
    } else {
      console.error('Error loading cache:', error);
    }
    return { categories: {}, lastResetDate: new Date().toISOString() };
  }
}

async function saveCache(cache) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log('Cache saved successfully to', CACHE_FILE);
  } catch (error) {
    console.error('Error saving cache:', error);
  }
}

async function scrapeArticles(category) {
  let browser;
  let page;
  let attempt = 1;
  const url = `${BASE_URL}${category}`;

  while (attempt <= MAX_RETRIES) {
    try {
      console.log(`Scraping ${category} (Attempt ${attempt}/${MAX_RETRIES}) with stealth plugin...`);
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process',
        ],
        pipe: true,
      });

      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

      page.on('error', err => console.error(`Page crash for ${category}:`, err));
      page.on('pageerror', err => console.error(`Page script error for ${category}:`, err));

      console.log(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      await page.waitForSelector('article, div.card, div.post', { timeout: 60000 });

      await page.screenshot({ path: path.join(DEBUG_DIR, `debug-${category}.png`) }).catch(err => console.error(`Error saving screenshot for ${category}:`, err));
      const html = await page.content();
      await fs.writeFile(path.join(DEBUG_DIR, `debug-${category}.html`), html).catch(err => console.error(`Error saving HTML for ${category}:`, err));

      const articles = await page.evaluate(() => {
        const articleElements = Array.from(document.querySelectorAll('article, div.card, div.post')).filter(el => {
          return el.querySelector('a[href]') && el.querySelector('time');
        });

        console.log(`Found ${articleElements.length} potential articles`);

        const results = [];
        for (const el of articleElements) {
          const titleElem = el.querySelector('a');
          const dateElems = el.querySelectorAll('time');
          const categoryElems = el.querySelectorAll('a[title*="category"], a[href*="/category/"]');

          if (titleElem && dateElems.length > 0) {
            const title = titleElem.textContent.trim();
            let url = titleElem.getAttribute('href') || '';
            if (url && !url.startsWith('http')) {
              url = 'https://www.starwars.com' + (url.startsWith('/') ? url : '/' + url);
            }
            const date = dateElems[0].textContent.trim();
            const categories = Array.from(categoryElems).map(cat => cat.textContent.trim()).filter(c => c);

            if (title && date && url) {
              results.push({ title, url, date, categories });
            }
          }
        }
        return results;
      });

      console.log(`Scraped ${articles.length} articles from ${category}.`);
      return articles;
    } catch (error) {
      console.error(`Error scraping ${category} (Attempt ${attempt}/${MAX_RETRIES}):`, error.stack);
      attempt++;
      if (attempt <= MAX_RETRIES) {
        console.log(`Retrying in 10 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    } finally {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      await cleanupDebugFiles(category);
    }
  }
  console.error(`Failed to scrape ${category} after ${MAX_RETRIES} attempts.`);
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
  await ensureDirectories();
  const cache = await loadCache();

  for (const category of CATEGORIES) {
    try {
      console.log(`Processing category: ${category}`);
      const cachedUrls = new Set((cache.categories[category] || []).map(article => article.url));
      const newArticles = await scrapeArticles(category);

      const updates = newArticles.filter(article => !cachedUrls.has(article.url));

      if (updates.length > 0) {
        console.log(`Found ${updates.length} new articles in ${category}:`, updates.map(a => a.title));
        await sendDiscordNotification(category, updates);
        cache.categories[category] = [...updates, ...(cache.categories[category] || [])].slice(0, 50);
        await saveCache(cache); // Save after each category to ensure progress
      } else {
        console.log(`No new articles in ${category}.`);
      }
    } catch (error) {
      console.error(`Error processing category ${category}:`, error);
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  cache.lastResetDate = new Date().toISOString();
  await saveCache(cache);
}

// Express API
app.get('/api/articles', async (req, res) => {
  try {
    const cache = await loadCache();
    res.json(cache.categories);
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// Health check with cache status
app.get('/health', async (req, res) => {
  try {
    await fs.access(CACHE_FILE);
    res.status(200).send('OK - Cache file exists');
  } catch {
    res.status(200).send('OK - Cache file missing');
  }
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

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setTimeout(() => {
      checkForNewArticles().then(() => console.log('Initial scrape completed')).catch(error => console.error('Initial scrape failed:', error));
      setInterval(checkForNewArticles, 15 * 60 * 1000);
    }, 10000);
  });
}

startApp().catch(error => console.error('Error starting app:', error));
