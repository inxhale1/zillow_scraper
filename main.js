const ua = require('user-agents');
const puppeteer = require("puppeteer-extra")
const pluginStealth = require("puppeteer-extra-plugin-stealth")
const Promise = require('bluebird')
const { Pool } = require('pg')

puppeteer.use(pluginStealth());

const agent = new ua({deviceCategory: 'desktop'})

const cities = {
  NY: 'https://www.zillow.com/new-york-ny',
  LA: 'https://www.zillow.com/los-angeles-ca',
  WS: 'https://www.zillow.com/washington-dc'
}

const houses = {
  first: 'https://www.zillow.com/homedetails/924-Bel-Air-Rd-Los-Angeles-CA-90077/20529647_zpid/'
}

async function parseHouseUrls(browser, url, untilPage = 100) {

  const page = await browser.newPage()
  page.setUserAgent(agent.userAgent)
  page.setDefaultTimeout(60 * 1000)
  page.setViewport({
    width: agent.viewportWidth,
    height: agent.viewportHeight
  })

  await page.evaluateOnNewDocument((agent) => {
    Object.defineProperty(navigator, "connection", {
      get: function() {
        return agent.connection
      }
    });
  }, agent)


  await page.evaluateOnNewDocument((agent) => {
    Object.defineProperty(navigator, "platform", {
      get: function() {
        return agent.platform
      }
    });
  }, agent)

  let currentPageCount = 1

  async function collect (page) {
    await page.waitFor('#grid-search-results > ul');
    const urls = await page.$$('a.list-card-link.list-card-img');
    const result = Promise.map(urls, u => {
      try {
        return u.evaluate(a => a.href)
      } catch (err) {
        console.error(err)
        return false
      }
    }).filter(n => !!n); //remove falsy values

    nextPage = await page.$("a[aria-label='NEXT Page']");
    return result
  }

  await page.goto(url);
  await page.waitFor('#grid-search-results > ul');


  const block = await page.$("#search-page-list-container")
  await block.hover()
  await block.evaluate(async node => {

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    for (let i = 0; i < parseInt(node.scrollHeight / 335) - 6; i++) {
      node.scrollBy(0, 335)
      await sleep(1000)
    }
  })

  // the next button
  let nextPage = await page.$("a[aria-label='NEXT Page']");
  const urls = await collect(page)
  let result = [...urls]

  if (untilPage === currentPageCount) {
    return result
  }

  // go to next page and grab urls until last page
  while (nextPage) {
    await nextPage.click()
    currentPageCount++

    // loader spiner
    await page.waitFor('div.list-loading-message-cover')

    const block = await page.$("#search-page-list-container")
    await block.hover()
    await block.evaluate(async node => {

      function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }

      for (let i = 0; i < parseInt(node.scrollHeight / 335) - 6; i++) {
        node.scrollBy(0, 335)
        await sleep(1000)
      }
    })

    // some delays
    await Promise.delay(Math.random() * 100 * 50)

    const urls = await collect(page)
    result = [...urls, ...result]

    if (untilPage === currentPageCount) {
      nextPage = false
      break
    }

    //some delays again
    await Promise.delay(Math.random() * 100 * 50)
  }

  return result

}

async function parseHouseInfo(browser, houseUrl) {

  const page = await browser.newPage()
  page.setUserAgent(agent.userAgent)
  page.setDefaultTimeout(60 * 1000)
  page.setViewport({
    width: agent.viewportWidth,
    height: agent.viewportHeight
  })

  await page.evaluateOnNewDocument((agent) => {
    Object.defineProperty(navigator, "connection", {
      get: function() {
        return agent.connection
      }
    });
  }, agent)


  await page.evaluateOnNewDocument((agent) => {
    Object.defineProperty(navigator, "platform", {
      get: function() {
        return agent.platform
      }
    });
  }, agent)

  await page.goto(houseUrl)
  await page.waitFor('#ds-container > div.ds-data-col.ds-white-bg')

  // scroll photos to bottom because we want it all
  const photosBlock = await page.$("div.ds-container > div.ds-media-col")
  await photosBlock.hover()
  await photosBlock.evaluate(node => {
    node.scrollBy(0, node.scrollHeight)
  })

  const price = await page.$eval('h3.ds-price > span > span.ds-value', el => el.innerText)
  const status = await page.$eval('span.ds-status-details', el => el.innerText)
  const description = await page.$eval('.ds-overview-section > div > div', el => el.innerText)
  const photos = await page.$$eval('.ds-media-col > ul > li > picture > img', pictures => {
    const result = []
    for (i of pictures) {
      result.push(i.src)
    }
    return result
  })

  return {
    price,
    status,
    description,
    photos
  }

}

(async () => {

  const browser = await puppeteer.launch({
    // headless: false,
    slowMo: 300,
    defaultViewport: {
      width: 1024,
      height: 768
    },
    args: ['--lang=en-US']
  });

  const db = new Pool({
    user: 'postgres',
    password: 'postgres',
    database: 'postgres'
  })

  await db.query(`CREATE TABLE IF NOT EXISTS zillow_scraper (
    id serial,
    url text UNIQUE,
    photos text[],
    description text,
    price text,
    status text,
    processed bool
    )`)

  const urls = await parseHouseUrls(browser, cities.NY, 1)

  // store our links for future parse
  await Promise.map(urls, u => {
    const query = 'INSERT INTO zillow_scraper(url, processed) VALUES($1, $2) ON CONFLICT DO NOTHING'
    const values = [u, false]

    return db.query(query, values)
  })

  // find process = false entries and parse them

  const { rows } = await db.query('SELECT url FROM zillow_scraper WHERE processed=false')

  await Promise.map(rows, async r => {

    const info = await parseHouseInfo(browser, r.url)
    const text = `UPDATE zillow_scraper
          SET (photos, description, price, status, processed) = ($1, $2, $3, $4, $5)
          WHERE url = $6`
    const value = [info.photos, info.description, info.price, info.status, true, r.url]

    return db.query(text, value)
  }, {
    concurrency: 1
  })

})();