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
const PORT = process.env.PORT || 10000; // Default to 10000 if not set
const MAIN_NEWS_URL = 'https://www.starwars.com/news';
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
const NAVIGATION_TIMEOUT = 120000; // 120 seconds

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

function loadCache() {
  console.log('Loaded in-memory cache:', Object.keys(inMemoryCache.categories).length, 'categories');
  return inMemoryCache;
}

function saveCache(cache) {
  inMemoryCache = { ...cache };
  console.log('Saved in-memory cache:', Object.keys(inMemoryCache.categories).length, 'categories');
}

async function scrapeArticles() {
  let browser;
  let page;
  let attempt = 1;

  while (attempt <= MAX_RETRIES) {
    try {
      console.log(`Scraping main news page (Attempt ${attempt}/${MAX_RETRIES}) with stealth plugin...`);
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

      page.on('error', err => console.error(`Page crash:`, err));
      page.on('pageerror', err => console.error(`Page script error:`, err));

      console.log(`Navigating to ${MAIN_NEWS_URL}...`);
      const response = await page.goto(MAIN_NEWS_URL, { waitUntil: 'domcontentloaded' });
      console.log(`HTTP status for ${MAIN_NEWS_URL}: ${response.status()}`);
      const headers = response.headers();
      if (headers['cf-ray']) {
        console.warn(`Cloudflare detected. Headers:`, headers);
      }
      if (response.status() === 404) {
        console.error(`404 Error for ${MAIN_NEWS_URL}. Page may be invalid.`);
      }

      // Wait for articles
      await page.waitForSelector('div.news-item, div.story-card, article, div.card, div.post', { timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 15000)); // Wait for dynamic content

      await page.screenshot({ path: path.join(DEBUG_DIR, `debug-main.png`) }).catch(err => console.error(`Error saving screenshot:`, err));
      const html = await page.content();
      await fs.writeFile(path.join(DEBUG_DIR, `debug-main.html`), html).catch(err => console.error(`Error saving HTML:`, err));

      const articles = await page.evaluate(() => {
        const articleElements = Array.from(document.querySelectorAll('div.news-item, div.story-card, article, div.card, div.post')).filter(el => {
          const link = el.querySelector('a[href]');
          const date = el.querySelector('time, span.date, div.date, p.date');
          return link && date && !el.closest('div.error-404');
        });

        console.log(`Found ${articleElements.length} potential articles`);

        const results = [];
        for (const el of articleElements) {
          const titleElem = el.querySelector('a');
          const dateElem = el.querySelector('time, span.date, div.date, p.date');
          const categoryElems = el.querySelectorAll('a[title*="category"], a[href*="/category/"], a[href*="/tag/"], span.category, div.category');

          if (titleElem && dateElem) {
            const title = titleElem.textContent.trim();
            let url = titleElem.getAttribute('href') || '';
            if (url && !url.startsWith('http')) {
              url = 'https://www.starwars.com' + (url.startsWith('/') ? url : '/' + url);
            }
            const date = dateElem.textContent.trim();
            const categories = Array.from(categoryElems)
              .map(cat => {
                const href = cat.getAttribute('href') || '';
                const text = cat.textContent.trim().toLowerCase();
                return href.split('/').pop() || text;
              })
              .filter(c => c);

            if (title && date && url) {
              results.push({ title, url, date, categories });
            }
          }
        }
        return results;
      });

      if (articles.length === 0 && html.includes('not fully armed and operational')) {
        console.error(`No articles found. Page is a 404 error.`);
      }

      console.log(`Scraped ${articles.length} articles from main news page.`);
      return articles;
    } catch (error) {
      console.error(`Error scraping main news page (Attempt ${attempt}/${MAX_RETRIES}):`, error.stack);
      attempt++;
      if (attempt <= MAX_RETRIES) {
        console.log(`Retrying in 10 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    } finally {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      await cleanupDebugFiles('main');
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
      setInterval(checkForNewArticles, 15 * 60 * 1000);
    }, 10000);
  });

  server.on('error', (error) => {
    console.error('Server error:', error);
  });
}

startApp().catch(error => console.error('Error starting app:', error));
