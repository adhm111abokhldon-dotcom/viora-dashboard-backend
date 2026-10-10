import mongoose, { Schema } from "mongoose";

export interface IWindsorSyncState {
  connectionId: "viora-windsor";
  /** Timestamp also written to every Windsor row returned by this sync. */
  lastSuccessfulSyncAt: Date;
  historyFrom: string | null;
  historyTo: string | null;
  updatedAt: Date;
}

const windsorSyncStateSchema = new Schema<IWindsorSyncState>(
  {
    connectionId: {
      type: String,
      enum: ["viora-windsor"],
      required: true,
      unique: true,
    },
    lastSuccessfulSyncAt: { type: Date, required: true },
    historyFrom: { type: String, default: null },
    historyTo: { type: String, default: null },
  },
  { timestamps: true },
);

export default mongoose.model<IWindsorSyncState>(
  "WindsorSyncState",
  windsorSyncStateSchema,
);
