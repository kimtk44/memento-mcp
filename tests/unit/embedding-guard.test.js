import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertValidEmbedding, EMBEDDING_DIMENSIONS } from "../../lib/tools/embedding.js";

describe("assertValidEmbedding", () => {
  test("does not throw for a valid vector of the expected dimensions", () => {
    const vec = new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => (i % 7) * 0.01);
    assert.doesNotThrow(() => assertValidEmbedding(vec, "unit-test:valid"));
  });

  test("throws when the vector contains a null element", () => {
    const vec = new Array(EMBEDDING_DIMENSIONS).fill(0.1);
    vec[3] = null;
    assert.throws(
      () => assertValidEmbedding(vec, "unit-test:null-element"),
      /unit-test:null-element/
    );
  });

  test("throws when the vector contains a NaN element", () => {
    const vec = new Array(EMBEDDING_DIMENSIONS).fill(0.1);
    vec[10] = NaN;
    assert.throws(
      () => assertValidEmbedding(vec, "unit-test:nan-element"),
      /unit-test:nan-element/
    );
  });

  test("throws when the vector contains an Infinity element", () => {
    const vec = new Array(EMBEDDING_DIMENSIONS).fill(0.1);
    vec[0] = Infinity;
    assert.throws(
      () => assertValidEmbedding(vec, "unit-test:infinity-element"),
      /unit-test:infinity-element/
    );
  });

  test("throws when the vector contains an undefined element", () => {
    const vec = new Array(EMBEDDING_DIMENSIONS).fill(0.1);
    delete vec[5];
    assert.throws(
      () => assertValidEmbedding(vec, "unit-test:undefined-element"),
      /unit-test:undefined-element/
    );
  });

  test("throws when the vector contains a string element", () => {
    const vec = new Array(EMBEDDING_DIMENSIONS).fill(0.1);
    vec[1] = "0.1";
    assert.throws(
      () => assertValidEmbedding(vec, "unit-test:string-element"),
      /unit-test:string-element/
    );
  });

  test("throws when the vector has the wrong length", () => {
    const vec = new Array(EMBEDDING_DIMENSIONS - 1).fill(0.1);
    assert.throws(
      () => assertValidEmbedding(vec, "unit-test:wrong-length"),
      /unit-test:wrong-length/
    );
  });

  test("throws when the input is not an array", () => {
    assert.throws(
      () => assertValidEmbedding(null, "unit-test:not-array"),
      /unit-test:not-array/
    );
    assert.throws(
      () => assertValidEmbedding(undefined, "unit-test:not-array-undefined"),
      /unit-test:not-array-undefined/
    );
  });

  test("error message names the context, length, and expected dimensions", () => {
    const vec = new Array(EMBEDDING_DIMENSIONS).fill(0.1);
    vec[7] = null;
    try {
      assertValidEmbedding(vec, "generateEmbedding");
      assert.fail("expected assertValidEmbedding to throw");
    } catch (err) {
      assert.match(err.message, /generateEmbedding/);
      assert.match(err.message, /index 7/);
      assert.match(err.message, new RegExp(`length ${EMBEDDING_DIMENSIONS}`));
      assert.match(err.message, new RegExp(`EMBEDDING_DIMENSIONS ${EMBEDDING_DIMENSIONS}`));
    }
  });
});
