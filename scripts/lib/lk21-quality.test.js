import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLk21Quality,
  shouldRefreshLk21Quality,
} from "./lk21-quality.js";

test("mengambil badge kualitas dari kartu listing", () => {
  assert.equal(
    extractLk21Quality('<span class="label label-CAM">CAM</span>'),
    "CAM"
  );
  assert.equal(
    extractLk21Quality('<span class="label label-HD">HD</span>'),
    "HD"
  );
});

test("mengabaikan link menu /quality/ milik navigasi situs", () => {
  const navOnly = '<li><a href="/quality/bluray">BLURAY</a></li>';
  assert.equal(extractLk21Quality(navOnly), "");

  const card =
    '<li><a href="/quality/bluray">BLURAY</a></li>' +
    '<span class="label label-CAM">CAM</span>';
  assert.equal(extractLk21Quality(card), "CAM");
});

test("memperbarui kualitas saat badge listing berubah", () => {
  assert.equal(shouldRefreshLk21Quality("CAM", "HD"), true);
  assert.equal(shouldRefreshLk21Quality("", "HD"), true);
  assert.equal(shouldRefreshLk21Quality("HD", "HD"), false);
  assert.equal(shouldRefreshLk21Quality("HD", ""), false);
});
