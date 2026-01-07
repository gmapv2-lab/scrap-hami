const puppeteer = require("puppeteer");
const { google } = require("googleapis");
const dayjs = require("dayjs");

// Constants
const LOGIN_URL = "https://www.hamifleurs.nl/hami/en/EUR/login";
const SHEET_NAME = "Hami-Products";
const CONFIG_SHEET = "_config";
const CONFIG_RANGE = "C9"; // Packing date cell
const STATUS_CELL = "F9"; // Status cell
const CREDENTIALS_PATH = "./service-account.json";
const SPREADSHEET_ID = "1zkZj6I-BMjYutnp2sLIg1GMB-9sNhdF4cV1YR51P1yg";
const EMAIL = process.env.HAMI_USERNAME || "hf470035";
const PASSWORD = process.env.HAMI_PASSWORD || "Dom@hami2024";

// Helpers
function sanitize(text) {
  return text?.replace(/\s+/g, " ").trim() || "";
}

function getUaeTimeFormatted() {
  return dayjs().add(4, "hour").format("DD/MM/YYYY HH:mm:ss");
}

// --- Format runtime (ms) as "42s" or "2m 13s" or "1h 5m 20s" ---
function formatRuntime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else if (seconds > 0) {
    return `${seconds}s`;
  } else {
    return `${ms}ms`;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Google Sheets Auth
async function getGoogleSheetClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// Update status in Google Sheet
async function updateStatus(sheets, status, startTime, errorMessage) {
  const runtime = formatRuntime(Date.now() - startTime);
  const timestamp = getUaeTimeFormatted();

  let statusText;

  switch (status) {
    case "running":
      statusText = `🟡 Scraping in progress...`;
      break;
    case "success":
      statusText = `✅ ${timestamp} — ${runtime}`;
      break;
    case "error":
      statusText = `❌ Failed ${timestamp} — ${runtime}${errorMessage ? ` - ${errorMessage}` : ""}`;
      break;
    case "no-products":
      statusText = `⚠️ No products found ${timestamp} — ${runtime}`;
      break;
    default:
      statusText = `${timestamp}`;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONFIG_SHEET}!${STATUS_CELL}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[statusText]] },
  });

  console.log(`📊 Status updated: ${statusText}`);
}

// Get packing date from Google Sheet
async function getPackingDate(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONFIG_SHEET}!${CONFIG_RANGE}`,
  });
  return res.data.values?.[0]?.[0] || dayjs().format("YYYY-MM-DD");
}

// Select packing date, check if disabled, handle popup safely
async function selectPackingDate(page, dateStr) {
  // Wait and click the date input
  await page.waitForSelector("input.js-show_date", { visible: true });
  await page.click("input.js-show_date");

  const formatted = dayjs(dateStr).format("MM/DD/YYYY");

  // Check if date is disabled
  const isDisabled = await page.$(`td.day.disabled[data-day="${formatted}"]`);
  if (isDisabled) {
    console.log(`⚠️ Date ${dateStr} is disabled → No products available.`);
    return false;
  }

  // Select active date
  const activeDate = await page.$(`td.day[data-day="${formatted}"]`);
  if (activeDate) {
    // Scroll into view and wait a bit
    await page.evaluate(
      (el) => el.scrollIntoView({ behavior: "auto", block: "center" }),
      activeDate
    );
    await delay(300);

    try {
      await activeDate.click({ delay: 100 });
      console.log(`📅 Selected active date: ${dateStr}`);
    } catch (err) {
      console.log(`❌ Failed to click active date: ${err.message}`);
      // fallback: click via JS
      await page.evaluate((el) => el.click(), activeDate);
      console.log(`✅ Clicked active date via JS fallback`);
    }
  } else {
    console.log(`⚠️ Date ${dateStr} not found in the calendar.`);
    return false;
  }

  // Close popup if it exists
  try {
    const datePopupClose = await page.waitForSelector("#cboxClose", {
      visible: true,
      timeout: 2000,
    });
    if (datePopupClose) {
      try {
        await datePopupClose.click();
        console.log("📦 Date popup closed.");
      } catch {
        // fallback click via JS
        await page.evaluate((el) => el.click(), datePopupClose);
        console.log("📦 Date popup closed via JS fallback.");
      }
      await delay(300); // ensure overlay disappears
    }
  } catch {
    console.log("ℹ️ No date popup to close.");
  }

  // Wait for products to load
  try {
    await page.waitForSelector("div.product-item", {
      visible: true,
      timeout: 10000,
    });
    console.log("✅ Products loaded for selected date.");
    return true;
  } catch {
    console.log(`⚠️ No products loaded after selecting ${dateStr}`);
    return false;
  }
}

// Scrape product attributes dynamically
async function scrapeProductAttributes(product) {
  const attrMap = {
    length_icon: "Length",
    diameter_icon: "Diameter",
    quality_icon: "Quality",
    weight_icon: "Weight",
    takken_icon: "Takken",
    certificate_icon: "Certificate",
  };

  const result = {};
  Object.values(attrMap).forEach((v) => (result[v] = "N/A"));

  const items = await product.$$eval(
    "ul.classification_attributes_first_row li",
    (lis) =>
      lis.map((li) => {
        const icon = li.querySelector("i")?.className || "";
        const value = li.querySelector("p")?.textContent.trim() || "N/A";
        return { icon, value };
      })
  );

  items.forEach((item) => {
    for (const key in attrMap) {
      if (item.icon.includes(key)) {
        result[attrMap[key]] = item.value;
      }
    }
  });

  return result;
}

// Scrape products on page
async function scrapeProducts(page) {
  await page.waitForSelector("div.product-item", { visible: true });
  const products = await page.$$("div.product-item");
  const time = getUaeTimeFormatted();
  const results = [];

  for (const product of products) {
    try {
      const name = await product
        .$eval("div.name_fav span a", (el) => el.textContent.trim())
        .catch(() => "N/A");
      const tag = await product
        .$eval("span.tag", (el) => el.textContent.trim())
        .catch(() => "N/A");
      const imgUrl = await product
        .$eval("div.thumnail_section img", (el) => el.src)
        .catch(() => "");
      const origin = await product
        .$eval("div.country_icon_outer > div.text", (el) =>
          el.textContent.trim()
        )
        .catch(() => "N/A");

      const attrs = await scrapeProductAttributes(product);

      const labelText = await product
        .$eval("div.classification_label_attributes", (el) => el.textContent)
        .catch(() => "");
      const growerMatch = labelText.match(/Grower:\s*([^\n\r]+)/i);
      const grower = growerMatch ? growerMatch[1].trim() : "N/A";

      const colorMatch = labelText.match(/Main Color:\s*([^\n\r]+)/i);
      const color = colorMatch ? colorMatch[1].trim() : "N/A";

      const BoxCode = await product
        .$eval("div.text-left span.packaging_unit_code", (el) =>
          el.textContent.trim().replace(/\(|\)/g, "")
        )
        .catch(() => "N/A");

      const stemPrice = await product
        .$eval(
          "div.third_quantity.tier_price.clear span.price_text",
          (el) => el.getAttribute("from-price")?.replace(",", ".") || "0"
        )
        .catch(() => "0");

      const first_quantity = await product
        .$eval(
          "span.pieces_unit",
          (el) => el.getAttribute("data-increment") || "0"
        )
        .catch(() => "0");

      const available_quantity_text = await product
        .$eval("div.first_quantity", (el) => el.textContent.trim())
        .catch(() => "N/A");

      const productUrl = await product
        .$eval("div.thumnail_section a.thumb", (el) => el.href)
        .catch(() => "N/A");

      results.push([
        sanitize(name),
        sanitize(tag),
        imgUrl,
        sanitize(origin),
        attrs.Length,
        attrs.Diameter,
        attrs.Quality,
        attrs.Weight,
        attrs.Takken,
        attrs.Certificate,
        color,
        grower,
        BoxCode,
        stemPrice,
        first_quantity,
        available_quantity_text,
        productUrl,
        time,
      ]);
    } catch (err) {
      console.log(`❌ Error scraping product: ${err.message}`);
    }
  }

  return results;
}

// Scrape products with pagination
async function scrapeProductsWithPagination(page) {
  const results = [];
  let currentPage = 1;

  while (true) {
    console.log(`🕵️‍♂️ Scraping page ${currentPage}...`);

    let productsOnPage = [];
    try {
      productsOnPage = await Promise.race([
        scrapeProducts(page),
        new Promise((resolve) => setTimeout(() => resolve([]), 15000)),
      ]);
    } catch (err) {
      console.log(`❌ Error scraping page ${currentPage}:`, err);
      break;
    }

    results.push(...productsOnPage);
    console.log(
      `✅ Found ${productsOnPage.length} products on page ${currentPage}. Total so far: ${results.length}`
    );

    const nextLi = await page.$("li.pagination-next");
    if (!nextLi) break;

    const nextLink = await nextLi.$("a[rel='next']");
    if (!nextLink) break;

    const isDisabled = await nextLi.evaluate(
      (li) => li.classList.contains("hidden") || li.classList.contains("disabled")
    );
    if (isDisabled) break;

    const nextHref = await nextLink.evaluate((a) => a.href);
    currentPage++;
    await page.goto(nextHref, { waitUntil: "networkidle2", timeout: 60000 });
    await delay(1500);
  }

  console.log(`ℹ️ Pagination complete. Total products scraped: ${results.length}`);
  return results;
}

// Main
(async () => {
  const startTime = Date.now(); // ⏱️ Start timer

  let browser = null;
  let sheets = null;
  let totalProductsScraped = 0;

  try {
    // Initialize Google Sheets client early for status updates
    sheets = await getGoogleSheetClient();

    // Update status to "Running"
    await updateStatus(sheets, "running", startTime);

    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() =>
      Object.defineProperty(navigator, "webdriver", { get: () => false })
    );

    console.log("🔐 Logging in...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await page.type("#j_username", EMAIL);
    await page.type("#j_password", PASSWORD);

    await Promise.all([
      page.click("button.primary_button"),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }).catch(() => {}),
    ]);
    console.log("✅ Logged in.");

    const packingDate = await getPackingDate(sheets);
    console.log("📅 Selected Packing Date:", packingDate);

    const urls = (process.env.URLS || "").split(",").map((u) => u.trim()).filter(Boolean);
    if (!urls.length) {
      console.log("⚠️ No URLs passed. Exiting.");
      await updateStatus(sheets, "error", startTime, "No URLs provided");
      await browser.close();
      return;
    }

    const headers = [
      "Name",
      "Tag",
      "Image URL",
      "Origin",
      "Length",
      "Diameter",
      "Quality",
      "Weight",
      "Takken",
      "Certificate",
      "Color",
      "Grower",
      "Box Quantity",
      "Stem Price",
      "First Quantity",
      "Available Quantity",
      "ProductUrl",
      "Time",
    ];

    // Clear the sheet first
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME,
    });
    console.log("🧹 Cleared old data from sheet");

    // Write headers as the first row
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });

    let isDateSelected = false; // Flag to select date only once

    for (const url of urls) {
      console.log(`➡️ Navigating to URL: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      // Close popup if exists
      try {
        const popupClose = await page.waitForSelector("#cboxClose", {
          visible: true,
          timeout: 5000,
        });
        if (popupClose) {
          await popupClose.click();
          console.log("📦 Popup closed.");
        }
      } catch {
        console.log("ℹ️ No popup to close.");
      }

      // Select packing date only for the first URL
      if (!isDateSelected) {
        const hasProducts = await selectPackingDate(page, packingDate);
        if (!hasProducts) {
          console.log(`⚠️ No products for the first URL: ${url}`);
          continue;
        }
        isDateSelected = true; // Mark date as selected
      }

      const data = await scrapeProductsWithPagination(page);
      console.log(`🧾 Writing ${data.length} products to Google Sheets...`);
      totalProductsScraped += data.length;

      if (data.length) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: SHEET_NAME,
          valueInputOption: "RAW",
          requestBody: { values: data },
        });
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: SHEET_NAME,
          valueInputOption: "RAW",
          requestBody: { values: [["No products found for this URL"]] },
        });
      }
    }

    console.log(`🎉 All URLs processed. Total products: ${totalProductsScraped}`);

    // Update status with success
    if (totalProductsScraped > 0) {
      await updateStatus(sheets, "success", startTime);
    } else {
      await updateStatus(sheets, "no-products", startTime);
    }

    console.log(`🏁 Scraping completed! Runtime: ${formatRuntime(Date.now() - startTime)}`);
  } catch (err) {
    console.error("❌ Scraping or writing failed:", err);

    // Update status with error
    if (sheets) {
      try {
        await updateStatus(sheets, "error", startTime, err.message?.substring(0, 50));
      } catch (updateErr) {
        console.error("❌ Failed to update error status:", updateErr);
      }
    }

    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 Browser closed.");
    }
  }
})();
