const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 10000; // Use Render's PORT or fallback to 10000 for local testing
const NEWS_URL = 'https://www.starwars.com/news';
const CACHE_FILE = path.join(__dirname, 'lastNews.json');

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
  try {
    console.log('Launching Puppeteer with pipe transport...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      pipe: true, // Use pipe transport for better performance
    });
    console.log('Browser launched successfully.');

    const page = await browser.newPage();
    console.log('Navigating to Star Wars news page...');

    // Set user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    // Navigate and wait for content
    await page.goto(NEWS_URL, { waitUntil: 'networkidle2' });
    console.log('Page loaded successfully.');

    // Wait for article grid to ensure dynamic content loads
    await page.waitForSelector('div[data-testid="content-grid"]', { timeout: 10000 }).catch(err => {
      console.error('Error waiting for content grid:', err);
    });

    // Optional: Wait additional time for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Scrape articles
    const articles = await page.evaluate(() => {
      const articleElements = document.querySelectorAll('div[data-testid="content-grid"] > div');
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
    console.error('Error scraping articles:', error);
    return [];
  } finally {
    if (browser) await browser.close();
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

    // Update cache with new articles
    cache.articles = [...newArticles, ...cache.articles].slice(0, 100); // Limit to 100 articles
    cache.lastResetDate = new Date().toISOString();
    await saveCache(cache);
  } else {
    console.log('No new articles found.');
  }

  return updates;
}

// Express API to serve articles (optional, adjust as needed)
app.get('/api/articles', async (req, res) => {
  const cache = await loadCache();
  res.json(cache.articles);
});

// Start server and periodic checking
app.listen(PORT, () => {
  console.log(`Star Wars News Monitor running on port ${PORT}`);
  // Check immediately on start
  checkForNewArticles();
  // Check every 5 minutes
  setInterval(checkForNewArticles, 5 * 60 * 1000);
});
