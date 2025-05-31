const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

async function scrapeStarWarsNews() {
  try {
    // Launch browser
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    // Navigate to the Star Wars news category page
    await page.goto('https://www.starwarsnewsnet.com/category/star-wars', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for the news articles to load
    await page.waitForSelector('.td_module_1', { timeout: 10000 });

    // Scrape the latest news articles
    const articles = await page.evaluate(() => {
      const newsItems = document.querySelectorAll('.td_module_1');
      const results = [];

      newsItems.forEach((item) => {
        const titleElement = item.querySelector('.entry-title a');
        const dateElement = item.querySelector('.td-post-date time');
        const authorElement = item.querySelector('.td-post-author-name a');
        const categoriesElement = item.querySelector('.td-post-category');
        const linkElement = item.querySelector('.entry-title a');

        const article = {
          title: titleElement ? titleElement.textContent.trim() : 'N/A',
          date: dateElement ? dateElement.getAttribute('datetime') : 'N/A',
          author: authorElement ? authorElement.textContent.trim() : 'N/A',
          categories: categoriesElement ? categoriesElement.textContent.trim().split(', ') : [],
          link: linkElement ? linkElement.href : 'N/A',
        };

        results.push(article);
      });

      return results;
    });

    // Close the browser
    await browser.close();

    // Format the output for Discord
    const formattedOutput = articles
      .map((article, index) => {
        return `**Article ${index + 1}**\n` +
               `**Title**: ${article.title}\n` +
               `**Date**: ${new Date(article.date).toLocaleDateString()}\n` +
               `**Author**: ${article.author}\n` +
               `**Categories**: ${article.categories.join(', ')}\n` +
               `**Link**: ${article.link}\n`;
      })
      .join('\n');

    return formattedOutput || 'No articles found.';

  } catch (error) {
    console.error('Error during scraping:', error);
    return 'An error occurred while scraping the website.';
  }
}

// Example usage for Discord bot
module.exports = {
  name: 'starwarsnews',
  description: 'Fetches the latest Star Wars news',
  async execute(message) {
    const news = await scrapeStarWarsNews();
    message.channel.send(news);
  },
};
