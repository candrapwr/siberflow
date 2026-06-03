import mysql from "mysql2/promise";
import pg from "pg";
import type { Tool } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";
import type sqlite3 from "sqlite3";

type Engine = "mysql" | "postgresql" | "sqlite";

interface BaseArgs {
  engine: Engine;
  query: string;
  params?: unknown[];
}

interface MysqlArgs extends BaseArgs {
  engine: "mysql";
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
}

interface PostgresArgs extends BaseArgs {
  engine: "postgresql";
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
}

interface SqliteArgs extends BaseArgs {
  engine: "sqlite";
  path: string;
}

type Args = MysqlArgs | PostgresArgs | SqliteArgs;

const MAX_ROWS = 200;
const MAX_RESULT_CHARS = 200_000;

const { Client } = pg;

export const dbQueryTool: Tool = {
  name: "db_query",
  description:
    "Run a SQL query against MySQL, PostgreSQL, or SQLite. Supports both read and write queries. For MySQL/PostgreSQL provide host, user, password, and database. For SQLite provide a database file path inside the project directory. Returns a JSON summary with rows, row counts, and metadata.",
  parameters: {
    type: "object",
    properties: {
      engine: {
        type: "string",
        enum: ["mysql", "postgresql", "sqlite"],
        description: "Database engine",
      },
      host: {
        type: "string",
        description: "Database host for MySQL/PostgreSQL",
      },
      port: {
        type: "integer",
        description: "Optional database port override",
        minimum: 1,
        maximum: 65535,
      },
      user: {
        type: "string",
        description: "Database user for MySQL/PostgreSQL",
      },
      password: {
        type: "string",
        description: "Database password for MySQL/PostgreSQL",
      },
      database: {
        type: "string",
        description: "Database name for MySQL/PostgreSQL",
      },
      path: {
        type: "string",
        description: "SQLite database file path, absolute or relative to project dir",
      },
      query: {
        type: "string",
        description: "SQL query to execute",
      },
      params: {
        type: "array",
        description: "Optional positional parameters for the SQL query",
        items: {},
      },
    },
    required: ["engine", "query"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = validateArgs(args);
    switch (parsed.engine) {
      case "mysql":
        return await runMysqlQuery(parsed);
      case "postgresql":
        return await runPostgresQuery(parsed);
      case "sqlite":
        return await runSqliteQuery(parsed, ctx.projectDir);
    }
  },
};

function validateArgs(args: unknown): Args {
  if (!args || typeof args !== "object") {
    throw new Error("arguments must be an object");
  }
  const input = args as Record<string, unknown>;

  const engine = input.engine;
  if (engine !== "mysql" && engine !== "postgresql" && engine !== "sqlite") {
    throw new Error('`engine` must be one of: "mysql", "postgresql", "sqlite"');
  }

  const query = requireString(input.query, "query");
  const params = requireParams(input.params);

  if (engine === "sqlite") {
    return {
      engine,
      path: requireString(input.path, "path"),
      query,
      ...(params ? { params } : {}),
    };
  }

  return {
    engine,
    host: requireString(input.host, "host"),
    user: requireString(input.user, "user"),
    password: requireString(input.password, "password"),
    database: requireString(input.database, "database"),
    query,
    ...(typeof input.port === "number" ? { port: input.port } : {}),
    ...(params ? { params } : {}),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`\`${field}\` is required and must be a non-empty string`);
  }
  return value;
}

function requireParams(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("`params` must be an array when provided");
  }
  return value;
}

async function runMysqlQuery(args: MysqlArgs): Promise<string> {
  const connection = await mysql.createConnection({
    host: args.host,
    port: args.port,
    user: args.user,
    password: args.password,
    database: args.database,
  });

  try {
    const [rawRows] = await connection.query(args.query, args.params ?? []);
    return formatResult("mysql", args.query, summarizeMysql(rawRows));
  } finally {
    await connection.end();
  }
}

async function runPostgresQuery(args: PostgresArgs): Promise<string> {
  const client = new Client({
    host: args.host,
    port: args.port,
    user: args.user,
    password: args.password,
    database: args.database,
  });

  await client.connect();
  try {
    const result = await client.query(args.query, args.params ?? []);
    return formatResult("postgresql", args.query, {
      command: result.command,
      rowCount: result.rowCount ?? 0,
      fields: result.fields.map((field: { name: string }) => field.name),
      rows: limitRows(result.rows),
      truncated: result.rows.length > MAX_ROWS,
    });
  } finally {
    await client.end();
  }
}

async function runSqliteQuery(args: SqliteArgs, projectDir: string): Promise<string> {
  const fullPath = await resolveWithin(projectDir, args.path);
  const sqlite3 = await loadSqlite3();
  const database = new sqlite3.Database(fullPath);

  try {
    if (isSelectLikeQuery(args.query)) {
      const rows = await sqliteAll(database, args.query, args.params ?? []);
      return formatResult("sqlite", args.query, {
        rowCount: rows.length,
        rows: limitRows(rows),
        truncated: rows.length > MAX_ROWS,
      });
    }

    const run = (sql: string, params: unknown[]): Promise<{ changes: number; lastID: number }> =>
      new Promise((resolve, reject) => {
        database.run(sql, params, function onRun(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve({
            changes: this.changes,
            lastID: this.lastID,
          });
        });
      });

    const result = await run(args.query, args.params ?? []);
    return formatResult("sqlite", args.query, result);
  } finally {
    await closeSqlite(database);
  }
}

function summarizeMysql(rawRows: unknown): Record<string, unknown> {
  if (Array.isArray(rawRows)) {
    if (rawRows.length === 0) {
      return { rowCount: 0, rows: [] };
    }

    const first = rawRows[0];
    if (isPlainObject(first)) {
      const rows = rawRows as Record<string, unknown>[];
      return {
        rowCount: rows.length,
        rows: limitRows(rows),
        truncated: rows.length > MAX_ROWS,
      };
    }

    return {
      rowCount: rawRows.length,
      rows: rawRows,
    };
  }

  if (isPlainObject(rawRows)) {
    return rawRows;
  }

  return { result: rawRows };
}

function formatResult(
  engine: Engine,
  query: string,
  details: Record<string, unknown>,
): string {
  const payload = {
    engine,
    query,
    ...details,
  };
  const text = JSON.stringify(payload, null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return text.slice(0, MAX_RESULT_CHARS) + `\n... [truncated ${text.length - MAX_RESULT_CHARS} chars]`;
}

function limitRows<T>(rows: T[]): T[] {
  return rows.slice(0, MAX_ROWS);
}

function isSelectLikeQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized.startsWith("select") || normalized.startsWith("pragma") || normalized.startsWith("with");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closeSqlite(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function sqliteAll(
  database: sqlite3.Database,
  sql: string,
  params: unknown[],
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function loadSqlite3(): Promise<typeof sqlite3> {
  try {
    const mod = await import("sqlite3");
    return mod.default;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("GLIBC_")) {
      throw new Error(
        `failed to load sqlite3 native binding: ${message}. ` +
          "This server's glibc is older than the sqlite3 binary that was installed. " +
          "Rebuild sqlite3 on the target machine with `npm rebuild sqlite3 --build-from-source`, " +
          "or install dependencies on that server so a compatible native binary is produced.",
      );
    }
    throw err;
  }
}
