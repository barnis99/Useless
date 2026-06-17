import { getStatus } from '../../../lib/store.js';

export async function GET() {
  const status = await getStatus();
  return Response.json(status ?? { state: 'idle' });
}
