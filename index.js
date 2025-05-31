const express = require('express');
const { WebhookClient } = require('discord.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error('DISCORD_WEBHOOK_URL environment variable is not set.');
  process.exit(1);
}

// Initialize Discord webhook client
const webhookClient = new WebhookClient({ url: WEBHOOK_URL });

// Store previously posted article titles to avoid duplicates
let previousTitles = new Set();

// Scrape Star Wars news
async function scrapeStarWarsNews() {
  let browser;
  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    // Navigate to the news page
    await page.goto('https://www.starwarsnewsnet.com/category/star-wars', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for articles
    await page.waitForSelector('.td_module_1', { timeout: 10000 });

    // Scrape articles
    const articles = await page.evaluate(() => {
      const newsItems = document.querySelectorAll('.td_module_1');
      const results = [];

      newsItems.forEach((item) => {
        const titleElement = item.querySelector('.entry-title a');
        const dateElement = item.querySelector('.td-post-date time');
        const authorElement = item.querySelector('.td-post-author-name a');
        const categoriesElement = item.querySelector('.td-post-category');
        const linkElement = item.querySelector('.entry-title a');

        results.push({
          title: titleElement ? titleElement.textContent.trim() : 'N/A',
          date: dateElement ? dateElement.getAttribute('datetime') : 'N/A',
          author: authorElement ? authorElement.textContent.trim() : 'N/A',
          categories: categoriesElement ? categoriesElement.textContent.trim().split(', ') : [],
          link: linkElement ? linkElement.href : 'N/A',
        });
      });

      return results.slice(0, 5); // Limit to 5 articles
    });

    return articles;

  } catch (error) {
    console.error('Scraping error:', error);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// Post new articles to Discord
async function postNews() {
  try {
    const articles = await scrapeStarWarsNews();
    if (articles.length === 0) {
      console.log('No new articles found or an error occurred.');
      return;
    }

    const newArticles = articles.filter(article => !previousTitles.has(article.title));
    if (newArticles.length === 0) {
      console.log('No new articles to post.');
      return;
    }

    for (const article of newArticles) {
      const message = `**New Star Wars Article**\n` +
                      `**Title**: ${article.title}\n` +
                      `**Date**: ${new Date(article.date).toLocaleDateString()}\n` +
                      `**Author**: ${article.author}\n` +
                      `**Categories**: ${article.categories.join(', ')}\n` +
                      `**Link**: ${article.link}\n`;

      await webhookClient.send({
        content: message,
        username: 'Star Wars News Bot',
        avatarURL: 'https://www.starwarsnewsnet.com/wp-content/uploads/2017/03/swnewsnet-logo-retina.png',
      });

      // Add to previous titles
      previousTitles.add(article.title);

      // Keep only the last 50 titles to manage memory
      if (previousTitles.size > 50) {
        const titlesArray = Array.from(previousTitles);
        previousTitles = new Set(titlesArray.slice(-50));
      }

      // Delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`Posted ${newArticles.length} new articles.`);

  } catch (error) {
    console.error('Error posting news:', error);
  }
}

// Basic HTTP endpoint for Render
app.get('/', (req, res) => {
  res.send('Star Wars News Bot is running.');
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);

  // Run immediately on start
  postNews();

  // Schedule scraping every 6 hours
  setInterval(postNews, 6 * 60 * 60 * 1000);
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  webhookClient.destroy();
  process.exit(0);
});
