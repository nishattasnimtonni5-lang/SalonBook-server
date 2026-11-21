import { MongoClient } from "mongodb";

export const DB_NAME = "SalonBook";

const client = new MongoClient(process.env.MONGODB_URI);
/** @type {import("mongodb").Db} */
let db = client.db(DB_NAME);


export async function connectDB() {
  await client.connect();
  db = client.db(DB_NAME);
  await db.command({ ping: 1 });
  return db;
}

export const usersCollection = db.collection("user");
export const servicesCollection = db.collection("services");
export const appointmentCollection = db.collection("appointments");

export async function closeDB() {
  await client.close();
}