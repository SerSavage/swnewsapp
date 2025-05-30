const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT; // Use Render's PORT only
const NEWS_URL = 'https://www.starwars.com/news';
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
    return { articles: [], lastResetDate: new Date().toISOString() };
  }
}

async function saveCache(cache) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log('Saved lastNews and lastResetDate to file.');
  } catch (error) {
    console.error('Error saving cache:', error);
  }
}

async function scrapeArticles() {
  let browser;
  let attempt = 1;

  while (attempt <= MAX_RETRIES) {
    try {
      console.log(`Launching Puppeteer with pipe transport (Attempt ${attempt}/${MAX_RETRIES})...`);
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        pipe: true,
      });
      console.log('Browser launched successfully.');

      const page = await browser.newPage();
      console.log('Navigating to Star Wars news page...');

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

      await page.goto(NEWS_URL, { waitUntil: 'domcontentloaded' });
      console.log('Page loaded successfully.');

      // Try primary selector
      let selectorFound = false;
      try {
        await page.waitForSelector('div[data-testid="content-grid"]', { timeout: SELECTOR_TIMEOUT });
        selectorFound = true;
        console.log('Found primary selector: div[data-testid="content-grid"]');
      } catch (err) {
        console.error('Error waiting for primary selector:', err);
      }

      // Fallback selector if primary fails
      if (!selectorFound) {
        try {
          await page.waitForSelector('div.module.list_module', { timeout: SELECTOR_TIMEOUT });
          selectorFound = true;
          console.log('Found fallback selector: div.module.list_module');
        } catch (err) {
          console.error('Error waiting for fallback selector:', err);
        }
      }

      // Additional wait for dynamic content
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Debug: Save screenshot and HTML
      await page.screenshot({ path: 'debug.png' }).catch(err => console.error('Error saving screenshot:', err));
      const html = await page.content();
      await fs.writeFile('debug.html', html).catch(err => console.error('Error saving HTML:', err));

      const articles = await page.evaluate(() => {
        // Try multiple selectors
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

      console.log(`Scraped ${articles.length} articles from Star Wars news page.`);
      return articles;
    } catch (error) {
      console.error(`Error scraping articles (Attempt ${attempt}/${MAX_RETRIES}):`, error);
      if (attempt === MAX_RETRIES) {
        console.error('Max retries reached. Returning empty array.');
        return [];
      }
      attempt++;
      await new Promise(resolve => setTimeout(resolve, 5000));
    } finally {
      if (browser) await browser.close();
    }
  }
}

async function sendDiscordNotification(articles) {
  if (!articles.length) return;

  try {
    const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    for (const article of articles) {
      await channel.send({
        content: `**New Star Wars Article**\n**Title**: ${article.title}\n**Date**: ${article.date}\n**Categories**: ${article.categories.join(', ')}\n**Link**: ${article.url}`,
      });
      console.log(`Sent Discord notification for: ${article.title}`);
    }
  } catch (error) {
    console.error('Error sending Discord notification:', error);
  }
}

async function checkForNewArticles() {
  console.log('Checking for new Star Wars news updates...');
  const cache = await loadCache();
  const cachedUrls = new Set(cache.articles.map(article => article.url));
  const newArticles = await scrapeArticles();

  const updates = newArticles.filter(article => !cachedUrls.has(article.url));

  if (updates.length > 0) {
    console.log(`Found ${updates.length} new articles:`);
    updates.forEach(article => console.log(`- ${article.title} (${article.date})`));

    await sendDiscordNotification(updates);

    cache.articles = [...newArticles, ...cache.articles].slice(0, 100);
    cache.lastResetDate = new Date().toISOString();
    await saveCache(cache);
  } else {
    console.log('No new articles found.');
  }

  return updates;
}

// Express API
app.get('/api/articles', async (req, res) => {
  const cache = await loadCache();
  res.json(cache.articles);
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
  setInterval(checkForNewArticles, 5 * 60 * 1000);
});
