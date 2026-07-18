import { test } from "node:test";
import assert from "node:assert";
import { normalizeRemote } from "./repo.js";
test("normalizes SSH and HTTPS remotes to owner/name", () => {
  assert.equal(normalizeRemote("git@github.com:Acme/Widget.git"), "Acme/Widget");
  assert.equal(normalizeRemote("https://github.com/Acme/Widget.git"), "Acme/Widget");
  assert.equal(normalizeRemote("https://github.com/Acme/Widget"), "Acme/Widget");
  assert.equal(normalizeRemote("ssh://git@github.com/Acme/Widget.git"), "Acme/Widget");
  assert.equal(normalizeRemote("https://app.x/Acme/Widget.git"), null);
  assert.equal(normalizeRemote("git@app.x:Acme/Widget.git"), null);
  assert.equal(normalizeRemote("https://github.com/Acme/Widget/extra"), null);
  assert.equal(normalizeRemote("not a url"), null);
});
