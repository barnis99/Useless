// Requires Vercel Pro for maxDuration > 60 s
export const maxDuration = 300;

import { runBooking } from '../../../lib/booker.js';

export async function GET(request) {
  // Vercel passes the CRON_SECRET as a Bearer token; validate it.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const result = await runBooking();
  return Response.json(result);
}
