import "dotenv/config";
import { createHash } from "node:crypto";
import mongoose from "mongoose";

const COLLECTIONS = [
  { collection: "orders", field: "orderNumber", counter: "orderNumber" },
  { collection: "products", field: "productNumber", counter: "productNumber" },
] as const;

type NumberingCollection = (typeof COLLECTIONS)[number]["collection"];
type NumberingField = (typeof COLLECTIONS)[number]["field"];
type NumberingRecord = Record<string, unknown> & {
  _id: mongoose.Types.ObjectId;
  createdAt?: Date;
};
type CounterRecord = Record<string, unknown> & {
  _id: string;
  seq: number;
};

type NumberingStats = {
  count: number;
  missing: number;
  invalid: number;
  duplicateValues: number;
  minimum: number | null;
  maximum: number | null;
  firstInCreationOrder: {
    id: string;
    createdAt: Date | null;
    currentNumber: unknown;
  } | null;
  lastInCreationOrder: {
    id: string;
    createdAt: Date | null;
    currentNumber: unknown;
  } | null;
};

type CollectionFingerprint = {
  count: number;
  sha256: string;
};

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function isLoopbackDatabase(): boolean {
  return new Set(["localhost", "127.0.0.1", "::1"]).has(
    mongoose.connection.host,
  );
}

async function inspectNumbering(
  collectionName: NumberingCollection,
  field: NumberingField,
): Promise<NumberingStats> {
  const collection =
    mongoose.connection.collection<NumberingRecord>(collectionName);
  const count = await collection.countDocuments();
  const values = new Map<number, number>();
  let missing = 0;
  let invalid = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let firstInCreationOrder: NumberingStats["firstInCreationOrder"] = null;
  let lastInCreationOrder: NumberingStats["lastInCreationOrder"] = null;

  const cursor = collection
    .find({}, { projection: { _id: 1, createdAt: 1, [field]: 1 } })
    .sort({ createdAt: 1, _id: 1 });

  for await (const record of cursor) {
    const currentNumber = record[field];
    const row = {
      id: record._id.toString(),
      createdAt: record.createdAt ?? null,
      currentNumber: currentNumber ?? null,
    };
    firstInCreationOrder ??= row;
    lastInCreationOrder = row;

    if (currentNumber === undefined || currentNumber === null) {
      missing += 1;
    } else if (
      typeof currentNumber !== "number" ||
      !Number.isSafeInteger(currentNumber) ||
      currentNumber < 1
    ) {
      invalid += 1;
    } else {
      values.set(currentNumber, (values.get(currentNumber) ?? 0) + 1);
      minimum = Math.min(minimum, currentNumber);
      maximum = Math.max(maximum, currentNumber);
    }
  }

  return {
    count,
    missing,
    invalid,
    duplicateValues: [...values.values()].filter((occurrences) => occurrences > 1)
      .length,
    minimum: Number.isFinite(minimum) ? minimum : null,
    maximum: Number.isFinite(maximum) ? maximum : null,
    firstInCreationOrder,
    lastInCreationOrder,
  };
}

async function printSafeTarget(): Promise<void> {
  const host = mongoose.connection.host;
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  console.log(
    JSON.stringify(
      {
        nodeEnv: process.env.NODE_ENV ?? "unset",
        mongoHost: host,
        database: mongoose.connection.name,
        classification: loopbackHosts.has(host)
          ? "loopback-local"
          : "remote-or-nonloopback",
      },
      null,
      2,
    ),
  );
}

async function assignSequence(
  collectionName: NumberingCollection,
  field: NumberingField,
): Promise<number> {
  const collection =
    mongoose.connection.collection<NumberingRecord>(collectionName);
  await collection.updateMany({}, { $unset: { [field]: "" } });

  let next = 0;
  let batch: mongoose.mongo.AnyBulkWriteOperation<NumberingRecord>[] = [];

  const cursor = collection
    .find({}, { projection: { _id: 1 } })
    .sort({ createdAt: 1, _id: 1 });

  for await (const record of cursor) {
    next += 1;
    batch.push({
      updateOne: {
        filter: { _id: record._id },
        update: { $set: { [field]: next } },
      },
    });

    if (batch.length === 500) {
      await collection.bulkWrite(batch);
      batch = [];
    }
  }

  if (batch.length > 0) await collection.bulkWrite(batch);
  return next;
}

async function fingerprintCollection(
  collectionName: NumberingCollection,
  field: NumberingField,
): Promise<CollectionFingerprint> {
  const collection =
    mongoose.connection.collection<NumberingRecord>(collectionName);
  const hash = createHash("sha256");
  let count = 0;
  const cursor = collection.find({}).sort({ _id: 1 });

  for await (const record of cursor) {
    const preservedFields = { ...record };
    delete preservedFields[field];
    hash.update(JSON.stringify(preservedFields));
    hash.update("\n");
    count += 1;
  }

  return { count, sha256: hash.digest("hex") };
}

async function sequenceIsValid(
  collectionName: NumberingCollection,
  field: NumberingField,
): Promise<{
  valid: boolean;
  count: number;
  minimum: number | null;
  highest: number;
}> {
  const collection =
    mongoose.connection.collection<NumberingRecord>(collectionName);
  const total = await collection.countDocuments();
  let observed = 0;
  let previous = 0;
  let minimum: number | null = null;
  let highest = 0;
  let valid = true;

  const cursor = collection
    .find({}, { projection: { _id: 1, [field]: 1 } })
    .sort({ createdAt: 1, _id: 1 });

  for await (const record of cursor) {
    observed += 1;
    const value = record[field];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= previous
    ) {
      valid = false;
    } else {
      previous = value;
      minimum ??= value;
      highest = value;
    }
  }

  return {
    valid: valid && observed === total,
    count: total,
    minimum,
    highest,
  };
}

async function verify(requireContinuous = false): Promise<boolean> {
  let valid = true;

  for (const item of COLLECTIONS) {
    const result = await sequenceIsValid(item.collection, item.field);
    const counter = await mongoose.connection
      .collection<CounterRecord>("counters")
      .findOne({ _id: item.counter });
    const indexes = await mongoose.connection
      .collection(item.collection)
      .indexes();
    const uniqueIndex = indexes.some(
      (index) =>
        index.key?.[item.field] === 1 &&
        index.unique === true &&
        index.sparse === true,
    );
    const counterValid =
      Number.isSafeInteger(counter?.seq) &&
      (counter?.seq ?? -1) >= result.highest;
    const continuous =
      result.count === 0 ||
      (result.minimum === 1 && result.highest === result.count);
    const exactCounter = counter?.seq === result.highest;

    console.log(
      `${item.collection}: ${result.count} records; sequence ${
        result.valid ? "valid" : "INVALID"
      }${requireContinuous ? `; continuous ${continuous ? "yes" : "NO"}` : ""}; ` +
        `counter ${counterValid ? "valid" : "INVALID"}${
          requireContinuous ? ` (exact ${exactCounter ? "yes" : "NO"})` : ""
        }; unique index ${uniqueIndex ? "valid" : "MISSING"}`,
    );
    valid =
      valid &&
      result.valid &&
      counterValid &&
      uniqueIndex &&
      (!requireContinuous || (continuous && exactCounter));
  }

  return valid;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not defined");

  const dryRun = hasFlag("--dry-run");
  const apply = hasFlag("--apply");
  const verifyOnly = hasFlag("--verify");
  const confirmReset = hasFlag("--confirm-reset");
  const allowRemoteTarget = hasFlag("--allow-remote-target");

  if (
    Number(dryRun) + Number(apply) + Number(verifyOnly) !== 1 ||
    (apply && !confirmReset)
  ) {
    throw new Error(
      "Usage: migrateBusinessNumbers.ts --dry-run | --verify | --apply --confirm-reset",
    );
  }

  await mongoose.connect(uri);
  try {
    await printSafeTarget();

    if (apply && !isLoopbackDatabase() && !allowRemoteTarget) {
      throw new Error(
        "Refusing destructive reset on a non-loopback MongoDB host; explicit --allow-remote-target authorization is required",
      );
    }

    if (verifyOnly) {
      if (!(await verify())) process.exitCode = 1;
      return;
    }

    if (dryRun) {
      for (const item of COLLECTIONS) {
        const collectionExists = await mongoose.connection.db
          ?.listCollections({ name: item.collection }, { nameOnly: true })
          .hasNext();
        if (!collectionExists) {
          throw new Error(
            `Required collection ${item.collection} does not exist; refusing to report an apply plan`,
          );
        }

        const [stats, counter] = await Promise.all([
          inspectNumbering(item.collection, item.field),
          mongoose.connection
            .collection<CounterRecord>("counters")
            .findOne({ _id: item.counter }),
        ]);
        console.log(
          JSON.stringify(
            {
              collection: item.collection,
              field: item.field,
              current: stats,
              counter: counter?.seq ?? null,
              proposed: {
                count: stats.count,
                firstNumber: stats.count > 0 ? 1 : null,
                lastNumber: stats.count,
                ordering: ["createdAt ASC", "_id ASC"],
                firstRecordId: stats.firstInCreationOrder?.id ?? null,
                firstCreatedAt:
                  stats.firstInCreationOrder?.createdAt ?? null,
                lastRecordId: stats.lastInCreationOrder?.id ?? null,
                lastCreatedAt: stats.lastInCreationOrder?.createdAt ?? null,
                counter: stats.count,
              },
              preserved: "all documents and every field except the numbering field",
            },
            null,
            2,
          ),
        );
      }
      console.log("No data was changed.");
      return;
    }

    const counts = new Map<string, number>();
    const fingerprints = new Map<
      NumberingCollection,
      CollectionFingerprint
    >();
    for (const item of COLLECTIONS) {
      fingerprints.set(
        item.collection,
        await fingerprintCollection(item.collection, item.field),
      );
    }

    for (const item of COLLECTIONS) {
      counts.set(
        item.counter,
        await assignSequence(item.collection, item.field),
      );
    }

    const counters =
      mongoose.connection.collection<CounterRecord>("counters");
    for (const item of COLLECTIONS) {
      await counters.updateOne(
        { _id: item.counter },
        { $set: { seq: counts.get(item.counter) ?? 0 } },
        { upsert: true },
      );
    }

    for (const item of COLLECTIONS) {
      await mongoose.connection.collection(item.collection).createIndex(
        { [item.field]: 1 },
        { unique: true, sparse: true, name: `${item.field}_1` },
      );
    }

    for (const item of COLLECTIONS) {
      const before = fingerprints.get(item.collection);
      const after = await fingerprintCollection(item.collection, item.field);
      if (!before || before.count !== after.count || before.sha256 !== after.sha256) {
        throw new Error(
          `Preserved document integrity check failed for ${item.collection}`,
        );
      }
      console.log(
        `${item.collection}: preserved ${after.count} documents and all non-number fields (SHA-256 ${after.sha256})`,
      );
    }

    if (!(await verify(true))) {
      throw new Error("Business-number reset failed verification");
    }
    console.log("Business-number reset and verification completed.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Business-number migration failed:", error);
  process.exitCode = 1;
});
