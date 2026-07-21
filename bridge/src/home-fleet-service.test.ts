import assert from "node:assert/strict";
import test from "node:test";
import { selectPrivateLanHost } from "./home-fleet-service.js";

test("the production Home Fleet listener accepts only a concrete RFC1918 IPv4 bind address", () => {
  // The protocol primitive permits loopback for unit tests, but the actual
  // multi-laptop service must never advertise loopback, a public address, or
  // a hostname as its coordinator endpoint.
  assert.equal(selectPrivateLanHost("10.42.0.9"), "10.42.0.9");
  assert.equal(selectPrivateLanHost("172.20.4.9"), "172.20.4.9");
  assert.equal(selectPrivateLanHost("192.168.50.4"), "192.168.50.4");
  assert.equal(selectPrivateLanHost("127.0.0.1"), undefined);
  assert.equal(selectPrivateLanHost("8.8.8.8"), undefined);
  assert.equal(selectPrivateLanHost("home-laptop.local"), undefined);
});
