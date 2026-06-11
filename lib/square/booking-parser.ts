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
  // Structured add-on names parsed from seller_note or structured booking data
  addonNames?: string[];
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

/**
 * Parse add-on names from a Square seller_note or appointment note.
 *
 * Handles both formats produced by the Safari website:
 *   - "ADD-ONS (customer selected):\n• Odor Eliminator\n• Disinfectant Service"
 *   - "✅ ADD-ONS REQUESTED:\n• Odor Eliminator"
 *
 * Bullet styles supported: •  -  *
 *
 * Parsing stops at the first blank line or when a known stop phrase is encountered:
 *   "Add-ons not charged today", "Collect add-on payment at service time",
 *   "CARD ON FILE", "Vehicle:", "Pricing note"
 *
 * @param note - Raw seller_note or appointment note string from Square
 * @returns Deduplicated, trimmed add-on names; empty array when none found
 */
export function parseAddonsFromSellerNote(note: string | undefined): string[] {
  if (!note) return [];

  const STOP_PHRASES = [
    'add-ons not charged today',
    'collect add-on payment at service time',
    'card on file',
    'vehicle:',
    'pricing note',
  ];

  const lines = note.split('\n');
  const addons: string[] = [];
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!inSection) {
      // Detect the add-ons section heading (both legacy and current formats)
      const isHeading =
        /ADD[-\s]ONS\s+\(customer\s+selected\)\s*:/i.test(line) ||
        /[✅✓]?\s*ADD[-\s]ONS\s+REQUESTED\s*:/i.test(line);

      if (isHeading) {
        inSection = true;
      }
      continue;
    }

    // Stop on blank line
    if (line === '') break;

    // Stop on known stop phrases
    const lowerLine = line.toLowerCase();
    if (STOP_PHRASES.some(phrase => lowerLine.includes(phrase))) break;

    // Accept bullet lines (•, -, *)
    if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
      const name = line.replace(/^[•\-*]\s*/, '').trim();
      if (name) addons.push(name);
    }
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  return addons.filter(name => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
