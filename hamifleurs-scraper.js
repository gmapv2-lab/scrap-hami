const { google } = require("googleapis");
const path = require("path");

let puppeteer;

try {
  puppeteer = require("puppeteer-core");
} catch {
  puppeteer = require("puppeteer");
}

// ============================================================
// CONFIG
// ============================================================

// Can still be overridden by your existing GitHub secret LOGIN_URL
const LOGIN_URL =
  process.env.LOGIN_URL ||
  "https://app.oz-hami.nl/login";

const SHEET_NAME =
  process.env.SHEET_NAME ||
  "Hami-Products";

const CONFIG_SHEET = "_config";
const STATUS_CELL = "F9";

const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID;

const CREDENTIALS_PATH =
  process.env.CREDENTIALS_PATH ||
  "./service-account.json";

const EMAIL =
  process.env.HAMI_USERNAME;

const PASSWORD =
  process.env.HAMI_PASSWORD;

// ------------------------------------------------------------
// THESE COME FROM YOUR EXISTING GITHUB ACTION
// ------------------------------------------------------------
//
// PACKING_DATE:
// Example:
// 09/11/2026
//
// URLS:
// https://app.oz-hami.nl/assortment?mcid=1,
// https://app.oz-hami.nl/assortment?mcid=2
//
// ------------------------------------------------------------

const PACKING_DATE =
  (process.env.PACKING_DATE || "").trim();

const URLS =
  (process.env.URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

const PUPPETEER_EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/usr/bin/google-chrome";

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

function sanitize(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatRuntime(ms) {
  const totalSeconds =
    Math.floor(ms / 1000);

  const hours =
    Math.floor(
      totalSeconds / 3600
    );

  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60
    );

  const seconds =
    totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
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
//
// 09/11/2026
//
// which means:
//
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
      `Expected MM/DD/YYYY.`
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
    date.getUTCMonth() !==
      month - 1 ||
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
// CREATE TEXT USED BY NEW HAMI CALENDAR
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
    // Calendar:
    // Friday, 11, September

    optionText:
      `${weekday}, ${day}, ${monthLong}`,

    // Header:
    // Friday 11 Sep

    selectedText:
      `${weekday} ${day} ${monthShort}`,
  };
}

// ============================================================
// GOOGLE SHEETS AUTH
// ============================================================

async function getGoogleSheetClient() {
  if (!SPREADSHEET_ID) {
    throw new Error(
      "SPREADSHEET_ID missing."
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

  let statusText =
    timestamp;

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

  else if (
    status === "error"
  ) {
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
// CLEAR HAMI PRODUCTS + ADD HEADERS
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

  console.log(
    `🧹 Cleared ${SHEET_NAME}`
  );

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
    "✅ Headers written"
  );
}

// ============================================================
// APPEND PRODUCTS TO SHEET
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
// VUE INPUT HELPER
// ============================================================

async function setVueInput(
  page,
  selector,
  value
) {
  await page.$eval(
    selector,

    (
      element,
      newValue
    ) => {
      const descriptor =
        Object
          .getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
          );

      descriptor.set.call(
        element,
        newValue
      );

      element.dispatchEvent(
        new Event(
          "input",
          {
            bubbles: true,
          }
        )
      );

      element.dispatchEvent(
        new Event(
          "change",
          {
            bubbles: true,
          }
        )
      );

      element.dispatchEvent(
        new Event(
          "blur",
          {
            bubbles: true,
          }
        )
      );
    },

    value
  );
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

  // --------------------------------------------------------
  // WAIT FOR LOGIN FORM
  // --------------------------------------------------------

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

  // --------------------------------------------------------
  // TYPE USERNAME LIKE A REAL USER
  // --------------------------------------------------------

  await page.click(usernameSelector);

  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");

  await page.keyboard.press("Backspace");

  await page.type(
    usernameSelector,
    EMAIL,
    {
      delay: 40,
    }
  );

  // --------------------------------------------------------
  // TYPE PASSWORD LIKE A REAL USER
  // --------------------------------------------------------

  await page.click(passwordSelector);

  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");

  await page.keyboard.press("Backspace");

  await page.type(
    passwordSelector,
    PASSWORD,
    {
      delay: 40,
    }
  );

  // Give Vue time to update v-model
  await delay(500);

  // --------------------------------------------------------
  // VERIFY DOM INPUTS
  // --------------------------------------------------------

  const inputState =
    await page.evaluate(() => {
      const username =
        document.querySelector("#username");

      const password =
        document.querySelector("#password");

      const button =
        document.querySelector(
          'button[type="submit"][aria-label="Login"]'
        );

      return {
        usernameLength:
          username?.value?.length || 0,

        passwordLength:
          password?.value?.length || 0,

        buttonDisabled:
          Boolean(button?.disabled),
      };
    });

  console.log(
    `👤 Username chars: ${inputState.usernameLength}`
  );

  console.log(
    `🔑 Password chars: ${inputState.passwordLength}`
  );

  console.log(
    `🔘 Login disabled: ${inputState.buttonDisabled}`
  );

  if (
    inputState.usernameLength === 0 ||
    inputState.passwordLength === 0
  ) {
    throw new Error(
      "Username/password did not type into login form."
    );
  }

  // --------------------------------------------------------
  // CLICK LOGIN NORMALLY
  // --------------------------------------------------------

  console.log("➡️ Clicking Login...");

  await page.click(loginSelector);

  // --------------------------------------------------------
  // WAIT FOR LOGIN RESULT
  // --------------------------------------------------------

  const loggedIn =
    await page
      .waitForFunction(
        () =>
          !window.location.pathname.includes(
            "/login"
          ),
        {
          timeout: 30000,
        }
      )
      .then(() => true)
      .catch(() => false);

  if (!loggedIn) {
    // ------------------------------------------------------
    // GET ACTUAL ERROR FROM PAGE
    // ------------------------------------------------------

    const diagnostic =
      await page.evaluate(() => {
        const bodyText =
          document.body?.innerText || "";

        return bodyText
          .split(/\n+/)
          .map((text) =>
            text.trim()
          )
          .filter(Boolean)
          .filter((text) =>
            /required|invalid|incorrect|wrong|error|password|username|failed/i.test(
              text
            )
          )
          .slice(0, 15);
      });

    console.log(
      "🔎 Login diagnostic:"
    );

    diagnostic.forEach(
      (text) =>
        console.log(
          `   ${text}`
        )
    );

    throw new Error(
      "Hami login failed. Site stayed on /login."
    );
  }

  // --------------------------------------------------------
  // LOGIN SUCCESS
  // --------------------------------------------------------

  await delay(1200);

  console.log(
    `✅ Logged in successfully`
  );

  console.log(
    `🌐 Current URL: ${page.url()}`
  );
}
// ============================================================
// OPEN ASSORTMENT URL
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

  await delay(700);
}

// ============================================================
// SELECT SHIPPING DATE
// ============================================================

async function ensureShippingDate(
  page,
  packingDate
) {
  const labels =
    getShippingDateLabels(
      packingDate
    );

  // ----------------------------------------------------------
  // CURRENT DATE
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // OPEN SHIPPING DATE PANEL
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // READ ALL DATES
  // ----------------------------------------------------------

  const options =
    await page.$$eval(
      'button[data-testid="shipping-date-option"]',

      (buttons) =>
        buttons.map(
          (
            button,
            index
          ) => {
            const dateElement =
              button.querySelector(
                "span.date"
              );

            return {
              index,

              selected:
                button.getAttribute(
                  "data-selected"
                ) ===
                "true",

              date:
                (
                  dateElement
                    ?.textContent ||
                  ""
                )
                  .replace(
                    /\s+/g,
                    " "
                  )
                  .trim(),
            };
          }
        )
    );

  // ----------------------------------------------------------
  // FIND REQUESTED DATE
  // ----------------------------------------------------------

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

    for (
      const option of
        options
    ) {
      console.log(
        `   • ${option.date}`
      );
    }

    console.log(
      `⚠️ Date unavailable: ${labels.optionText}`
    );

    return false;
  }

  // ----------------------------------------------------------
  // CLICK DATE
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // VERIFY DATE CHANGED
  // ----------------------------------------------------------

  await page.waitForFunction(
    (expected) => {
      const element =
        document.querySelector(
          '[data-testid="selected-shipping-date-value"]'
        );

      if (!element) {
        return false;
      }

      const currentText =
        element
          .textContent
          .replace(
            /\s+/g,
            " "
          )
          .trim()
          .toLowerCase();

      return (
        currentText ===
        expected.toLowerCase()
      );
    },

    {
      timeout: 20000,
    },

    labels.selectedText
  );

  // Let product list refresh
  await delay(1800);

  console.log(
    `✅ Shipping date ready: ${labels.selectedText}`
  );

  return true;
}

// ============================================================
// SCRAPE PRODUCTS CURRENTLY MOUNTED IN DOM
// ============================================================

async function scrapeVisibleProducts(
  page
) {
  const scrapeTime =
    getUaeTimeFormatted();

  return page.evaluate(
    (time) => {
      // ======================================================
      // LOCAL CLEANER
      // ======================================================

      const clean =
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
      // REMOVE MINIMUM / MINIMAAL
      // ======================================================

      const removeMinimum =
        (value) =>
          clean(value)
            .replace(
              /^minimaal\s*:?\s*/i,
              ""
            )
            .replace(
              /^minimum\s*:?\s*/i,
              ""
            )
            .replace(
              /^min\.?\s*:?\s*/i,
              ""
            )
            .trim();

      // ======================================================
      // FIND FULL PRODUCT CARD
      // ======================================================

      function findCardRoot(
        titleElement
      ) {
        let current =
          titleElement;

        let level = 0;

        while (
          current &&
          current !==
            document.body &&
          level < 16
        ) {
          const hasImage =
            current.querySelector(
              "div.product-card--top > img"
            );

          const hasSpecifics =
            current.querySelector(
              "div.specifics"
            );

          if (
            hasImage &&
            hasSpecifics
          ) {
            return current;
          }

          current =
            current.parentElement;

          level++;
        }

        return null;
      }

      // ======================================================
      // ATTRIBUTES
      // ======================================================

      function scrapeAttributes(
        card
      ) {
        const attrs = {
          Length: "N/A",
          Diameter: "N/A",
          Quality: "N/A",
          Weight: "N/A",
          NoOfBuds: "N/A",
        };

        // Scope only to the characteristic list for this product card.
        const items = Array.from(
          card.querySelectorAll(
            "ul.characteristics > li[data-sequence]"
          )
        );

        for (const item of items) {
          let text = clean(item.textContent);

          if (!text) {
            continue;
          }

          const sequence =
            item.getAttribute("data-sequence");

          // ==================================================
          // SEQUENCE 1 = LENGTH
          //
          // Example:
          // 7 cm
          // 70 cm
          // ==================================================
          if (sequence === "1") {
            attrs.Length = text;
            continue;
          }

          // ==================================================
          // SEQUENCE 2 = VARIABLE ATTRIBUTE
          //
          // We DO NOT assume sequence 2 always means one field.
          // We classify it using the actual value.
          // ==================================================
          if (sequence === "2") {
            // ----------------------------------------------
            // NO OF BUDS
            //
            // 5+
            // 7+
            // 10+
            // ----------------------------------------------
            if (/^\d+\s*\+$/.test(text)) {
              attrs.NoOfBuds =
                text.replace(/\s+/g, "");

              continue;
            }

            // ----------------------------------------------
            // WEIGHT
            //
            // 55 gr
            // 75 gr
            // 1 kg
            // ----------------------------------------------
            if (
              /\b(gr|gram|grams|kg)\b/i.test(text)
            ) {
              attrs.Weight = text;
              continue;
            }

            // ----------------------------------------------
            // DIAMETER
            //
            // Minimaal 7 cm
            // Minimum 15 cm
            // Min. 10 cm
            // 7 cm
            //
            // Store only:
            // 7 cm
            // 15 cm
            // 10 cm
            // ----------------------------------------------
            if (
              /\b(cm|mm)\b/i.test(text)
            ) {
              text = text
                .replace(
                  /^minimaal\s*:?\s*/i,
                  ""
                )
                .replace(
                  /^minimum\s*:?\s*/i,
                  ""
                )
                .replace(
                  /^min\.?\s*:?\s*/i,
                  ""
                )
                .trim();

              attrs.Diameter = text;
              continue;
            }
          }

          // ==================================================
          // SEQUENCE 3 = QUALITY
          //
          // Example:
          // A1
          // ==================================================
          if (sequence === "3") {
            attrs.Quality = text;
            continue;
          }
        }

        return attrs;
      }

      // ======================================================
      // PRICE + PACKING OPTION
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
                // ------------------------------------------
                // Packing
                //
                // 1 x 50
                // 5 x 10
                // ------------------------------------------

                const packingText =
                  clean(
                    row
                      .querySelector(
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

                // ------------------------------------------
                // Price from SAME ROW
                // ------------------------------------------

                const priceText =
                  clean(
                    row
                      .querySelector(
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

            .filter(Boolean);

        // --------------------------------------------------
        // NO PACKING FOUND
        // --------------------------------------------------

        if (!options.length) {
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
        // OUR RULE
        //
        // 1 × 50
        // 5 × 10
        //
        // Select 5 × 10
        //
        // because 10 is smaller than 50.
        //
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
      // FIND PRODUCT TITLES
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
          clean(
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
          clean(
            card
              .querySelector(
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
        // SPECIFICS AREA
        // ==================================================

        const specifics =
          card.querySelector(
            "div.specifics"
          );

        // ==================================================
        // ORIGIN
        // ==================================================

        const origin =
          clean(
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
          clean(
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
          clean(
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
          clean(
            growerElement
              ?.getAttribute(
                "title"
              ) ||
            growerElement
              ?.textContent
          ) ||
          "N/A";

        // ==================================================
        // ATTRIBUTE PARSER
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
        // BUILD PRODUCT
        // ==================================================

        products.push({
          "Name":
            name,

          "Tag":
            tag,

          "Image URL":
            imageUrl,

          "Origin":
            origin,

          "Length":
            attrs.Length,

          "Diameter":
            attrs.Diameter,

          "Quality":
            attrs.Quality,

          "Weight":
            attrs.Weight,

          "No of Buds":
            attrs.NoOfBuds,

          "Takken":
            "N/A",

          "Certificate":
            "N/A",

          "Color":
            color,

          "Grower":
            grower,

          "Box Quantity":
            boxQuantity,

          "Stem Price":
            orderOption.stemPrice,

          "First Quantity":
            orderOption.firstQuantity,

          "Available Quantity":
            orderOption.availableQuantity,

          "ProductUrl":
            "N/A",

          "Time":
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
    product["Image URL"],
    product.Origin,
    product.Length,
    product.Diameter,
    product.Quality,
    product.Weight,
    product["No of Buds"],
    product.Color,
    product["Box Quantity"],
    product["Stem Price"],
    product["First Quantity"],
    product["Available Quantity"],
  ].join("|");
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

  // ----------------------------------------------------------
  // WAIT FOR FIRST PRODUCT
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // START FROM TOP
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // SCROLL LOOP
  // ----------------------------------------------------------

  for (
    let round = 1;
    round <=
      MAX_SCROLL_ROUNDS;
    round++
  ) {
    // --------------------------------------------------------
    // COLLECT CURRENT PRODUCTS
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // SCROLL DOWN
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // GET SCROLL POSITION
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // CHECK IF PRODUCT COUNT STOPPED
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // EXTRA WAIT AT BOTTOM
    // --------------------------------------------------------

    if (atBottom) {
      await delay(
        1400
      );

      // Product batch may have loaded
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

    // --------------------------------------------------------
    // STOP AFTER BOTTOM STAYS STABLE
    // --------------------------------------------------------

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

  // ----------------------------------------------------------
  // FINAL CAPTURE
  // ----------------------------------------------------------

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
    // CHECK DATE
    // ========================================================

    if (!PACKING_DATE) {
      throw new Error(
        "Missing PACKING_DATE from GitHub workflow."
      );
    }

    // Validate
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
    // CLEAR OLD PRODUCT DATA
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

    // Hide webdriver flag
    await page
      .evaluateOnNewDocument(
        () => {
          Object.defineProperty(
            navigator,
            "webdriver",
            {
              get: () =>
                false,
            }
          );
        }
      );

    // ========================================================
    // LOGIN ONLY ONCE
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
    // LOOP URLS SENT FROM APPS SCRIPT
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
      // SELECT DATE FROM _config!C9
      //
      // Apps Script already sends this to GitHub
      // as PACKING_DATE.
      // ======================================================

      const dateAvailable =
        await ensureShippingDate(
          page,
          PACKING_DATE
        );

      // If this URL has no requested shipping date,
      // skip it instead of stopping everything.

      if (!dateAvailable) {
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
      // DEDUPE
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
      // WRITE THIS URL
      // ======================================================

      if (
        newProducts.length >
        0
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

      // ======================================================
      // RESET SCROLL BEFORE NEXT URL
      // ======================================================

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
