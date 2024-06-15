import DecimalJs from "decimal.js-light";
import { _defineAssertDecimal } from "../internal";

/**
 * @see https://mikemcl.github.io/decimal.js-light/
 */
// decimal.js へのグローバルパッチを防ぐために clone する。
const DecimalClass = /* @__PURE__ */ DecimalJs.clone();

/* @__PURE__ */ _defineAssertDecimal(
  // prototype は依然としてグローバルになっているため、浅くコピーする。
  // @ts-expect-error
  DecimalClass.prototype = {
    ...DecimalClass.prototype,
  },
);

export default DecimalClass;
