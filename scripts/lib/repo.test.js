import { test } from "node:test";
import assert from "node:assert";
import { normalizeRemote } from "./repo.js";
test("normalizes SSH and HTTPS remotes to owner/name", () => {
  assert.equal(normalizeRemote("git@github.com:Acme/Widget.git"), "Acme/Widget");
  assert.equal(normalizeRemote("https://github.com/Acme/Widget.git"), "Acme/Widget");
  assert.equal(normalizeRemote("https://github.com/Acme/Widget"), "Acme/Widget");
  assert.equal(normalizeRemote("ssh://git@github.com/Acme/Widget.git"), "Acme/Widget");
  assert.equal(normalizeRemote("not a url"), null);
});
