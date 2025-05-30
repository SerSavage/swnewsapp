const express = require('express');
const puppeteer = require('puppeteer');
const { WebhookClient } = require('discord.js');
const fs = require('fs').promises;
require('dotenv').config();

const app = express();
const port = process.env.PORT || 10000;

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const webhookClient = new WebhookClient({ url: WEBHOOK_URL });

const STARWARS_NEWS_URL = 'https://www.starwars.com/news';
const POLL_INTERVAL = 300000; // Poll every 5 minutes

// File to persist lastNews and lastResetDate
const LAST_NEWS_FILE = 'lastNews.json';

// Initial start date for filtering articles (May 29, 2024)
const INITIAL_START_DATE = new Date('2024-05-29T00:00:00Z');

let lastNews = new Set();
let lastResetDate = INITIAL_START_DATE;

// Load lastNews and lastResetDate from file on startup
async function loadLastNews() {
  try {
    const data = await fs.readFile(LAST_NEWS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    lastNews = new Set(parsed.lastNews || []);
    lastResetDate = parsed.lastResetDate ? new Date(parsed.lastResetDate) : INITIAL_START_DATE;
    console.log(`Loaded lastNews with ${lastNews.size} entries, lastResetDate: ${lastResetDate}`);
  } catch (error) {
    console.log('No lastNews file found or error loading, starting fresh.');
    lastResetDate = new Date(); // On first run or reset, use current date
    await saveLastNews(); // Create the file
  }
}

// Save lastNews and lastResetDate to file
async function saveLastNews() {
  try {
    const data = {
      lastNews: Array.from(lastNews),
      lastResetDate: lastResetDate.toISOString(),
    };
    await fs.writeFile(LAST_NEWS_FILE, JSON.stringify(data, null, 2));
    console.log('Saved lastNews and lastResetDate to file.');
  } catch (error) {
    console.error('Error saving lastNews:', error.message);
  }
}

// Function to parse article date and compare
function isArticleAfterDate(articleDateStr, compareDate) {
  try {
    const articleDate = new Date(articleDateStr.replace('T', ' ').replace(/\..*$/, ''));
    if (isNaN(articleDate)) {
      // Try alternative parsing for formats like "May 30, 2025"
      const [month, day, year] = articleDateStr.split(/[\s,]+/).slice(0, 3);
      const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      const monthNum = months[month.slice(0, 3)] || 0;
      articleDate = new Date(year, monthNum, day || 1);
    }
    return !isNaN(articleDate) && articleDate >= compareDate;
  } catch (error) {
    console.error('Error parsing article date:', error.message, 'Date string:', articleDateStr);
    return false;
  }
}

// Function to scrape Star Wars news using Puppeteer
async function scrapeStarWarsNews() {
  let browser;
  try {
    console.log('Launching Puppeteer with pipe transport...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
      executablePath: '/opt/render/.cache/puppeteer/chrome/linux-136.0.7103.94/chrome-linux64/chrome',
      timeout: 60000,
      ignoreHTTPSErrors: true,
      pipe: true,
    });

    console.log('Browser launched successfully.');
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    console.log('Navigating to Star Wars news page...');
    await page.goto(STARWARS_NEWS_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('Page loaded successfully.');
    // Wait for dynamic content using a more robust method
    try {
      await page.waitForFunction('document.querySelector("body") !== null', { timeout: 10000 });
      await page.waitForTimeout(5000); // Wait 5 seconds for additional rendering
      // Scroll to trigger lazy-loaded content
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 100;
          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      });
    } catch (e) {
      console.error('Error waiting for content:', e.message);
    }

    // Debug: Log a larger sample of the body HTML
    const bodyHtml = await page.evaluate(() => document.querySelector('body')?.innerHTML || '');
    console.log('DEBUG: Body HTML Sample (first 10000 chars):', bodyHtml.substring(0, 10000));

    // Try a broader selector to capture articles
    const selector = 'article'; // Broad selector to test common structure
    const articlesFound = await page.waitForSelector(selector, { timeout: 10000 }).then(() => true).catch(() => false);
    if (!articlesFound) {
      console.log(`News articles selector "${selector}" not found, page structure might have changed.`);
      return [];
    }

    const articles = await page.evaluate(() => {
      const articles = [];
      document.querySelectorAll('article').forEach(elem => {
        const titleElement = elem.querySelector('h2, h3, .title, .headline');
        const linkElement = elem.querySelector('a[href]');
        const dateElement = elem.querySelector('time, .published-date, .date');

        const title = titleElement?.textContent.trim() || 'No title';
        const link = linkElement?.getAttribute('href') || '';
        const date = dateElement?.textContent.trim() || new Date().toISOString().split('T')[0];

        if (title && link) {
          const fullLink = link.startsWith('http') ? link : `https://www.starwars.com${link}`;
          articles.push({ title, link: fullLink, date });
        }
      });
      return articles;
    });

    console.log(`Scraped ${articles.length} articles from Star Wars news page.`);
    return articles;
  } catch (error) {
    console.error('Error scraping Star Wars news with Puppeteer:', error.message);
    return [];
  } finally {
    if (browser) {
      await browser.close().catch(err => console.error('Error closing browser:', err.message));
    }
  }
}

// Function to send Discord notification
async function sendDiscordNotification(title, link, source) {
  const embed = {
    title: `New Star Wars Update: ${title}`,
    url: link,
    description: `Source: ${source}`,
    color: 0xFFD700,
    timestamp: new Date().toISOString(),
    footer: { text: 'Star Wars News Monitor' }
  };

  await webhookClient.send({
    content: '🌌 New Star Wars announcement detected! 🌌',
    embeds: [embed]
  });
  console.log(`Sent Discord notification for: ${title}`);
}

// Function to check for new updates
async function checkUpdates() {
  console.log('Checking for new Star Wars news updates...');
  const newsArticles = await scrapeStarWarsNews();
  if (newsArticles.length === 0) {
    console.log('No new articles found or scraping failed.');
    return;
  }

  // Determine the earliest date to consider (May 29, 2024, or lastResetDate if later)
  const earliestDate = lastResetDate > INITIAL_START_DATE ? lastResetDate : INITIAL_START_DATE;

  const newArticles = newsArticles.filter(article => isArticleAfterDate(article.date, earliestDate));

  newArticles.forEach(article => {
    const key = `${article.title}-${article.date}`;
    if (!lastNews.has(key)) {
      lastNews.add(key);
      sendDiscordNotification(article.title, article.link, 'StarWars.com');
    }
  });

  // Save lastNews after processing
  await saveLastNews();
}

// Initialize lastNews and start polling
(async () => {
  await loadLastNews();
  checkUpdates(); // Run immediately on startup
  setInterval(checkUpdates, POLL_INTERVAL);
})();

// Web service endpoint to satisfy Render
app.get('/', (req, res) => {
  res.send('Star Wars News Monitor is running!');
});

app.listen(port, () => {
  console.log(`Star Wars News Monitor running on port ${port}`);
});
