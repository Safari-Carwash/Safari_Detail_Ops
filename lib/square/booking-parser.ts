/**
 * Square Booking Parser
 * 
 * Parses Square booking webhook events and extracts relevant job information.
 */

import type { SquareBookingWebhook } from '../types';

/**
 * Parsed booking data for job creation
 */
export interface ParsedBooking {
  bookingId: string;
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  serviceType?: string; // Service name (for display)
  serviceVariationId?: string; // Service variation ID (for pricing)
  appointmentTime?: string;
  status: string;
  notes?: string;
  locationId?: string;
  sellerId?: string;
  version?: number;
  orderId?: string; // Square order ID associated with the booking (deposit/payment)
}

/**
 * Parse Square booking webhook event
 * 
 * @param event - Square booking webhook event
 * @returns Parsed booking data
 */
export function parseBookingEvent(event: SquareBookingWebhook): ParsedBooking {
  const booking = event.data?.object?.booking;
  
  if (!booking) {
    throw new Error('Invalid booking webhook: missing booking object');
  }

  // NOTE: Square webhooks do NOT include customer details (name, email, phone)
  // Only customer_id is provided. To get customer details, we need to:
  // TODO Phase C: Implement Square Customers API call using customer_id
  // For now, customer name will be set to a placeholder in job-service.ts
  
  // Parse appointment time
  const startAt = booking.start_at;
  
  // Extract service information from appointment segments
  const segments = booking.appointment_segments || [];
  const serviceVariationId = segments.length > 0 
    ? segments[0].service_variation_id 
    : undefined;

  return {
    bookingId: booking.id,
    customerId: booking.customer_id,
    customerName: undefined, // Not included in webhook - need to fetch from API
    customerEmail: undefined, // Not included in webhook - need to fetch from API
    customerPhone: undefined, // Not included in webhook - need to fetch from API
    serviceType: undefined, // Will be enriched with service name
    serviceVariationId, // Keep variation ID for pricing
    appointmentTime: startAt,
    status: booking.status || 'PENDING',
    notes: booking.customer_note,
    locationId: booking.location_id,
    sellerId: booking.seller_id,
    version: booking.version,
  };
}

/**
 * Determine if booking event should create or update a job
 * 
 * @param eventType - Webhook event type
 * @returns Action to take ('create' | 'update' | 'skip')
 */
export function determineBookingAction(eventType: string): 'create' | 'update' | 'skip' {
  switch (eventType) {
    case 'booking.created':
      return 'create';
    case 'booking.updated':
      return 'update';
    default:
      return 'skip';
  }
}

/**
 * Validate parsed booking has required fields
 * 
 * @param booking - Parsed booking data
 * @returns true if valid, false otherwise
 */
export function isValidBooking(booking: ParsedBooking): boolean {
  return !!(
    booking.bookingId &&
    booking.appointmentTime &&
    booking.status
  );
}
