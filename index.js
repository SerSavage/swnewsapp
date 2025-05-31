const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

// Add stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT; // Use Render's PORT
const BASE_URL = 'https://www.starwarsnewsnet.com/category/';
const CATEGORIES = [
  'star-wars', 'movies', 'tv', 'games', 'books', 'comics', 'collectibles',
  'theme-parks', 'fan-focus', 'editorials', 'rumors', 'interviews'
];
const CACHE_FILE = path.join(__dirname, 'lastest.json');
const MAX_RETRIES = 3;
const NAVIGATION_TIMEOUT = 90000; // 90 seconds

// In-memory cache
let globalCache = { categories: {}, lastResetDate: new Date().toISOString() };

// Initialize Discord client
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    const cache = JSON.parse(data);
    globalCache = cache;
    console.log('Loaded lastest.json from disk.');
    return cache;
  } catch (error) {
    console.log('No lastest.json found or error loading, using in-memory cache.');
    return globalCache;
  }
}

async function saveCache(cache) {
  globalCache = cache;
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log('Saved lastest.json to disk.');
  } catch (error) {
    console.error('Error saving lastest.json, continuing with in-memory cache:', error);
  }
}

async function scrapeArticles(category) {
  let browser;
  let attempt = 1;
  const url = `${BASE_URL}${category}`;

  while (attempt <= MAX_RETRIES) {
    try {
      console.log(`Launching Puppeteer for ${category} (Attempt ${attempt}/${MAX_RETRIES})...`);
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-features=site-per-process'],
        pipe: true,
      });
      console.log('Browser launched successfully.');

      const page = await browser.newPage();
      console.log(`Navigating to ${url}...`);

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');
      await page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      console.log(`Page loaded successfully for ${category}.`);

      // Wait for content
      const selector = 'article, div.post, div.entry, h1, h2, h3';
      await page.waitForSelector(selector, { timeout: 20000 }).catch(() => console.log('No content found, proceeding with available DOM.'));

      await page.screenshot({ path: `debug-${category}.png` }).catch(err => console.error(`Error saving screenshot for ${category}:`, err));
      const html = await page.content();
      await fs.writeFile(`debug-${category}.html`, html).catch(err => console.error(`Error saving HTML for ${category}:`, err));

      const articles = await page.evaluate(() => {
        const articleElements = Array.from(document.querySelectorAll('article, div.post, div.entry, [class*="post"], [class*="entry"]'));
        const results = [];

        for (const el of articleElements) {
          const titleElem = el.querySelector('h1 a, h2 a, h3 a, a[href*="/20"]');
          const dateElem = el.querySelector('time, [datetime], .posted-on, .entry-date');
          const categoryElems = el.querySelectorAll('a[rel="category"], .category, [class*="category"]');

          const title = titleElem ? titleElem.textContent.trim() : 'Untitled Article';
          let url = titleElem ? titleElem.getAttribute('href') || '' : '';
          if (url && !url.startsWith('http')) {
            url = 'https://www.starwarsnewsnet.com' + (url.startsWith('/') ? url : '/' + url);
          }
          const date = dateElem ? dateElem.getAttribute('datetime') || dateElem.textContent.trim() : 'N/A';
          const categories = Array.from(categoryElems).map(cat => cat.textContent.trim()).filter(c => c);

          if (title !== 'Untitled Article' && url) {
            results.push({ title, url, date, categories: categories.length ? categories : ['Uncategorized'] });
            console.log(`Extracted article: ${title} (${date})`);
          }
        }

        console.log(`Total articles extracted: ${results.length}`);
        return results;
      });

      console.log(`Scraped ${articles.length} articles from ${category}.`);
      return articles;
    } catch (error) {
      console.error(`Error scraping ${category} (Attempt ${attempt}/${MAX_RETRIES}):`, error);
      if (attempt === MAX_RETRIES) {
        console.error(`Max retries reached for ${category}. Returning empty array.`);
        return [];
      }
      attempt++;
      await new Promise(resolve => setTimeout(resolve, 10000));
    } finally {
      if (browser) await browser.close();
    }
  }
}

async function sendDiscordNotification(category, articles) {
  if (!articles.length) return;

  try {
    const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    for (const article of articles) {
      const message = `**New ${category.charAt(0).toUpperCase() + category.slice(1).replace('-', ' ')} Article**\n` +
                      `**Title**: ${article.title}\n` +
                      `**Date**: ${article.date !== 'N/A' ? article.date : 'Unknown'}\n` +
                      `**Categories**: ${article.categories.join(', ')}\n` +
                      `**Link**: ${article.url}`;
      await channel.send({ content: message });
      console.log(`Sent Discord notification for ${category}: ${article.title}`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Avoid rate limits
    }
  } catch (error) {
    console.error(`Error sending Discord notification for ${category}:`, error);
    throw new Error(`Failed to send Discord notification: ${error.message}`);
  }
}

async function checkForNewArticles() {
  console.log('Checking for new Star Wars news updates across categories...');
  const cache = await loadCache();
  if (!cache.categories) cache.categories = {};

  for (const category of CATEGORIES) {
    console.log(`Checking category: ${category}`);
    const cachedUrls = new Set((cache.categories[category] || []).map(article => article.url));
    const newArticles = await scrapeArticles(category);

    const updates = newArticles.filter(article => !cachedUrls.has(article.url));

    if (updates.length > 0) {
      console.log(`Found ${updates.length} new articles in ${category}:`);
      updates.forEach(article => console.log(`- ${article.title} (${article.date})`));

      await sendDiscordNotification(category, updates);

      cache.categories[category] = [...newArticles, ...(cache.categories[category] || [])].slice(0, 100);
    } else {
      console.log(`No new articles found in ${category}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  cache.lastResetDate = new Date().toISOString();
  await saveCache(cache);
}

// Express API
app.get('/api/articles', async (req, res) => {
  const cache = await loadCache();
  res.json(cache.categories);
});

// Health check for Render
app.get('/health', (req, res) => res.status(200).send('OK'));

// Start Discord client and server
discordClient.once('ready', () => {
  console.log(`Logged in as ${discordClient.user.tag}`);
  checkForNewArticles();
  setInterval(checkForNewArticles, 15 * 60 * 1000); // Every 15 minutes
});

discordClient.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('Error logging into Discord:', error);
});

app.listen(PORT, () => {
  console.log(`Star Wars News Monitor running on port ${PORT}`);
});
