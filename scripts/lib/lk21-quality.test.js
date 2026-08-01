import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLk21Quality,
  shouldRefreshLk21Quality,
} from "./lk21-quality.js";

test("mengambil badge kualitas dari listing", () => {
  assert.equal(
    extractLk21Quality('<span class="label label-CAM">CAM</span>'),
    "CAM"
  );
  assert.equal(
    extractLk21Quality('<span class="label label-HD">HD</span>'),
    "HD"
  );
});

test("memprioritaskan sumber detail di atas badge umum", () => {
  const html =
    '<span class="label label-HD">HD</span><a href="/quality/bluray">BLURAY</a>';
  assert.equal(extractLk21Quality(html), "BluRay");
});

test("tidak menurunkan BluRay menjadi badge HD", () => {
  assert.equal(shouldRefreshLk21Quality("BluRay", "HD"), false);
  assert.equal(shouldRefreshLk21Quality("CAM", "HD"), true);
  assert.equal(shouldRefreshLk21Quality("", "HD"), true);
});
