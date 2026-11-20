"use strict";
// Replay del golden del front (tests/fixtures/verdicts_front_golden.json):
// PWData.product/buyable/score + atMin/dealOK/DEALS de state.js deben
// reproducir las salidas volcadas. Regenerado post-paso-B (frescura
// estricta) — un diff = cambio de comportamiento.
const { test } = require("node:test"), assert = require("node:assert");
const fs = require("fs"), path = require("path");
const { makeCtx, boot, vm } = require("./harness.js");

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, "..",
  "fixtures", "verdicts_front_golden.json"), "utf8"));

const EVAL = `JSON.stringify({
  product: PWData.product("111"),
  product_club: PWData.product("111", "Club X"),
  buyable: PWData.buyable("111"),
  buyable_club: PWData.buyable("111", "Club X"),
  score: PWData.score("111"),
  atMin: atMin("111"),
  dealOK: {
    letrero: dealOK("111", "letrero"),
    silenciosa: dealOK("111", "silenciosa"),
    real: dealOK("111", "real"),
    min: dealOK("111", "min"),
    bajo: dealOK("111", "bajo"),
    all: dealOK("111", "all"),
  },
  DEALS: DEALS,
})`;

for (const c of GOLDEN.cases) {
  test("verdicts golden: " + c.name, () => {
    const ctx = makeCtx({ data: c.data, stored: c.stored });
    vm.runInContext("Date.now = () => " + c.now, ctx);
    boot(ctx);
    assert.deepStrictEqual(
      JSON.parse(vm.runInContext(EVAL, ctx)), c.expected);
  });
}
