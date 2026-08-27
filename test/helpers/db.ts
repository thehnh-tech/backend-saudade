import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { syncAroundIndexes } from "../../src/around/models.js";

let mongod: MongoMemoryServer | null = null;

export async function setupTestDb() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await syncAroundIndexes();
}

export async function teardownTestDb() {
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

export async function clearCollections() {
  const db = mongoose.connection.db;
  if (!db) return;
  const collections = await db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}
