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
    // Launch Puppeteer with arguments suitable for Render
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'], // Optimize for Render
      executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined // Use Render's Chrome if available
    });

    const page = await browser.newPage();

    // Set User-Agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // Navigate to the page
    await page.goto(STARWARS_NEWS_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the news articles to load
    await page.waitForSelector('.news-article', { timeout: 10000 }).catch(() => {
      console.log('News articles selector not found, page might have changed');
    });

    // Extract articles
    const articles = await page.evaluate(() => {
      const articles = [];
      document.querySelectorAll('.news-article').forEach(elem => {
        const title = elem.querySelector('.article-title')?.textContent.trim();
        const link = elem.querySelector('a')?.getAttribute('href');
        const date = elem.querySelector('.article-date')?.textContent.trim();
        if (title && link) {
          articles.push({ title, link: `https://www.starwars.com${link}`, date });
        }
      });
      return articles;
    });

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
  // Scrape news website
  const newsArticles = await scrapeStarWarsNews();
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