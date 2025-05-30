const express = require('express');
const puppeteer = require('puppeteer');
const { WebhookClient } = require('discord.js');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 10000;

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const webhookClient = new WebhookClient({ url: WEBHOOK_URL });

const STARWARS_NEWS_URL = 'https://www.starwars.com/news';
const POLL_INTERVAL = 300000; // Poll every 5 minutes

let lastNews = new Set();

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
      pipe: true, // Use pipe transport instead of WebSocket
    });

    console.log('Browser launched successfully.');
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    console.log('Navigating to Star Wars news page...');
    await page.goto(STARWARS_NEWS_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('Page loaded successfully.');
    const selector = '.article-preview'; // Replace with the correct class from screenshots
    const articlesFound = await page.waitForSelector(selector, { timeout: 10000 }).then(() => true).catch(() => false);
    if (!articlesFound) {
      console.log(`News articles selector "${selector}" not found, page structure might have changed.`);
      return [];
    }

    const articles = await page.evaluate(() => {
      const articles = [];
      document.querySelectorAll('.article-preview').forEach(elem => {
        const titleElement = elem.querySelector('h2, h3, .headline, .title');
        const linkElement = elem.querySelector('a');
        const dateElement = elem.querySelector('time, .published-date, .date, .publish-date');

        const title = titleElement?.textContent.trim();
        const link = linkElement?.getAttribute('href');
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

  newsArticles.forEach(article => {
    const key = `${article.title}-${article.date}`;
    if (!lastNews.has(key)) {
      lastNews.add(key);
      sendDiscordNotification(article.title, article.link, 'StarWars.com');
    }
  });
}

// Start polling
checkUpdates(); // Run immediately on startup
setInterval(checkUpdates, POLL_INTERVAL);

// Web service endpoint to satisfy Render
app.get('/', (req, res) => {
  res.send('Star Wars News Monitor is running!');
});

app.listen(port, () => {
  console.log(`Star Wars News Monitor running on port ${port}`);
});
