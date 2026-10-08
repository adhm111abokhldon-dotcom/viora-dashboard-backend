import assert from "node:assert/strict";
import test from "node:test";
import { isBusinessNumberSequenceComplete } from "./orderNumber.js";

async function* records<T>(values: T[]): AsyncGenerator<T> {
  yield* values;
}

test("business-number verification permits deleted-number gaps but rejects duplicates and reordering", async () => {
  assert.equal(
    await isBusinessNumberSequenceComplete(
      records([{ orderNumber: 1 }, { orderNumber: 3 }, { orderNumber: 7 }]),
      "orderNumber",
    ),
    true,
  );
  assert.equal(
    await isBusinessNumberSequenceComplete(
      records([{ productNumber: 1 }, { productNumber: 3 }]),
      "productNumber",
    ),
    true,
  );
  assert.equal(
    await isBusinessNumberSequenceComplete(
      records([{ orderNumber: 1 }, { orderNumber: 3 }, { orderNumber: 2 }]),
      "orderNumber",
    ),
    false,
  );
  assert.equal(
    await isBusinessNumberSequenceComplete(
      records([{ orderNumber: 1 }, { orderNumber: 1 }]),
      "orderNumber",
    ),
    false,
  );
  assert.equal(
    await isBusinessNumberSequenceComplete(
      records([{ orderNumber: 1 }, { orderNumber: undefined }]),
      "orderNumber",
    ),
    false,
  );
});
