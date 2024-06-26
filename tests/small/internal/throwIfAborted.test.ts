import { throwIfAborted } from "@tai-kun/surreal/_internal";
import { SurrealTypeError } from "@tai-kun/surreal/errors";
import { assertThrows } from "@tools/assert";
import { test } from "@tools/test";

test("中止されていないシグナルを渡すと例外を投げない", () => {
  const controller = new AbortController();

  throwIfAborted(controller.signal);
});

test("中止されたシグナルを渡すと例外を投げる", () => {
  const controller = new AbortController();
  controller.abort();

  assertThrows(() => {
    throwIfAborted(controller.signal);
  });
});

test("中止されたシグナルを渡すと指定された例外を投げる", () => {
  const controller = new AbortController();
  const reason = new SurrealTypeError("test");
  controller.abort(reason);

  assertThrows(
    () => {
      throwIfAborted(controller.signal);
    },
    SurrealTypeError,
    "test",
  );
});
