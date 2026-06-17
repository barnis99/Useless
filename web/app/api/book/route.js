// Requires Vercel Pro for maxDuration > 60 s
export const maxDuration = 300;

import { runBooking } from '../../../lib/booker.js';
import { getStatus } from '../../../lib/store.js';

export async function POST(request) {
  // Optional secret guard — set BOOKING_SECRET env var to protect the endpoint
  const secret = process.env.BOOKING_SECRET;
  if (secret) {
    const provided =
      request.headers.get('x-booking-secret') ??
      new URL(request.url).searchParams.get('secret');
    if (provided !== secret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Don't stack runs
  const current = await getStatus();
  if (current?.state === 'running') {
    return Response.json({ message: 'Already running' }, { status: 409 });
  }

  const body = request.headers.get('content-type')?.includes('json')
    ? await request.json().catch(() => ({}))
    : {};

  const result = await runBooking({ dateOverride: body.date ?? null });
  return Response.json(result);
}
