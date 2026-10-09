// Ids are validated against fixed patterns (c_\d{7}, k_\d{5}, u_\d{6}), so they are stored
// as integers in Postgres: smaller rows and indexes, faster joins. These convert both ways.
export const clipNum = (id: string) => Number(id.slice(2));
export const campaignNum = (id: string) => Number(id.slice(2));
export const creatorNum = (id: string) => Number(id.slice(2));

export const clipId = (n: number) => 'c_' + String(n).padStart(7, '0');
export const campaignId = (n: number) => 'k_' + String(n).padStart(5, '0');
export const creatorId = (n: number) => 'u_' + String(n).padStart(6, '0');
