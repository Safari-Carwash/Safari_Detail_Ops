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
  const note = payment.note || '';
  return /detailing appointment deposit|appointment deposit|deposit charged/i.test(note);
}

export function findDepositPayment(payments: SquarePayment[], bookingOrderId?: string): SquarePayment | null {
  const noteMatches = payments.filter(isDepositPayment);
  if (noteMatches.length === 1) {
    return noteMatches[0];
  }

  if (noteMatches.length > 1) {
    return noteMatches[0];
  }

  if (bookingOrderId) {
    const paymentByOrder = payments.find(payment => payment.order_id === bookingOrderId);
    if (paymentByOrder) {
      return paymentByOrder;
    }
  }

  return null;
}

export async function findDepositPaymentForBooking(booking: {
  bookingId: string;
  customerId?: string;
  appointmentTime?: string;
  locationId?: string;
  orderId?: string;
}): Promise<SquarePayment | null> {
  if (!booking.customerId && !booking.appointmentTime) {
    return null;
  }

  const start = booking.appointmentTime ? new Date(booking.appointmentTime) : null;
  const beginTime = start ? new Date(start.getTime() - 48 * 60 * 60 * 1000).toISOString() : undefined;
  const endTime = start ? new Date(start.getTime() + 48 * 60 * 60 * 1000).toISOString() : undefined;

  const payments = await listPayments({
    customerId: booking.customerId,
    beginTime,
    endTime,
    locationId: booking.locationId,
  });

  return findDepositPayment(payments, booking.orderId);
}
