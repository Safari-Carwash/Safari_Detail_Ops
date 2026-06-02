/**
 * Test deposit payment lookup from Square
 * 
 * Usage: npx tsx scripts/test-deposit-lookup.ts <customerId> <bookingId>
 * Example: npx tsx scripts/test-deposit-lookup.ts CUST123 BOOK456
 */

import { findDepositPaymentForBooking } from '../lib/square/payments-api';

async function main() {
  const customerId = process.argv[2];
  const bookingId = process.argv[3];

  if (!customerId || !bookingId) {
    console.error('Usage: npx tsx scripts/test-deposit-lookup.ts <customerId> <bookingId>');
    process.exit(1);
  }

  console.log('[TEST] Searching for deposit payment', { customerId, bookingId });

  try {
    const payment = await findDepositPaymentForBooking({
      bookingId,
      customerId,
      appointmentTime: new Date().toISOString(),
    });

    if (payment) {
      console.log('[TEST] ✓ Deposit payment found:', {
        id: payment.id,
        amount: payment.amount_money?.amount,
        currency: payment.amount_money?.currency,
        status: payment.status,
        note: payment.note,
        orderId: payment.order_id,
      });
    } else {
      console.log('[TEST] ✗ No deposit payment found');
    }
  } catch (error: any) {
    console.error('[TEST] Error:', error?.message || error);
    process.exit(1);
  }
}

main();
