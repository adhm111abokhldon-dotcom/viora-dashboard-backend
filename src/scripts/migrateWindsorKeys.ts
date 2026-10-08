import "dotenv/config";
import mongoose from "mongoose";

type WindsorRecord = Record<string, unknown> & {
  _id: mongoose.Types.ObjectId;
  source: string;
  externalKey: string;
};

type DuplicateGroup = {
  _id: string;
  count: number;
  ids: mongoose.Types.ObjectId[];
  amounts: number[];
};

const INDEX_NAME = "windsor_external_key_unique";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function isLoopbackDatabase(): boolean {
  return new Set(["localhost", "127.0.0.1", "::1"]).has(
    mongoose.connection.host,
  );
}

async function duplicateGroups(): Promise<DuplicateGroup[]> {
  return mongoose.connection
    .collection<WindsorRecord>("advertisingexpenses")
    .aggregate<DuplicateGroup>([
      {
        $match: {
          source: "windsor",
          externalKey: { $type: "string" },
        },
      },
      { $sort: { updatedAt: -1, _id: 1 } },
      {
        $group: {
          _id: "$externalKey",
          count: { $sum: 1 },
          ids: { $push: "$_id" },
          amounts: { $push: "$amount" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
}

async function verify(): Promise<boolean> {
  const duplicates = await duplicateGroups();
  const indexes = await mongoose.connection
    .collection<WindsorRecord>("advertisingexpenses")
    .indexes();
  const index = indexes.find((candidate) => candidate.name === INDEX_NAME);
  const indexValid =
    index?.unique === true &&
    index.key?.source === 1 &&
    index.key?.externalKey === 1 &&
    index.partialFilterExpression?.source === "windsor";

  console.log(
    `Windsor duplicate keys: ${duplicates.length === 0 ? "none" : duplicates.length}; ` +
      `unique index: ${indexValid ? "valid" : "MISSING OR INVALID"}`,
  );
  return duplicates.length === 0 && indexValid;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not defined");

  const dryRun = hasFlag("--dry-run");
  const apply = hasFlag("--apply");
  const verifyOnly = hasFlag("--verify");
  const confirm = hasFlag("--confirm-deduplicate");
  const allowRemoteTarget = hasFlag("--allow-remote-target");
  if (
    Number(dryRun) + Number(apply) + Number(verifyOnly) !== 1 ||
    (apply && !confirm)
  ) {
    throw new Error(
      "Usage: migrateWindsorKeys.ts --dry-run | --verify | --apply --confirm-deduplicate",
    );
  }

  await mongoose.connect(uri);
  try {
    if (apply && !isLoopbackDatabase() && !allowRemoteTarget) {
      throw new Error(
        "Refusing destructive deduplication on a non-loopback MongoDB host; explicit --allow-remote-target authorization is required",
      );
    }

    if (verifyOnly) {
      if (!(await verify())) process.exitCode = 1;
      return;
    }

    const duplicates = await duplicateGroups();
    const duplicateDocuments = duplicates.reduce(
      (sum, group) => sum + group.count - 1,
      0,
    );
    const advertising = mongoose.connection.collection("advertisingexpenses");
    const [windsorRecords, manualRecords, totalRecords, indexes] =
      await Promise.all([
        advertising.countDocuments({ source: "windsor" }),
        advertising.countDocuments({
          $or: [{ source: { $exists: false } }, { source: null }, { source: "manual" }],
        }),
        advertising.countDocuments(),
        advertising.indexes(),
      ]);
    const conflictingAmountGroups = duplicates.filter(
      (group) => new Set(group.amounts).size > 1,
    ).length;
    const existingIndex = indexes.find(
      (candidate) => candidate.name === INDEX_NAME,
    );
    console.log(
      JSON.stringify(
        {
          database: mongoose.connection.name,
          collection: "advertisingexpenses",
          totalRecords,
          windsorRecords,
          manualRecords,
          duplicateKeyGroups: duplicates.length,
          duplicateRowsThatWouldBeRemoved: duplicateDocuments,
          duplicateGroupsWithDifferentAmounts: conflictingAmountGroups,
          indexAlreadyPresent: existingIndex
            ? {
                name: existingIndex.name,
                unique: existingIndex.unique === true,
                key: existingIndex.key,
              }
            : null,
          applyBehavior:
            "keep newest updatedAt row for each duplicate Windsor externalKey; remove only other Windsor rows with that exact key; leave manual and unrelated records unchanged",
        },
        null,
        2,
      ),
    );

    if (dryRun) {
      console.log("DRY RUN: no records or indexes were changed.");
      return;
    }

    const duplicateIds = duplicates.flatMap((group) => group.ids.slice(1));
    if (duplicateIds.length > 0) {
      await mongoose.connection
        .collection<WindsorRecord>("advertisingexpenses")
        .deleteMany({
          source: "windsor",
          _id: { $in: duplicateIds },
        });
    }

    await mongoose.connection
      .collection<WindsorRecord>("advertisingexpenses")
      .createIndex(
        { source: 1, externalKey: 1 },
        {
          unique: true,
          partialFilterExpression: {
            source: "windsor",
            externalKey: { $type: "string" },
          },
          name: INDEX_NAME,
        },
      );

    if (!(await verify())) {
      throw new Error("Windsor external-key migration failed verification");
    }
    console.log("Windsor external-key deduplication and index completed.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Windsor key migration failed:", error);
  process.exitCode = 1;
});
