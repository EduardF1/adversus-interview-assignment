import mysql from "mysql2/promise";
import { config } from "./config.js";

/**
 * Shared MySQL connection pool.
 */
export const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: 10,
});