const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const { WebhookClient } = require('discord.js');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 10000;

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const webhookClient = new WebhookClient({ url: WEBHOOK_URL });

const rssParser = new Parser();

const STARWARS_NEWS_URL = 'https://www.starwars.com/news';
const NITTER_RSS_URL = 'https://nitter.net/starwars/rss';
const POLL_INTERVAL = 300000; // Poll every 5 minutes

let lastNews = new Set();
let lastRss = new Set();

// Function to scrape Star Wars news
async function scrapeStarWarsNews() {
  try {
    const { data } = await axios.get(STARWARS_NEWS_URL);
    const $ = cheerio.load(data);
    const articles = [];

    $('.news-article').each((i, elem) => {
      const title = $(elem).find('.article-title').text().trim();
      const link = $(elem).find('a').attr('href');
      const date = $(elem).find('.article-date').text().trim();
      if (title && link) {
        articles.push({ title, link: `https://www.starwars.com${link}`, date });
      }
    });

    return articles;
  } catch (error) {
    console.error('Error scraping Star Wars news:', error.message);
    return [];
  }
}

// Function to parse Nitter RSS feed
async function fetchRssFeed() {
  try {
    const feed = await rssParser.parseURL(NITTER_RSS_URL);
    return feed.items.map(item => ({
      title: item.title,
      link: item.link,
      date: item.pubDate
    }));
  } catch (error) {
    console.error('Error fetching RSS feed:', error.message);
    return [];
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

  // Fetch RSS feed
  const rssItems = await fetchRssFeed();
  rssItems.forEach(item => {
    const key = `${item.title}-${item.date}`;
    if (!lastRss.has(key)) {
      lastRss.add(key);
      sendDiscordNotification(item.title, item.link, 'Nitter RSS');
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