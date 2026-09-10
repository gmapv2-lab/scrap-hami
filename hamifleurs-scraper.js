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
  // ROBUST INPUT FILLER FOR GITHUB HEADLESS CHROME
  // =========================================================

  async function fillInput(selector, value) {
    if (!value) {
      throw new Error(`No value supplied for ${selector}`);
    }

    // Click/focus actual input
    await page.click(selector);

    // Clear anything currently there
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    // insertText is safer than page.type for passwords
    // containing symbols/special characters
    await page.keyboard.insertText(String(value));

    await delay(300);

    let currentLength = await page.$eval(
      selector,
      (el) => el.value?.length || 0
    );

    // ---------------------------------------------------------
    // Fallback: native input setter + real InputEvent
    // ---------------------------------------------------------

    if (currentLength === 0) {
      console.log(
        `ℹ️ ${selector} insertText fallback needed...`
      );

      await page.$eval(
        selector,
        (el, newValue) => {
          el.focus();

          const valueSetter =
            Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value"
            )?.set;

          if (valueSetter) {
            valueSetter.call(el, newValue);
          } else {
            el.value = newValue;
          }

          el.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: null,
            })
          );

          el.dispatchEvent(
            new Event("change", {
              bubbles: true,
            })
          );
        },
        String(value)
      );

      await delay(300);

      currentLength = await page.$eval(
        selector,
        (el) => el.value?.length || 0
      );
    }

    return currentLength;
  }

  // =========================================================
  // USERNAME
  // =========================================================

  const usernameLength =
    await fillInput(
      usernameSelector,
      EMAIL
    );

  console.log(
    `👤 Username chars: ${usernameLength}`
  );

  // =========================================================
  // PASSWORD
  // =========================================================

  const passwordLength =
    await fillInput(
      passwordSelector,
      PASSWORD
    );

  console.log(
    `🔑 Password chars: ${passwordLength}`
  );

  // =========================================================
  // VERIFY FORM
  // =========================================================

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
    `👤 Final username chars: ${inputState.usernameLength}`
  );

  console.log(
    `🔑 Final password chars: ${inputState.passwordLength}`
  );

  console.log(
    `🔘 Login disabled: ${inputState.buttonDisabled}`
  );

  if (
    inputState.usernameLength === 0 ||
    inputState.passwordLength === 0
  ) {
    throw new Error(
      "Username/password could not be filled into OZ-Hami login form."
    );
  }

  // =========================================================
  // SUBMIT
  // =========================================================

  console.log("➡️ Clicking Login...");

  await page.click(loginSelector);

  let loggedIn =
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

  // =========================================================
  // ENTER FALLBACK
  // =========================================================

  if (!loggedIn) {
    console.log(
      "ℹ️ No redirect yet. Trying Enter..."
    );

    await page.focus(passwordSelector);

    await page.keyboard.press("Enter");

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
  // LOGIN FAILED
  // =========================================================

  if (
    !loggedIn ||
    page.url().includes("/login")
  ) {
    const diagnostic =
      await page.evaluate(() => {
        const text =
          document.body?.innerText || "";

        return text
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

    diagnostic.forEach((line) =>
      console.log(`   ${line}`)
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
}
