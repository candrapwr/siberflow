declare module "pg" {
  export interface QueryField {
    name: string;
  }

  export interface QueryResult<Row = Record<string, unknown>> {
    command: string;
    rowCount: number | null;
    fields: QueryField[];
    rows: Row[];
  }

  export class Client {
    constructor(config?: {
      host?: string;
      port?: number;
      user?: string;
      password?: string;
      database?: string;
    });
    connect(): Promise<void>;
    query<Row = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<Row>>;
    end(): Promise<void>;
  }

  const pg: {
    Client: typeof Client;
  };

  export default pg;
}
