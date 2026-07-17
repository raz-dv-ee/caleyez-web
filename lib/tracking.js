// Pure helpers for tracking, recipes, nutrition scaling and CSV.
// UMD: works as a plain <script> in the browser (global CZTrack) and require() in Node tests.
// No DOM, no localStorage, no network in this file - that keeps it testable.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CZTrack = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  return {};
});
