declare const Bun: {
  env: Record<string, string | undefined>;
  serve(options: {
    port?: number;
    fetch: (req: Request) => Response | Promise<Response>;
    [key: string]: unknown;
  }): unknown;
};
