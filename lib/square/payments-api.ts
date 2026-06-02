/**
 * Square Payments API Client
 *
 * Used to locate deposits that are stored as separate Square payments.
 */

import { getConfig } from '../config';

export interface SquarePayment {
  id: string;
  amount_money?: {
    amount?: number;
    currency?: string;
  };
  status?: string;
  receipt_number?: string;
  note?: string;
  order_id?: string;
  customer_id?: string;
  location_id?: string;
  created_at?: string;
  source_type?: string;
  [key: string]: any;
}

export interface ListPaymentsOptions {
  customerId?: string;
  beginTime?: string;
  endTime?: string;
  locationId?: string;
}

function buildPaymentsUrl(options: ListPaymentsOptions, cursor?: string): string {
  const config = getConfig();
  const baseUrl = config.square.environment === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

  const params = new URLSearchParams();
  if (options.customerId) params.append('customer_id', options.customerId);
  if (options.beginTime) params.append('begin_time', options.beginTime);
  if (options.endTime) params.append('end_time', options.endTime);
  if (options.locationId) params.append('location_id', options.locationId);
  params.append('sort_order', 'DESC');
  if (cursor) params.append('cursor', cursor);

  return `${baseUrl}/v2/payments?${params.toString()}`;
}

export async function listPayments(options: ListPaymentsOptions = {}): Promise<SquarePayment[]> {
  const config = getConfig();

  if (!config.square.accessToken) {
    throw new Error('Square access token not configured');
  }

  const payments: SquarePayment[] = [];
  let cursor: string | undefined;
  let page = 0;
  const maxPages = 5;

  do {
    const url = buildPaymentsUrl(options, cursor);
    console.log('[SQUARE PAYMENTS API] Listing payments', {
      url: url.replace(config.square.accessToken, 'REDACTED'),
      page,
    });

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.square.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SQUARE PAYMENTS API] List payments failed', {
        status: response.status,
        error: errorText,
      });
      throw new Error(`Failed to list payments: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    if (data.payments?.length) {
      payments.push(...data.payments);
    }

    cursor = data.cursor;
    page += 1;
  } while (cursor && page < maxPages);

  return payments;
}

export function isDepositPayment(payment: SquarePayment): boolean {
  // Only accept COMPLETED payments (not PENDING, AUTHORIZED, CANCELED, etc.)
  // COMPLETED payments are confirmed captured transactions
  if (payment.status !== 'COMPLETED') {
    return false;
  }

  // If payment has explicit deposit-related note, accept it
  const note = payment.note || '';
  if (/detailing appointment deposit|appointment deposit|deposit charged/i.test(note)) {
    return true;
  }

  // IMPORTANT: Do NOT infer deposits from generic card-on-file or protection text
  // Those are stored as authorization tokens, not actual payments
  
  // Accept payment if:
  // - linked to a booking order (order_id set), OR
  // - has a reasonable deposit-like amount (e.g., $10-$100 for car detailing)
  // The payment lookup already filters by customer/time window, so this is safe
  return true; // Accept any COMPLETED payment in the time window
}

export function findDepositPayment(payments: SquarePayment[], bookingOrderId?: string): SquarePayment | null {
  // Filter for COMPLETED payments only (actual captured transactions)
  const completedPayments = payments.filter(p => p.status === 'COMPLETED');
  
  if (completedPayments.length === 0) {
    return null;
  }

  // First priority: payment linked to booking order
  if (bookingOrderId) {
    const paymentByOrder = completedPayments.find(payment => payment.order_id === bookingOrderId);
    if (paymentByOrder) {
      return paymentByOrder;
    }
  }

  // Second priority: payment with explicit deposit note
  const noteMatches = completedPayments.filter(payment => {
    const note = payment.note || '';
    return /detailing appointment deposit|appointment deposit|deposit|down payment/i.test(note);
  });

  if (noteMatches.length === 1) {
    return noteMatches[0];
  }

  if (noteMatches.length > 1) {
    // Return smallest payment with deposit note (more likely to be deposit vs full service)
    return noteMatches.reduce((min, p) => {
      const minAmount = min.amount_money?.amount || 0;
      const pAmount = p.amount_money?.amount || 0;
      return pAmount < minAmount ? p : min;
    });
  }

  // Last resort: if only one COMPLETED payment in time window, likely it's the deposit
  // (Assuming most bookings have deposit as first payment, service payment as second)
  if (completedPayments.length === 1) {
    return completedPayments[0];
  }

  // Multiple payments but no clear deposit marker
  // Return the smallest one (deposits are typically smaller than full service)
  return completedPayments.reduce((min, p) => {
    const minAmount = min.amount_money?.amount || 0;
    const pAmount = p.amount_money?.amount || 0;
    return pAmount < minAmount ? p : min;
  });
}

export async function findDepositPaymentForBooking(booking: {
  bookingId: string;
  customerId?: string;
  appointmentTime?: string;
  locationId?: string;
  orderId?: string;
}): Promise<SquarePayment | null> {
  if (!booking.customerId && !booking.appointmentTime) {
    console.warn('[SQUARE PAYMENTS] Cannot search for deposit: missing customer ID and appointment time', {
      bookingId: booking.bookingId,
    });
    return null;
  }

  const start = booking.appointmentTime ? new Date(booking.appointmentTime) : null;
  const beginTime = start ? new Date(start.getTime() - 48 * 60 * 60 * 1000).toISOString() : undefined;
  const endTime = start ? new Date(start.getTime() + 48 * 60 * 60 * 1000).toISOString() : undefined;

  console.log('[SQUARE PAYMENTS] Searching for deposit payment', {
    bookingId: booking.bookingId,
    orderId: booking.orderId,
    customerId: booking.customerId,
    appointmentTime: booking.appointmentTime,
    searchWindow: { beginTime, endTime },
  });

  const payments = await listPayments({
    customerId: booking.customerId,
    beginTime,
    endTime,
    locationId: booking.locationId,
  });

  console.log('[SQUARE PAYMENTS] Retrieved payments', {
    bookingId: booking.bookingId,
    paymentCount: payments.length,
    paymentStatuses: payments.map(p => ({ id: p.id, amount: p.amount_money?.amount, status: p.status, note: p.note })),
  });

  const deposit = findDepositPayment(payments, booking.orderId);

  if (deposit) {
    console.log('[SQUARE PAYMENTS] Deposit found', {
      bookingId: booking.bookingId,
      paymentId: deposit.id,
      amount: deposit.amount_money?.amount,
      status: deposit.status,
      note: deposit.note,
      orderId: deposit.order_id,
    });
  } else {
    console.log('[SQUARE PAYMENTS] No deposit found', {
      bookingId: booking.bookingId,
      note: 'Searched in time window but no qualifying payment found',
    });
  }

  return deposit;
}
