/** Log JSON một dòng ra stdout; supervisor đọc stdout và đẩy lên dashboard. */
export function createLogger(base: Record<string, unknown>) {
  return (event: string, fields: Record<string, unknown> = {}) => {
    const line = { ts: new Date().toISOString(), ...base, event, ...fields };
    process.stdout.write(JSON.stringify(line) + "\n");
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
