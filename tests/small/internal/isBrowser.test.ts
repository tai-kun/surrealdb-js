import { isBrowser } from "@tai-kun/surreal/_internal";
import { assertEquals } from "@tools/assert";
import { ENV, test } from "@tools/test";

test("ブラウザかどうかを判定する", () => {
  let browser: boolean;

  switch (ENV) {
    case "Chrome":
    case "Firefox":
    case "WebKit":
      browser = true;
      break;

    case "Bun":
    case "Deno":
    case "Node":
      browser = false;
      break;
  }

  assertEquals(isBrowser, browser);
});
