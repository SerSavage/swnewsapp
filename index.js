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

// Scrape Star Wars news with fallback logic
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
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-features=site-per-process'],
      });

      const page = await browser.newPage();

      // Set user agent to avoid bot detection
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');

      // Navigate with relaxed conditions
      await page.goto('https://www.starwarsnewsnet.com/category/star-wars', {
        waitUntil: 'domcontentloaded', // Load DOM only
        timeout: 60000, // 60s timeout
      });

      // Wait for any content (broad selector)
      const selector = '.td_module_1, article, .entry-title, div.post, h1, h2, h3';
      const contentFound = await page.waitForSelector(selector, { timeout: 20000 }).catch(() => null);

      if (!contentFound) {
        console.error('No content found with selector:', selector);
        const html = await page.content();
        await fs.writeFile('debug.html', html).catch(err => console.error('Failed to save debug HTML:', err));
        return [];
      }

      // Scrape articles with fallback
      const articles = await page.evaluate(() => {
        const newsItems = document.querySelectorAll('.td_module_1, article, div.post, [class*="post"], [class*="article"]');
        const results = [];

        newsItems.forEach((item) => {
          const titleElement = item.querySelector('.entry-title a, h1 a, h2 a, h3 a, a[href*="/202"]');
          const dateElement = item.querySelector('time, .td-post-date, [datetime]');
          const authorElement = item.querySelector('.td-post-author-name a, .author a, [class*="author"]');
          const categoriesElement = item.querySelector('.td-post-category, .category, [class*="category"]');
          const linkElement = item.querySelector('.entry-title a, h1 a, h2 a, h3 a, a[href*="/202"]');

          const title = titleElement ? titleElement.textContent.trim() : 'Untitled Article';
          if (title !== 'Untitled Article') {
            results.push({
              title,
              date: dateElement ? dateElement.getAttribute('datetime') || 'N/A' : 'N/A',
              author: authorElement ? authorElement.textContent.trim() : 'Unknown Author',
              categories: categoriesElement ? categoriesElement.textContent.trim().split(', ').filter(c => c) : ['Uncategorized'],
              link: linkElement ? linkElement.href : 'N/A',
            });
          }
        });

        return results.slice(0, 5); // Limit to 5 articles
      });

      console.log(`Scraped ${articles.length} articles`);
      return articles;

    } catch (error) {
      console.error(`Scraping attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) {
        console.error('Max retries reached.');
        if (browser) {
          const page = await browser.newPage();
          try {
            await page.goto('https://www.starwarsnewsnet.com/category/star-wars', { waitUntil: 'domcontentloaded', timeout: 60000 });
            const html = await page.content();
            await fs.writeFile('debug.html', html).catch(err => console.error('Failed to save debug HTML:', err));
            await page.close();
          } catch (e) {
            console.error('Failed to capture debug HTML:', e);
          }
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
        content: 'No new Star Wars news found or an error occurred. Check logs for details.',
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
                      `**Date**: ${article.date !== 'N/A' ? new Date(article.date).toLocaleDateString() : 'N/A'}\n` +
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
      content: `An error occurred while posting Star Wars news: ${error.message}`,
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
