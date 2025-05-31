const express = require('express');
const { WebhookClient } = require('discord.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');
const fs = require('fs').promises;

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

// Scrape Star Wars news with retry logic
async function scrapeStarWarsNews() {
  let browser;
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      attempt++;
      console.log(`Scraping attempt ${attempt}/${maxRetries}`);

      // Launch browser
      browser = await puppeteer.launch({
        headless: true,
        executablePath: executablePath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const page = await browser.newPage();

      // Navigate to the news page
      await page.goto('https://www.starwarsnewsnet.com/category/star-wars', {
        waitUntil: 'networkidle2', // Wait for network to be idle
        timeout: 30000,
      });

      // Wait for articles with a fallback selector
      const selector = '.td_module_1, .entry-title, article'; // Fallback to broader selectors
      const articlesFound = await page.waitForSelector(selector, { timeout: 15000 });

      if (!articlesFound) {
        console.error('No articles found with selector:', selector);
        // Save page HTML for debugging
        const html = await page.content();
        await fs.writeFile('debug.html', html).catch(err => console.error('Failed to save debug HTML:', err));
        return [];
      }

      // Scrape articles
      const articles = await page.evaluate(() => {
        // Try multiple selectors
        const newsItems = document.querySelectorAll('.td_module_1, article');
        const results = [];

        newsItems.forEach((item) => {
          const titleElement = item.querySelector('.entry-title a, h2 a, h3 a');
          const dateElement = item.querySelector('.td-post-date time, time');
          const authorElement = item.querySelector('.td-post-author-name a, .author a');
          const categoriesElement = item.querySelector('.td-post-category, .category');
          const linkElement = item.querySelector('.entry-title a, h2 a, h3 a');

          results.push({
            title: titleElement ? titleElement.textContent.trim() : 'N/A',
            date: dateElement ? dateElement.getAttribute('datetime') || 'N/A' : 'N/A',
            author: authorElement ? authorElement.textContent.trim() : 'N/A',
            categories: categoriesElement ? categoriesElement.textContent.trim().split(', ') : [],
            link: linkElement ? linkElement.href : 'N/A',
          });
        });

        return results.slice(0, 5); // Limit to 5 articles
      });

      console.log(`Scraped ${articles.length} articles`);
      return articles;

    } catch (error) {
      console.error(`Scraping attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) {
        console.error('Max retries reached. Returning empty array.');
        // Save page HTML for debugging
        if (browser) {
          const page = await browser.newPage();
          await page.goto('https://www.starwarsnewsnet.com/category/star-wars', { waitUntil: 'networkidle2' });
          const html = await page.content();
          await fs.writeFile('debug.html', html).catch(err => console.error('Failed to save debug HTML:', err));
          await page.close();
        }
        return [];
      }
    } finally {
      if (browser) await browser.close();
    }
  }
  return [];
}

// Post new articles to Discord
async function postNews() {
  try {
    const articles = await scrapeStarWarsNews();
    if (articles.length === 0) {
      console.log('No new articles found or an error occurred.');
      await webhookClient.send({
        content: 'No new Star Wars news found or an error occurred.',
        username: 'Star Wars News Bot',
        avatarURL: 'https://www.starwarsnewsnet.com/wp-content/uploads/2017/03/swnewsnet-logo-retina.png',
      });
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
    await webhookClient.send({
      content: 'An error occurred while posting Star Wars news.',
      username: 'Star Wars News Bot',
      avatarURL: 'https://www.starwarsnewsnet.com/wp-content/uploads/2017/03/swnewsnet-logo-retina.png',
    });
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
