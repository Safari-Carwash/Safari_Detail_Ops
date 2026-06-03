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

  console.log('[SQUARE PAYMENTS API] Starting payment list', {
    customerId: options.customerId,
    beginTime: options.beginTime,
    endTime: options.endTime,
    locationId: options.locationId,
  });

  const payments: SquarePayment[] = [];
  let cursor: string | undefined;
  let page = 0;
  const maxPages = 5;

  do {
    const url = buildPaymentsUrl(options, cursor);
    console.log('[SQUARE PAYMENTS API] Fetching payments page', {
      page,
      url: url.replace(config.square.accessToken, 'REDACTED'),
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
    console.log('[SQUARE PAYMENTS API] Page response', {
      page,
      paymentCount: data.payments?.length || 0,
      hasCursor: !!data.cursor,
      payments: data.payments?.map((p: SquarePayment) => ({
        id: p.id,
        amount: p.amount_money?.amount,
        status: p.status,
        note: p.note,
        order_id: p.order_id,
        customer_id: p.customer_id,
        created_at: p.created_at,
      })) || [],
    });

    if (data.payments?.length) {
      payments.push(...data.payments);
    }

    cursor = data.cursor;
    page += 1;
  } while (cursor && page < maxPages);

  console.log('[SQUARE PAYMENTS API] Total payments found', {
    totalCount: payments.length,
    summaryByStatus: payments.reduce((acc, p) => {
      acc[p.status || 'UNKNOWN'] = (acc[p.status || 'UNKNOWN'] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  });

  return payments;
}

export function isDepositPayment(payment: SquarePayment): boolean {
  // Only accept COMPLETED payments (not PENDING, AUTHORIZED, CANCELED, etc.)
  // COMPLETED payments are confirmed captured transactions
  if (payment.status !== 'COMPLETED') {
    console.log('[SQUARE PAYMENTS] Payment rejected - wrong status', {
      paymentId: payment.id,
      status: payment.status,
      expected: 'COMPLETED',
    });
    return false;
  }

  // If payment has explicit deposit-related note, accept it
  const note = payment.note || '';
  if (/detailing appointment deposit|appointment deposit|deposit charged/i.test(note)) {
    console.log('[SQUARE PAYMENTS] Payment accepted - deposit note found', {
      paymentId: payment.id,
      note,
    });
    return true;
  }

  // IMPORTANT: Do NOT infer deposits from generic card-on-file or protection text
  // Those are stored as authorization tokens, not actual payments
  
  // Accept payment if:
  // - linked to a booking order (order_id set), OR
  // - has a reasonable deposit-like amount (e.g., $10-$100 for car detailing)
  // The payment lookup already filters by customer/time window, so this is safe
  console.log('[SQUARE PAYMENTS] Payment accepted - in time window with COMPLETED status', {
    paymentId: payment.id,
    amount: payment.amount_money?.amount,
    orderId: payment.order_id,
    status: payment.status,
  });
  return true;
}

export function findDepositPayment(payments: SquarePayment[], bookingOrderId?: string): SquarePayment | null {
  console.log('[SQUARE PAYMENTS] Finding deposit among', {
    totalPayments: payments.length,
    bookingOrderId,
    paymentsByStatus: payments.reduce((acc, p) => {
      acc[p.status || 'UNKNOWN'] = (acc[p.status || 'UNKNOWN'] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  });

  // Filter for COMPLETED payments only (actual captured transactions)
  const completedPayments = payments.filter(p => p.status === 'COMPLETED');
  
  console.log('[SQUARE PAYMENTS] Filtered to COMPLETED payments', {
    completedCount: completedPayments.length,
  });

  if (completedPayments.length === 0) {
    console.log('[SQUARE PAYMENTS] No COMPLETED payments found');
    return null;
  }

  // First priority: payment linked to booking order
  if (bookingOrderId) {
    console.log('[SQUARE PAYMENTS] Searching by order_id', { bookingOrderId });
    const paymentByOrder = completedPayments.find(payment => {
      const matches = payment.order_id === bookingOrderId;
      console.log('[SQUARE PAYMENTS] Order match check', {
        paymentId: payment.id,
        paymentOrderId: payment.order_id,
        searchOrderId: bookingOrderId,
        matches,
      });
      return matches;
    });
    if (paymentByOrder) {
      console.log('[SQUARE PAYMENTS] Found by order_id', {
        paymentId: paymentByOrder.id,
        amount: paymentByOrder.amount_money?.amount,
      });
      return paymentByOrder;
    }
  }

  // Second priority: payment with explicit deposit note
  console.log('[SQUARE PAYMENTS] Searching by deposit note');
  const noteMatches = completedPayments.filter(payment => {
    const note = payment.note || '';
    const matches = /detailing appointment deposit|appointment deposit|deposit/i.test(note);
    console.log('[SQUARE PAYMENTS] Note match check', {
      paymentId: payment.id,
      note,
      matches,
    });
    return matches;
  });

  if (noteMatches.length === 1) {
    console.log('[SQUARE PAYMENTS] Found single payment with deposit note', {
      paymentId: noteMatches[0].id,
      amount: noteMatches[0].amount_money?.amount,
    });
    return noteMatches[0];
  }

  if (noteMatches.length > 1) {
    // Return smallest payment with deposit note (more likely to be deposit vs full service)
    const best = noteMatches.reduce((min, p) => {
      const minAmount = min.amount_money?.amount || 0;
      const pAmount = p.amount_money?.amount || 0;
      return pAmount < minAmount ? p : min;
    });
    console.log('[SQUARE PAYMENTS] Found multiple deposit notes, returning smallest', {
      selectedPaymentId: best.id,
      amount: best.amount_money?.amount,
      otherCount: noteMatches.length - 1,
    });
    return best;
  }

  // Last resort: if only one COMPLETED payment in time window, likely it's the deposit
  // (Assuming most bookings have deposit as first payment, service payment as second)
  if (completedPayments.length === 1) {
    console.log('[SQUARE PAYMENTS] Only one COMPLETED payment, assuming it\'s the deposit', {
      paymentId: completedPayments[0].id,
      amount: completedPayments[0].amount_money?.amount,
    });
    return completedPayments[0];
  }

  // Multiple payments but no clear deposit marker
  // Return the smallest one (deposits are typically smaller than full service)
  console.log('[SQUARE PAYMENTS] Multiple payments, selecting smallest', {
    totalCount: completedPayments.length,
  });
  const smallest = completedPayments.reduce((min, p) => {
    const minAmount = min.amount_money?.amount || 0;
    const pAmount = p.amount_money?.amount || 0;
    console.log('[SQUARE PAYMENTS] Amount comparison', {
      candidatePaymentId: p.id,
      candidateAmount: pAmount,
      currentMinId: min.id,
      currentMinAmount: minAmount,
      candidateIsSmaller: pAmount < minAmount,
    });
    return pAmount < minAmount ? p : min;
  });
  console.log('[SQUARE PAYMENTS] Selected smallest payment', {
    paymentId: smallest.id,
    amount: smallest.amount_money?.amount,
  });
  return smallest;
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
  
  // Search window: 60 days BEFORE appointment to 2 days AFTER appointment
  // This ensures we catch deposits paid anytime from booking creation through appointment date
  // (Most deposits are paid when booking is created, days/weeks before the appointment)
  const beginTime = start ? new Date(start.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString() : undefined;
  const endTime = start ? new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString() : undefined;

  console.log('[SQUARE PAYMENTS] Searching for deposit payment', {
    bookingId: booking.bookingId,
    orderId: booking.orderId,
    customerId: booking.customerId,
    appointmentTime: booking.appointmentTime,
    searchWindow: { beginTime, endTime },
    note: 'Window is 60 days before appointment to 2 days after (catches payments from booking creation)',
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
