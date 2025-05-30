const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT; // Use Render's PORT only
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
const MAX_RETRIES = 3;
const NAVIGATION_TIMEOUT = 60000; // 60 seconds
const SELECTOR_TIMEOUT = 15000; // 15 seconds

// Initialize Discord client
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.log('No lastNews file found or error loading, starting fresh.');
    return { categories: {} };
  }
}

async function saveCache(cache) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log('Saved lastNews to file.');
  } catch (error) {
    console.error('Error saving cache:', error);
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
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        pipe: true,
      });
      console.log('Browser launched successfully.');

      const page = await browser.newPage();
      console.log(`Navigating to ${url}...`);

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      console.log(`Page loaded successfully for ${category}.`);

      let selectorFound = false;
      try {
        await page.waitForSelector('div[data-testid="content-grid"]', { timeout: SELECTOR_TIMEOUT });
        selectorFound = true;
        console.log(`Found primary selector: div[data-testid="content-grid"] for ${category}`);
      } catch (err) {
        console.error(`Error waiting for primary selector for ${category}:`, err);
      }

      if (!selectorFound) {
        try {
          await page.waitForSelector('div.module.list_module', { timeout: SELECTOR_TIMEOUT });
          selectorFound = true;
          console.log(`Found fallback selector: div.module.list_module for ${category}`);
        } catch (err) {
          console.error(`Error waiting for fallback selector for ${category}:`, err);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 5000));

      await page.screenshot({ path: `debug-${category}.png` }).catch(err => console.error(`Error saving screenshot for ${category}:`, err));
      const html = await page.content();
      await fs.writeFile(`debug-${category}.html`, html).catch(err => console.error(`Error saving HTML for ${category}:`, err));

      const articles = await page.evaluate(() => {
        const selectors = [
          'div[data-testid="content-grid"] > div',
          'div.module.list_module > div.entity-container',
        ];
        let articleElements = [];

        for (const selector of selectors) {
          articleElements = document.querySelectorAll(selector);
          if (articleElements.length > 0) break;
        }

        const results = [];
        for (const el of articleElements) {
          const titleElem = el.querySelector('h3 a');
          const dateElem = el.querySelector('time');
          const categoryElems = el.querySelectorAll('a[title*="category"]');

          if (titleElem && dateElem) {
            const title = titleElem.textContent.trim();
            const url = titleElem.href;
            const date = dateElem.textContent.trim();
            const categories = Array.from(categoryElems).map(cat => cat.textContent.trim());

            results.push({ title, url, date, categories });
          }
        }

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
      await new Promise(resolve => setTimeout(resolve, 5000));
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
      await channel.send({
        content: `**New ${category.charAt(0).toUpperCase() + category.slice(1).replace('-', ' ')} Article**\n**Title**: ${article.title}\n**Date**: ${article.date}\n**Categories**: ${article.categories.join(', ')}\n**Link**: ${article.url}`,
      });
      console.log(`Sent Discord notification for ${category}: ${article.title}`);
    }
  } catch (error) {
    console.error(`Error sending Discord notification for ${category}:`, error);
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
});

discordClient.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('Error logging into Discord:', error);
});

app.listen(PORT, () => {
  console.log(`Star Wars News Monitor running on port ${PORT}`);
  checkForNewArticles();
  setInterval(checkForNewArticles, 5 * 60 * 1000); // Check every 5 minutes
});
