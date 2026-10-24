import { test } from "node:test";
import assert from "node:assert/strict";

import { validateToolArguments } from "../src/mcp/validate.js";

const schema = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "integer" },
    tags: { type: "array" },
    raw: {},
  },
  required: ["query"],
  additionalProperties: false,
};

test("valid arguments produce no errors", () => {
  assert.deepEqual(validateToolArguments(schema, { query: "x", limit: 3 }), []);
});

test("missing required argument is reported", () => {
  const errors = validateToolArguments(schema, { limit: 1 });
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /missing required argument 'query'/);
});

test("wrong type is reported", () => {
  const errors = validateToolArguments(schema, { query: 5 });
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /'query' should be string/);
});

test("integer is checked distinctly from number", () => {
  const errors = validateToolArguments(schema, { query: "x", limit: 1.5 });
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /'limit' should be integer/);
});

test("unexpected argument is rejected when additionalProperties is false", () => {
  const errors = validateToolArguments(schema, { query: "x", extra: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /unexpected argument 'extra'/);
});

test("unknown/empty type does not block the call", () => {
  assert.deepEqual(validateToolArguments(schema, { query: "x", raw: { a: 1 } }), []);
});

test("a missing schema is not validated", () => {
  assert.deepEqual(validateToolArguments(undefined, { anything: 1 }), []);
});

test("null does not satisfy a required argument", () => {
  const errors = validateToolArguments(schema, { query: null });
  assert.ok(errors.length >= 1);
  assert.match(errors[0] ?? "", /'query'/);
});
