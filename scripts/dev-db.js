// Local MongoDB for development when MongoDB isn't installed.
// Runs a real mongod binary (downloaded once) on port 27017 and persists data to ./.mongo-data.
// To use your own MongoDB / Atlas instead, skip this and set MONGODB_URI in .env.
import fs from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server-core';

const dbPath = path.resolve('.mongo-data');
fs.mkdirSync(dbPath, { recursive: true });

const server = await MongoMemoryServer.create({
  instance: { port: Number(process.env.DEV_DB_PORT) || 27017, dbPath, storageEngine: 'wiredTiger' },
});
console.log(`Dev MongoDB running at ${server.getUri()} (data: ${dbPath})`);

const stop = async () => {
  await server.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
