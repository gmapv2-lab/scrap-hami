const { google } = require("googleapis");

let puppeteer;

try {
  puppeteer = require("puppeteer-core");
} catch {
  puppeteer = require("puppeteer");
}

// ============================================================
// CONFIG
// ============================================================

const LOGIN_URL =
  process.env.LOGIN_URL ||
  "https://app.oz-hami.nl/login";

const SHEET_NAME =
  process.env.SHEET_NAME ||
  "Hami v2";

const CONFIG_SHEET = "_config";
const STATUS_CELL = "F9";

const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID;

const CREDENTIALS_PATH =
  process.env.CREDENTIALS_PATH ||
  process.env.CREDENTAILS_PATH ||
  "./service-account.json";

const EMAIL =
  process.env.HAMI_USERNAME || "";

const PASSWORD =
  process.env.HAMI_PASSWORD || "";

// Comes from your existing GitHub workflow input
const PACKING_DATE =
  (process.env.PACKING_DATE || "").trim();

// Comes from Apps Script → GitHub workflow
const URLS =
  (process.env.URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

const PUPPETEER_EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/usr/bin/google-chrome";

// Infinite scroll settings
const MAX_SCROLL_ROUNDS = 350;
const STABLE_BOTTOM_ROUNDS = 6;

// ============================================================
// OUTPUT COLUMNS
// ============================================================

const HEADERS = [
  "Name",
  "Tag",
  "Image URL",
  "Origin",
  "Length",
  "Diameter",
  "Quality",
  "Weight",
  "No of Buds",
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

// ============================================================
// HELPERS
// ============================================================

const delay = (ms) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatRuntime(ms) {
  const totalSeconds =
    Math.floor(ms / 1000);

  const hours =
    Math.floor(totalSeconds / 3600);

  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60
    );

  const seconds =
    totalSeconds % 60;

  if (hours) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

// ============================================================
// UAE TIME
// ============================================================

function getUaeTimeFormatted() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: "Asia/Dubai",

        day: "2-digit",
        month: "2-digit",
        year: "numeric",

        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",

        hour12: false,
      }
    ).formatToParts(
      new Date()
    );

  const map =
    Object.fromEntries(
      parts.map(
        (part) => [
          part.type,
          part.value,
        ]
      )
    );

  return (
    `${map.day}/${map.month}/${map.year} ` +
    `${map.hour}:${map.minute}:${map.second}`
  );
}

// ============================================================
// PACKING DATE
// ============================================================
//
// Apps Script sends:
// 09/11/2026
//
// Means:
// September 11 2026
//
// ============================================================

function parsePackingDate(value) {
  const match =
    String(value).match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
    );

  if (!match) {
    throw new Error(
      `Invalid PACKING_DATE "${value}". ` +
      `Expected MM/DD/YYYY, example 09/11/2026.`
    );
  }

  const month =
    Number(match[1]);

  const day =
    Number(match[2]);

  const year =
    Number(match[3]);

  const date =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day
      )
    );

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(
      `Invalid PACKING_DATE "${value}".`
    );
  }

  return {
    year,
    month,
    day,
    date,
  };
}

// ============================================================
// HAMI CALENDAR LABELS
// ============================================================

function getShippingDateLabels(
  packingDate
) {
  const {
    day,
    date,
  } =
    parsePackingDate(
      packingDate
    );

  const weekday =
    new Intl.DateTimeFormat(
      "en-US",
      {
        weekday: "long",
        timeZone: "UTC",
      }
    ).format(date);

  const monthLong =
    new Intl.DateTimeFormat(
      "en-US",
      {
        month: "long",
        timeZone: "UTC",
      }
    ).format(date);

  const monthShort =
    new Intl.DateTimeFormat(
      "en-US",
      {
        month: "short",
        timeZone: "UTC",
      }
    ).format(date);

  return {
    // Example:
    // Friday, 11, September

    optionText:
      `${weekday}, ${day}, ${monthLong}`,

    // Example:
    // Friday 11 Sep

    selectedText:
      `${weekday} ${day} ${monthShort}`,
  };
}

// ============================================================
// GOOGLE SHEETS
// ============================================================

async function getGoogleSheetClient() {
  if (!SPREADSHEET_ID) {
    throw new Error(
      "Missing SPREADSHEET_ID."
    );
  }

  const auth =
    new google.auth.GoogleAuth({
      keyFile:
        CREDENTIALS_PATH,

      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });

  const client =
    await auth.getClient();

  return google.sheets({
    version: "v4",
    auth: client,
  });
}

// ============================================================
// STATUS
// ============================================================

async function updateStatus(
  sheets,
  status,
  startTime,
  errorMessage = ""
) {
  const timestamp =
    getUaeTimeFormatted();

  const runtime =
    formatRuntime(
      Date.now() -
        startTime
    );

  let statusText;

  if (
    status === "running"
  ) {
    statusText =
      `🟡 Scraping in progress... ${timestamp}`;
  }

  else if (
    status === "success"
  ) {
    statusText =
      `✅ ${timestamp} — ${runtime}`;
  }

  else if (
    status === "no-products"
  ) {
    statusText =
      `⚠️ No products found ${timestamp} — ${runtime}`;
  }

  else {
    statusText =
      `❌ Failed ${timestamp} — ${runtime}`;

    if (errorMessage) {
      statusText +=
        ` - ${errorMessage}`;
    }
  }

  await sheets
    .spreadsheets
    .values
    .update({
      spreadsheetId:
        SPREADSHEET_ID,

      range:
        `${CONFIG_SHEET}!${STATUS_CELL}`,

      valueInputOption:
        "USER_ENTERED",

      requestBody: {
        values: [
          [statusText],
        ],
      },
    });

  console.log(
    `📊 ${statusText}`
  );
}

// ============================================================
// CLEAR PRODUCT SHEET
// ============================================================

async function prepareOutputSheet(
  sheets
) {
  await sheets
    .spreadsheets
    .values
    .clear({
      spreadsheetId:
        SPREADSHEET_ID,

      range:
        SHEET_NAME,
    });

  await sheets
    .spreadsheets
    .values
    .update({
      spreadsheetId:
        SPREADSHEET_ID,

      range:
        `${SHEET_NAME}!A1`,

      valueInputOption:
        "RAW",

      requestBody: {
        values: [
          HEADERS,
        ],
      },
    });

  console.log(
    `🧹 Cleared ${SHEET_NAME}`
  );

  console.log(
    "✅ Headers written"
  );
}

// ============================================================
// WRITE PRODUCTS
// ============================================================

async function appendProductsToSheet(
  sheets,
  products
) {
  if (!products.length) {
    return;
  }

  const rows =
    products.map(
      (product) =>
        HEADERS.map(
          (header) =>
            product[header] ??
            "N/A"
        )
    );

  const chunkSize =
    500;

  for (
    let i = 0;
    i < rows.length;
    i += chunkSize
  ) {
    const chunk =
      rows.slice(
        i,
        i + chunkSize
      );

    await sheets
      .spreadsheets
      .values
      .append({
        spreadsheetId:
          SPREADSHEET_ID,

        range:
          `${SHEET_NAME}!A:S`,

        valueInputOption:
          "RAW",

        insertDataOption:
          "INSERT_ROWS",

        requestBody: {
          values: chunk,
        },
      });
  }
}

// ============================================================
// LOGIN
// ============================================================

async function login(page) {
  console.log("🔐 Opening OZ-Hami login...");

  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const usernameSelector = "#username";
  const passwordSelector = "#password";
  const loginSelector =
    'button[type="submit"][aria-label="Login"]';

  await page.waitForSelector(usernameSelector, {
    visible: true,
    timeout: 30000,
  });

  await page.waitForSelector(passwordSelector, {
    visible: true,
    timeout: 30000,
  });

  await page.waitForSelector(loginSelector, {
    visible: true,
    timeout: 30000,
  });

  console.log("✅ Login form loaded");

  // =========================================================
  // CREATE CHROME DEVTOOLS SESSION
  // =========================================================

  const client =
    await page.target().createCDPSession();

  // =========================================================
  // REAL TEXT INPUT
  // =========================================================

  async function fillInput(selector, value) {
    const stringValue = String(value || "");

    if (!stringValue) {
      throw new Error(
        `Missing value for ${selector}`
      );
    }

    // Focus
    await page.focus(selector);

    // Clear existing content
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    await delay(150);

    // Type text through Chrome itself
    await client.send(
      "Input.insertText",
      {
        text: stringValue,
      }
    );

    await delay(350);

    return await page.$eval(
      selector,
      (el) => el.value?.length || 0
    );
  }

  // =========================================================
  // FILL BOTH FIELDS
  // =========================================================

  let usernameLength =
    await fillInput(
      usernameSelector,
      EMAIL
    );

  console.log(
    `👤 Username chars: ${usernameLength}`
  );

  let passwordLength =
    await fillInput(
      passwordSelector,
      PASSWORD
    );

  console.log(
    `🔑 Password chars: ${passwordLength}`
  );

  // =========================================================
  // VERIFY BOTH AFTER PASSWORD IS ENTERED
  // =========================================================

  let state =
    await page.evaluate(() => ({
      usernameLength:
        document.querySelector("#username")
          ?.value?.length || 0,

      passwordLength:
        document.querySelector("#password")
          ?.value?.length || 0,
    }));

  console.log(
    `👤 Final username chars: ${state.usernameLength}`
  );

  console.log(
    `🔑 Final password chars: ${state.passwordLength}`
  );

  // =========================================================
  // IF VUE RENDER CLEARED ONE FIELD, REFILL IT
  // =========================================================

  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {
    if (
      state.usernameLength > 0 &&
      state.passwordLength > 0
    ) {
      break;
    }

    console.log(
      `🔄 Stabilizing login fields - attempt ${attempt}`
    );

    if (
      state.usernameLength === 0
    ) {
      usernameLength =
        await fillInput(
          usernameSelector,
          EMAIL
        );
    }

    if (
      state.passwordLength === 0
    ) {
      passwordLength =
        await fillInput(
          passwordSelector,
          PASSWORD
        );
    }

    await delay(400);

    state =
      await page.evaluate(() => ({
        usernameLength:
          document.querySelector(
            "#username"
          )?.value?.length || 0,

        passwordLength:
          document.querySelector(
            "#password"
          )?.value?.length || 0,
      }));

    console.log(
      `   👤 Username: ${state.usernameLength}`
    );

    console.log(
      `   🔑 Password: ${state.passwordLength}`
    );
  }

  // =========================================================
  // FINAL VALIDATION
  // =========================================================

  if (
    state.usernameLength === 0 ||
    state.passwordLength === 0
  ) {
    throw new Error(
      "Could not keep both OZ-Hami login fields populated."
    );
  }

  console.log(
    "✅ Both login fields ready"
  );

  // =========================================================
  // CLICK LOGIN
  // =========================================================

  console.log(
    "➡️ Clicking Login..."
  );

  await page.click(
    loginSelector
  );

  // =========================================================
  // WAIT FOR SUCCESS
  // =========================================================

  let loggedIn =
    await page
      .waitForFunction(
        () =>
          !window.location.pathname.includes(
            "/login"
          ),
        {
          timeout: 25000,
        }
      )
      .then(() => true)
      .catch(() => false);

  // =========================================================
  // ENTER FALLBACK
  // =========================================================

  if (!loggedIn) {
    console.log(
      "ℹ️ No redirect yet. Trying Enter..."
    );

    await page.focus(
      passwordSelector
    );

    await page.keyboard.press(
      "Enter"
    );

    loggedIn =
      await page
        .waitForFunction(
          () =>
            !window.location.pathname.includes(
              "/login"
            ),
          {
            timeout: 20000,
          }
        )
        .then(() => true)
        .catch(() => false);
  }

  // =========================================================
  // FAILED
  // =========================================================

  if (!loggedIn) {
    const diagnostic =
      await page.evaluate(() => {
        const body =
          document.body?.innerText || "";

        return body
          .split(/\n+/)
          .map((x) => x.trim())
          .filter(Boolean)
          .filter((x) =>
            /required|invalid|incorrect|wrong|error|failed/i.test(
              x
            )
          )
          .slice(0, 10);
      });

    console.log(
      "🔎 Login diagnostic:"
    );

    diagnostic.forEach(
      (line) =>
        console.log(
          `   ${line}`
        )
    );

    throw new Error(
      "Hami login failed. Site stayed on /login."
    );
  }

  // =========================================================
  // SUCCESS
  // =========================================================

  await delay(1200);

  console.log(
    "✅ Logged in successfully"
  );

  console.log(
    `🌐 Current URL: ${page.url()}`
  );

  await client.detach()
    .catch(() => {});
}
// ============================================================
// OPEN ASSORTMENT
// ============================================================

async function openAssortment(
  page,
  url
) {
  console.log(
    `➡️ Opening: ${url}`
  );

  await page.goto(
    url,
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60000,
    }
  );

  await page.waitForSelector(
    '[data-testid="selected-shipping-date"]',

    {
      visible: true,
      timeout: 30000,
    }
  );

  await delay(
    700
  );
}

// ============================================================
// SHIPPING DATE
// ============================================================

async function ensureShippingDate(
  page,
  packingDate
) {
  const labels =
    getShippingDateLabels(
      packingDate
    );

  const current =
    await page
      .$eval(
        '[data-testid="selected-shipping-date-value"]',

        (element) =>
          element
            .textContent
            .replace(
              /\s+/g,
              " "
            )
            .trim()
      )

      .catch(
        () => ""
      );

  // Already selected
  if (
    current.toLowerCase() ===
    labels.selectedText.toLowerCase()
  ) {
    console.log(
      `📅 Shipping date already selected: ${current}`
    );

    return true;
  }

  console.log(
    `📅 Selecting shipping date: ${labels.optionText}`
  );

  // Open calendar
  await page.$eval(
    '[data-testid="selected-shipping-date"]',

    (element) =>
      element.click()
  );

  await page.waitForSelector(
    'button[data-testid="shipping-date-option"]',

    {
      visible: true,
      timeout: 10000,
    }
  );

  // Read dates
  const options =
    await page.$$eval(
      'button[data-testid="shipping-date-option"]',

      (buttons) =>
        buttons.map(
          (
            button,
            index
          ) => ({
            index,

            selected:
              button.getAttribute(
                "data-selected"
              ) === "true",

            date:
              (
                button.querySelector(
                  "span.date"
                )
                  ?.textContent ||
                ""
              )
                .replace(
                  /\s+/g,
                  " "
                )
                .trim(),
          })
        )
    );

  // Find requested date
  const matchingDate =
    options.find(
      (item) =>
        item.date.toLowerCase() ===
        labels.optionText.toLowerCase()
    );

  if (!matchingDate) {
    console.log(
      "📆 Available shipping dates:"
    );

    options.forEach(
      (item) =>
        console.log(
          `   • ${item.date}`
        )
    );

    console.log(
      `⚠️ Date unavailable: ${labels.optionText}`
    );

    return false;
  }

  if (
    !matchingDate.selected
  ) {
    const buttons =
      await page.$$(
        'button[data-testid="shipping-date-option"]'
      );

    await buttons[
      matchingDate.index
    ].click();
  }

  // Verify selected date
  await page.waitForFunction(
    (expected) => {
      const element =
        document.querySelector(
          '[data-testid="selected-shipping-date-value"]'
        );

      if (!element) {
        return false;
      }

      const text =
        element
          .textContent
          .replace(
            /\s+/g,
            " "
          )
          .trim()
          .toLowerCase();

      return (
        text ===
        expected.toLowerCase()
      );
    },

    {
      timeout:
        20000,
    },

    labels.selectedText
  );

  // Wait products refresh
  await delay(
    1800
  );

  console.log(
    `✅ Shipping date ready: ${labels.selectedText}`
  );

  return true;
}

// ============================================================
// SCRAPE CURRENT PRODUCTS
// ============================================================

async function scrapeVisibleProducts(
  page
) {
  const scrapeTime =
    getUaeTimeFormatted();

  return page.evaluate(
    (time) => {
      const cleanText =
        (value) =>
          String(
            value ?? ""
          )
            .replace(
              /\s+/g,
              " "
            )
            .trim();

      // ======================================================
      // FIND PRODUCT CARD ROOT
      // ======================================================

      function findCardRoot(titleElement) {
        let current = titleElement;
        let fallback = null;
        let level = 0;

        while (
          current &&
          current !== document.body &&
          level < 20
        ) {
          const hasImage =
            current.querySelector(
              "div.product-card--top > img"
            );

          const hasSpecifics =
            current.querySelector(
              "div.specifics"
            );

          const hasCharacteristics =
            current.querySelector(
              "ul.characteristics"
            );

          const hasOrderOptions =
            current.querySelector(
              "div.product-order-row"
            );

          // Keep a fallback for products that genuinely
          // do not have characteristics/order rows.
          if (
            hasImage &&
            hasSpecifics
          ) {
            fallback = current;
          }

          // Prefer the full product card containing
          // image + specifics + characteristics + order options.
          if (
            hasImage &&
            hasSpecifics &&
            hasCharacteristics &&
            hasOrderOptions
          ) {
            return current;
          }

          current = current.parentElement;
          level++;
        }

        return fallback;
      }

      // ======================================================
      // PRODUCT ATTRIBUTES
      // ======================================================
      //
      // Rule (per site behaviour):
      //   data-sequence="1"  -> always Length (ends in cm/mm)
      //   data-sequence="3"  -> always Quality
      //   everything else    -> Diameter / Weight / No of Buds,
      //                         disambiguated by content:
      //                           "5+"        -> No of Buds
      //                           "55 gr/kg"  -> Weight
      //                           "Minimaal.. cm/mm" -> Diameter
      //
      // Scoped to the FIRST ul.characteristics found inside the
      // card (and its direct <li> children only) so that cards
      // with more than one characteristics block, or stray
      // matches elsewhere in the DOM, can't bleed values into
      // each other.
      // ======================================================

 function scrapeAttributes(card) {
  const attrs = {
    Length: "N/A",
    Diameter: "N/A",
    Quality: "N/A",
    Weight: "N/A",
    NoOfBuds: "N/A",
  };

  const items = Array.from(
    card.querySelectorAll(
      "ul.characteristics li[data-sequence]"
    )
  );

  for (const item of items) {
    let text = String(item.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    const sequence = item.getAttribute("data-sequence");

    // ==========================================
    // SEQUENCE 1 = LENGTH
    // ==========================================
    if (sequence === "1") {
      attrs.Length = text;
      continue;
    }

    // ==========================================
    // SEQUENCE 2 = VARIABLE
    // Weight / Diameter / No of Buds
    // ==========================================
    if (sequence === "2") {
      const lower = text.toLowerCase();

      // Weight
      if (
        lower.endsWith(" gr") ||
        lower.endsWith("gr") ||
        lower.endsWith(" kg") ||
        lower.endsWith("kg")
      ) {
        attrs.Weight = text;
        continue;
      }

      // Diameter
      if (
        lower.endsWith(" cm") ||
        lower.endsWith("cm") ||
        lower.endsWith(" mm") ||
        lower.endsWith("mm") ||
        lower.includes("minimaal") ||
        lower.includes("minimum") ||
        lower.startsWith("min.")
      ) {
        attrs.Diameter = text
          .replace(/^minimaal\s*:?\s*/i, "")
          .replace(/^minimum\s*:?\s*/i, "")
          .replace(/^min\.?\s*:?\s*/i, "")
          .trim();

        continue;
      }

      // No of Buds
      // 5+ , 7+ , or any other unknown value
      attrs.NoOfBuds = text;
      continue;
    }

    // ==========================================
    // SEQUENCE 3 = QUALITY
    // ==========================================
    if (sequence === "3") {
      attrs.Quality = text;
      continue;
    }
  }

  return attrs;
}
      // ======================================================
      // PACKING / PRICE
      // ======================================================

      function getBestOrderOption(
        card
      ) {
        const rows =
          Array.from(
            card.querySelectorAll(
              "div.product-order-row"
            )
          );

        const options =
          rows
            .map(
              (row) => {
                const packingText =
                  cleanText(
                    row.querySelector(
                      "span.available"
                    )
                      ?.textContent ||
                    ""
                  );

                const match =
                  packingText.match(
                    /(\d+)\s*[x×]\s*(\d+)/i
                  );

                if (!match) {
                  return null;
                }

                const outerQuantity =
                  Number(
                    match[1]
                  );

                const innerQuantity =
                  Number(
                    match[2]
                  );

                // Price from the SAME ROW
                const priceText =
                  cleanText(
                    row.querySelector(
                      'button[data-testid="quantity-with-input--order-button"]'
                    )
                      ?.textContent ||
                    ""
                  );

                const normalizedPrice =
                  priceText
                    .replace(
                      /€/g,
                      ""
                    )

                    .replace(
                      /\s+/g,
                      ""
                    )

                    .replace(
                      ",",
                      "."
                    );

                const numericPrice =
                  Number.parseFloat(
                    normalizedPrice
                  );

                return {
                  outerQuantity,

                  innerQuantity,

                  availableQuantity:
                    `${outerQuantity} × ${innerQuantity}`,

                  stemPrice:
                    Number.isFinite(
                      numericPrice
                    )
                      ? numericPrice
                      : 0,
                };
              }
            )

            .filter(
              Boolean
            );

        if (
          !options.length
        ) {
          return {
            firstQuantity:
              "N/A",

            availableQuantity:
              "N/A",

            stemPrice:
              0,
          };
        }

        // ==================================================
        // OUR PACKING RULE
        //
        // 1 × 50
        // 5 × 10
        //
        // Select 5 × 10 because
        // second number 10 is smaller.
        // ==================================================

        options.sort(
          (
            a,
            b
          ) => {
            if (
              a.innerQuantity !==
              b.innerQuantity
            ) {
              return (
                a.innerQuantity -
                b.innerQuantity
              );
            }

            return (
              a.outerQuantity -
              b.outerQuantity
            );
          }
        );

        const selected =
          options[0];

        return {
          firstQuantity:
            selected.innerQuantity,

          availableQuantity:
            selected.availableQuantity,

          stemPrice:
            selected.stemPrice,
        };
      }

      // ======================================================
      // FIND PRODUCTS
      // ======================================================

      const titleElements =
        Array.from(
          document.querySelectorAll(
            "div.title h4.title-xl-bold"
          )
        );

      const products =
        [];

      const seenCards =
        new Set();

      for (
        const titleElement of
          titleElements
      ) {
        const card =
          findCardRoot(
            titleElement
          );

        if (!card) {
          continue;
        }

        if (
          seenCards.has(
            card
          )
        ) {
          continue;
        }

        seenCards.add(
          card
        );

        // ==================================================
        // NAME
        // ==================================================

        const name =
          cleanText(
            titleElement.getAttribute(
              "title"
            ) ||
            titleElement.textContent
          ) ||
          "N/A";

        // ==================================================
        // TAG
        // ==================================================

        const tag =
          cleanText(
            card.querySelector(
              "div.product-card--meta span.pieces.title-m"
            )
              ?.textContent
          ) ||
          "N/A";

        // ==================================================
        // IMAGE
        // ==================================================

        const imageElement =
          card.querySelector(
            "div.product-card--top > img"
          );

        const imageUrl =
          imageElement
            ?.currentSrc ||

          imageElement
            ?.src ||

          imageElement
            ?.getAttribute(
              "src"
            ) ||

          "";

        // ==================================================
        // SPECIFICS
        // ==================================================

        const specifics =
          card.querySelector(
            "div.specifics"
          );

        // ==================================================
        // ORIGIN
        // ==================================================

        const origin =
          cleanText(
            specifics
              ?.querySelector(
                "div.country"
              )
              ?.textContent
          ) ||
          "N/A";

        // ==================================================
        // COLOR
        // ==================================================

        const color =
          cleanText(
            specifics
              ?.querySelector(
                "span.color"
              )
              ?.textContent
          ) ||
          "N/A";

        // ==================================================
        // BOX QUANTITY
        // ==================================================

        const boxQuantity =
          cleanText(
            specifics
              ?.querySelector(
                "span.container"
              )
              ?.textContent
          ) ||
          "N/A";

        // ==================================================
        // GROWER
        // ==================================================

        const growerElement =
          card.querySelector(
            "span.grower"
          );

        const grower =
          cleanText(
            growerElement
              ?.getAttribute(
                "title"
              ) ||

            growerElement
              ?.textContent
          ) ||
          "N/A";

        // ==================================================
        // ATTRIBUTES
        // ==================================================

        const attrs =
          scrapeAttributes(
            card
          );

        // ==================================================
        // PACKING + PRICE
        // ==================================================

        const orderOption =
          getBestOrderOption(
            card
          );

        // ==================================================
        // DEBUG — log cards where nothing matched, so
        // unexpected markup shapes are visible in the
        // GitHub Actions log instead of silently becoming
        // "N/A" rows.
        // ==================================================

        if (
          attrs.Length === "N/A" &&
          attrs.Diameter === "N/A" &&
          attrs.Weight === "N/A" &&
          attrs.NoOfBuds === "N/A"
        ) {
          const charList =
            card.querySelector(
              "ul.characteristics"
            );

          console.log(
            `⚠️ No attrs matched for "${name}". Raw list HTML: ` +
              (charList
                ? charList.outerHTML.slice(0, 400)
                : "no ul.characteristics found")
          );
        }

        // ==================================================
        // RESULT
        // ==================================================

        products.push({
          Name:
            name,

          Tag:
            tag,

          "Image URL":
            imageUrl,

          Origin:
            origin,

          Length:
            attrs.Length,

          Diameter:
            attrs.Diameter,

          Quality:
            attrs.Quality,

          Weight:
            attrs.Weight,

          "No of Buds":
            attrs.NoOfBuds,

          Takken:
            "N/A",

          Certificate:
            "N/A",

          Color:
            color,

          Grower:
            grower,

          "Box Quantity":
            boxQuantity,

          "Stem Price":
            orderOption.stemPrice,

          "First Quantity":
            orderOption.firstQuantity,

          "Available Quantity":
            orderOption.availableQuantity,

          ProductUrl:
            "N/A",

          Time:
            time,
        });
      }

      return products;
    },

    scrapeTime
  );
}

// ============================================================
// PRODUCT UNIQUE KEY
// ============================================================

function getProductKey(
  product
) {
  return [
    product.Name,

    product.Grower,

    product[
      "Image URL"
    ],

    product.Origin,

    product.Length,

    product.Diameter,

    product.Quality,

    product.Weight,

    product[
      "No of Buds"
    ],

    product.Color,

    product[
      "Box Quantity"
    ],

    product[
      "Stem Price"
    ],

    product[
      "First Quantity"
    ],

    product[
      "Available Quantity"
    ],
  ].join(
    "|"
  );
}

// ============================================================
// INFINITE SCROLL
// ============================================================

async function collectAllProductsFromCurrentUrl(
  page
) {
  const products =
    new Map();

  let stableBottomRounds =
    0;

  let lastCount =
    0;

  // ==========================================================
  // WAIT FOR FIRST PRODUCT
  // ==========================================================

  const productFound =
    await page
      .waitForSelector(
        "div.title h4.title-xl-bold",

        {
          visible: true,
          timeout: 25000,
        }
      )

      .then(
        () => true
      )

      .catch(
        () => false
      );

  if (!productFound) {
    console.log(
      "⚠️ No products found on this URL."
    );

    return [];
  }

  // Go top
  await page.evaluate(
    () =>
      window.scrollTo(
        0,
        0
      )
  );

  await delay(
    700
  );

  console.log(
    "🕵️ Starting infinite scroll..."
  );

  // ==========================================================
  // SCROLL LOOP
  // ==========================================================

  for (
    let round = 1;
    round <=
      MAX_SCROLL_ROUNDS;
    round++
  ) {
    // Give Vue/Nuxt time to finish rendering product characteristics.
    await delay(600);

    // Capture currently mounted products
    const visibleProducts =
      await scrapeVisibleProducts(
        page
      );

    for (
      const product of
        visibleProducts
    ) {
      products.set(
        getProductKey(
          product
        ),

        product
      );
    }

    // Scroll
    await page.evaluate(
      () => {
        const root =
          document.scrollingElement ||
          document.documentElement;

        const amount =
          Math.max(
            Math.floor(
              window.innerHeight *
                0.85
            ),

            650
          );

        root.scrollBy(
          0,
          amount
        );
      }
    );

    await delay(
      900
    );

    // Get current scroll state
    const state =
      await page.evaluate(
        () => {
          const root =
            document.scrollingElement ||
            document.documentElement;

          return {
            top:
              root.scrollTop,

            max:
              Math.max(
                0,

                root.scrollHeight -
                  root.clientHeight
              ),
          };
        }
      );

    const atBottom =
      state.top >=
      state.max - 20;

    const currentCount =
      products.size;

    if (
      atBottom &&
      currentCount ===
        lastCount
    ) {
      stableBottomRounds++;
    } else {
      stableBottomRounds =
        0;
    }

    console.log(
      `   ↳ Scroll ${round}: ` +
      `${currentCount} products | ` +
      `bottom=${atBottom} | ` +
      `stable=${stableBottomRounds}/${STABLE_BOTTOM_ROUNDS}`
    );

    lastCount =
      currentCount;

    // ========================================================
    // EXTRA WAIT AT BOTTOM
    // ========================================================

    if (atBottom) {
      await delay(
        1400
      );

      const afterWaitProducts =
        await scrapeVisibleProducts(
          page
        );

      for (
        const product of
          afterWaitProducts
      ) {
        products.set(
          getProductKey(
            product
          ),

          product
        );
      }

      if (
        products.size >
        currentCount
      ) {
        stableBottomRounds =
          0;

        lastCount =
          products.size;

        console.log(
          `   🌷 New batch loaded → ${products.size}`
        );
      }
    }

    // Stop after bottom stays stable
    if (
      atBottom &&
      stableBottomRounds >=
        STABLE_BOTTOM_ROUNDS
    ) {
      console.log(
        "🏁 Bottom stable. No more products."
      );

      break;
    }
  }

  // Final capture
  const finalProducts =
    await scrapeVisibleProducts(
      page
    );

  for (
    const product of
      finalProducts
  ) {
    products.set(
      getProductKey(
        product
      ),

      product
    );
  }

  console.log(
    `✅ Infinite scroll finished: ${products.size} products`
  );

  return Array.from(
    products.values()
  );
}

// ============================================================
// MAIN
// ============================================================

(async () => {
  const startTime =
    Date.now();

  let browser =
    null;

  let sheets =
    null;

  let totalProductsScraped =
    0;

  try {
    // ========================================================
    // CHECK LOGIN
    // ========================================================

    if (
      !EMAIL ||
      !PASSWORD
    ) {
      throw new Error(
        "Missing HAMI_USERNAME or HAMI_PASSWORD."
      );
    }

    // ========================================================
    // CHECK PACKING DATE
    // ========================================================

    if (!PACKING_DATE) {
      throw new Error(
        "Missing PACKING_DATE from GitHub workflow."
      );
    }

    parsePackingDate(
      PACKING_DATE
    );

    // ========================================================
    // CHECK URLS
    // ========================================================

    if (!URLS.length) {
      throw new Error(
        "No URLs received from GitHub workflow."
      );
    }

    console.log(
      "========================================"
    );

    console.log(
      "🌸 NEW OZ-HAMI SCRAPER"
    );

    console.log(
      "========================================"
    );

    console.log(
      `📅 Packing Date: ${PACKING_DATE}`
    );

    console.log(
      `🔗 URLs Received: ${URLS.length}`
    );

    URLS.forEach(
      (
        url,
        index
      ) => {
        console.log(
          `   ${index + 1}. ${url}`
        );
      }
    );

    // ========================================================
    // GOOGLE SHEETS
    // ========================================================

    sheets =
      await getGoogleSheetClient();

    await updateStatus(
      sheets,
      "running",
      startTime
    );

    // ========================================================
    // CLEAR OLD PRODUCTS
    // ========================================================

    await prepareOutputSheet(
      sheets
    );

    // ========================================================
    // LAUNCH CHROME
    // ========================================================

    browser =
      await puppeteer.launch({
        headless: true,

        executablePath:
          PUPPETEER_EXECUTABLE_PATH,

        args: [
          "--no-sandbox",

          "--disable-setuid-sandbox",

          "--disable-dev-shm-usage",

          "--disable-gpu",

          "--window-size=1440,1000",
        ],
      });

    const page =
      await browser.newPage();

    page.setDefaultTimeout(
      30000
    );

    await page.setViewport({
      width: 1440,
      height: 1000,
    });

    // Hide webdriver
    await page.evaluateOnNewDocument(
      () => {
        Object.defineProperty(
          navigator,
          "webdriver",

          {
            get:
              () => false,
          }
        );
      }
    );

    // ========================================================
    // LOGIN ONCE
    // ========================================================

    await login(
      page
    );

    // ========================================================
    // GLOBAL DEDUPE
    // ========================================================

    const globalSeenProducts =
      new Set();

    // ========================================================
    // LOOP URLS
    // ========================================================

    for (
      let index = 0;
      index < URLS.length;
      index++
    ) {
      const url =
        URLS[index];

      console.log(
        "\n========================================"
      );

      console.log(
        `🌸 URL ${index + 1}/${URLS.length}`
      );

      console.log(
        `➡️ ${url}`
      );

      console.log(
        "========================================"
      );

      // ======================================================
      // OPEN CATEGORY
      // ======================================================

      await openAssortment(
        page,
        url
      );

      // ======================================================
      // SHIPPING DATE
      // ======================================================

      const dateAvailable =
        await ensureShippingDate(
          page,
          PACKING_DATE
        );

      if (
        !dateAvailable
      ) {
        console.log(
          `⚠️ Skipping URL because ${PACKING_DATE} is unavailable.`
        );

        continue;
      }

      // ======================================================
      // INFINITE SCROLL + SCRAPE
      // ======================================================

      const products =
        await collectAllProductsFromCurrentUrl(
          page
        );

      // ======================================================
      // REMOVE DUPLICATES
      // ======================================================

      const newProducts =
        [];

      for (
        const product of
          products
      ) {
        const key =
          getProductKey(
            product
          );

        if (
          globalSeenProducts.has(
            key
          )
        ) {
          continue;
        }

        globalSeenProducts.add(
          key
        );

        newProducts.push(
          product
        );
      }

      // ======================================================
      // WRITE GOOGLE SHEET
      // ======================================================

      if (
        newProducts.length
      ) {
        await appendProductsToSheet(
          sheets,
          newProducts
        );

        totalProductsScraped +=
          newProducts.length;
      }

      console.log(
        `🌷 Products found: ${products.length}`
      );

      console.log(
        `📝 New rows written: ${newProducts.length}`
      );

      console.log(
        `📊 Total rows: ${totalProductsScraped}`
      );

      // Reset scroll
      await page
        .evaluate(
          () =>
            window.scrollTo(
              0,
              0
            )
        )

        .catch(
          () => {}
        );

      await delay(
        600
      );
    }

    // ========================================================
    // FINAL STATUS
    // ========================================================

    if (
      totalProductsScraped >
      0
    ) {
      await updateStatus(
        sheets,
        "success",
        startTime
      );
    } else {
      await updateStatus(
        sheets,
        "no-products",
        startTime
      );
    }

    console.log(
      "\n========================================"
    );

    console.log(
      "🎉 HAMI SCRAPING COMPLETE"
    );

    console.log(
      `🌷 Total products: ${totalProductsScraped}`
    );

    console.log(
      `🏁 Runtime: ${formatRuntime(
        Date.now() -
          startTime
      )}`
    );

    console.log(
      "========================================"
    );
  }

  catch (error) {
    console.error(
      "\n❌ SCRAPER FAILED:"
    );

    console.error(
      error
    );

    if (sheets) {
      try {
        await updateStatus(
          sheets,
          "error",
          startTime,

          String(
            error.message ||
              error
          ).substring(
            0,
            100
          )
        );
      }

      catch (
        statusError
      ) {
        console.error(
          "❌ Failed updating status:",
          statusError.message
        );
      }
    }

    process.exitCode =
      1;
  }

  finally {
    if (browser) {
      await browser
        .close()
        .catch(
          () => {}
        );

      console.log(
        "🔒 Browser closed."
      );
    }
  }
})();
