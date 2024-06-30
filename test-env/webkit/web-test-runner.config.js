import { setup } from "@tools/surrealdb/setup";
import { playwrightLauncher } from "@web/test-runner-playwright";

const conn = await setup();

export default {
  nodeResolve: true,
  port: 9000,
  browsers: [
    playwrightLauncher({
      product: "webkit",
    }),
  ],
  testRunnerHtml: testFramework =>
    `<html>
      <body>
        <script>
          globalThis.SURREALDB = ${JSON.stringify(conn)};
        </script>
        <script type="module" src="${testFramework}"></script>
      </body>
    </html>`,
  testsFinishTimeout: 30 * 60 * 1_000, // 30 min
};
