/**
 * Reconciliation Service
 * 
 * Reconciles Square bookings with DynamoDB jobs to ensure data consistency.
 * Acts as a safety net for missed webhooks.
 * 
 * SAFETY RULES:
 * - Only updates Square-derived fields (booking metadata)
 * - NEVER overwrites staff-updated fields (workStatus, checklist, photos, etc.)
 * - Uses bookingId as unique key to prevent duplicates
 * - Idempotent: can be run multiple times safely
 */

import * as dynamodb from '../aws/dynamodb';
import { listAllBookings } from '../square/bookings-api';
import type { SquareBooking } from '../square/bookings-api';
import type { Job } from '../types';
import { WorkStatus } from '../types';
import { fetchCustomerWithRetry, toCustomerCached } from '../square/customers-api';
import { fetchServiceName } from '../square/catalog-api';
import * as notificationService from '../services/notification-service';

/**
 * Fields that are considered "Square-derived" and can be updated during reconciliation
 */
const SQUARE_DERIVED_FIELDS = [
  'bookingId',
  'appointmentTime',
  'serviceType',
  'customerId',
  'customerName',
  'customerEmail',
  'customerPhone',
  'customerCached',
] as const;

/**
 * Fields that are "staff-derived" and should NEVER be overwritten
 */
const STAFF_DERIVED_FIELDS = [
  'workStatus',
  'status',
  'checklist',
  'photosMeta',
  'photos',
  'receiptPhotos',
  'postCompletionIssue',
  'payment',
  'vehicleInfo',
  'notes',
  'statusHistory',
] as const;

/**
 * Reconciliation result summary
 */
export interface ReconciliationResult {
  scanned: number;
  created: number;
  updated: number;
  cancelled: number;
  skipped: number;
  errors: Array<{
    bookingId: string;
    error: string;
  }>;
  startTime: string;
  endTime: string;
  durationMs: number;
}

/**
 * Options for reconciliation
 */
export interface ReconciliationOptions {
  /**
   * Start of time range (ISO 8601)
   */
  startAtMin: string;
  
  /**
   * End of time range (ISO 8601)
   */
  startAtMax: string;
  
  /**
   * Optional location ID filter
   */
  locationId?: string;
  
  /**
   * Dry run mode (don't make any changes)
   */
  dryRun?: boolean;
}

/**
 * Reconcile Square bookings with DynamoDB jobs
 * 
 * @param options - Reconciliation options
 * @returns Summary of reconciliation results
 */
export async function reconcileBookings(
  options: ReconciliationOptions
): Promise<ReconciliationResult> {
  const startTime = new Date().toISOString();
  const startMs = Date.now();
  
  const result: ReconciliationResult = {
    scanned: 0,
    created: 0,
    updated: 0,
    cancelled: 0,
    skipped: 0,
    errors: [],
    startTime,
    endTime: '',
    durationMs: 0,
  };

  try {
    console.log('[RECONCILE] Starting reconciliation', {
      startAtMin: options.startAtMin,
      startAtMax: options.startAtMax,
      locationId: options.locationId,
      dryRun: options.dryRun || false,
    });

    // Fetch all bookings from Square for the time range
    const bookings = await listAllBookings({
      startAtMin: options.startAtMin,
      startAtMax: options.startAtMax,
      locationId: options.locationId,
    });

    result.scanned = bookings.length;

    console.log('[RECONCILE] Fetched bookings from Square', {
      count: bookings.length,
    });

    // Process each booking
    for (const booking of bookings) {
      try {
        await processBooking(booking, options.dryRun || false, result);
      } catch (error: any) {
        console.error('[RECONCILE] Error processing booking', {
          bookingId: booking.id,
          error: error.message,
        });
        
        result.errors.push({
          bookingId: booking.id,
          error: error.message,
        });
      }
    }

    const endMs = Date.now();
    result.endTime = new Date().toISOString();
    result.durationMs = endMs - startMs;

    console.log('[RECONCILE] Reconciliation complete', {
      ...result,
    });

    return result;
  } catch (error: any) {
    const endMs = Date.now();
    result.endTime = new Date().toISOString();
    result.durationMs = endMs - startMs;
    
    console.error('[RECONCILE] Reconciliation failed', {
      error: error.message,
      result,
    });

    throw error;
  }
}

/**
 * Process a single booking and sync with DynamoDB
 */
async function processBooking(
  booking: SquareBooking,
  dryRun: boolean,
  result: ReconciliationResult
): Promise<void> {
  const bookingId = booking.id;

  // Find job by bookingId
  const existingJob = await findJobByBookingId(bookingId);

  // Handle cancelled bookings
  if (isCancelledBooking(booking)) {
    if (existingJob) {
      console.log('[RECONCILE] Booking cancelled', {
        bookingId,
        jobId: existingJob.jobId,
        currentStatus: existingJob.status,
      });
      
      // Update job to CANCELLED status if not already cancelled
      if (existingJob.status !== WorkStatus.CANCELLED) {
        if (!dryRun) {
          await dynamodb.updateJob(existingJob.jobId, {
            status: WorkStatus.CANCELLED,
            cancelledAt: new Date().toISOString(),
            cancelledSource: 'square',
            cancellationReason: `Square booking status: ${booking.status}`,
            updatedBy: 'reconciliation',
          });
          console.log('[RECONCILE] Job marked as CANCELLED', {
            jobId: existingJob.jobId,
            bookingId,
          });
        } else {
          console.log('[RECONCILE] [DRY RUN] Would mark job as CANCELLED', {
            jobId: existingJob.jobId,
            bookingId,
          });
        }
      }
      result.cancelled++;
    } else {
      // Cancelled booking with no job - create it as cancelled
      console.log('[RECONCILE] Creating cancelled booking as job', {
        bookingId,
        status: booking.status,
      });
      
      if (!dryRun) {
        await createJobFromBooking(booking, dryRun, result);
        console.log('[RECONCILE] Cancelled job created', {
          bookingId,
        });
      } else {
        console.log('[RECONCILE] [DRY RUN] Would create cancelled job', {
          bookingId,
        });
        result.created++;
      }
      result.cancelled++;
    }
    return;
  }

  if (existingJob) {
    // Job exists - update Square-derived fields only
    await updateJobFromBooking(existingJob, booking, dryRun, result);
  } else {
    // Job doesn't exist - create new job
    await createJobFromBooking(booking, dryRun, result);
  }
}

/**
 * Find job by booking ID
 */
async function findJobByBookingId(bookingId: string): Promise<Job | null> {
  try {
    // Use getJobByBookingId which queries by bookingId (requires GSI or scan)
    return await dynamodb.getJobByBookingId(bookingId);
  } catch (error) {
    console.error('[RECONCILE] Error finding job by bookingId', {
      bookingId,
      error,
    });
    return null;
  }
}

/**
 * Check if booking is cancelled
 */
function isCancelledBooking(booking: SquareBooking): boolean {
  const status = booking.status?.toUpperCase();
  return status === 'CANCELLED' || status === 'DECLINED' || status === 'NO_SHOW';
}

/**
 * Create new job from Square booking
 */
async function createJobFromBooking(
  booking: SquareBooking,
  dryRun: boolean,
  result: ReconciliationResult
): Promise<void> {
  const bookingId = booking.id;
  
  console.log('[RECONCILE] Creating new job from booking', {
    bookingId,
    dryRun,
  });

  if (dryRun) {
    result.created++;
    return;
  }

  try {
    // Fetch customer details
    let customerCached;
    if (booking.customer_id) {
      const cachedData = await fetchCustomerWithRetry(booking.customer_id, 1);
      if (cachedData) {
        customerCached = cachedData;
      }
    }

    // Get service name
    const serviceType = await getServiceName(booking);

    // Create job with minimal data
    const newJob: Job = {
      jobId: generateJobId(),
      bookingId,
      customerId: booking.customer_id || '',
      customerName: customerCached?.name || `Customer ${booking.customer_id?.substring(0, 8) || 'Unknown'}`,
      customerEmail: customerCached?.email,
      customerPhone: customerCached?.phone,
      customerCached,
      vehicleInfo: {},
      serviceType,
      status: WorkStatus.SCHEDULED,
      workStatus: WorkStatus.SCHEDULED,
      appointmentTime: booking.start_at || new Date().toISOString(),
      photos: [],
      photosMeta: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: 'reconciliation',
    };

    await dynamodb.createJob(newJob);
    
    result.created++;
    
    console.log('[RECONCILE] Job created', {
      jobId: newJob.jobId,
      bookingId,
    });

    // Generate "New Booking" notification for reconciliation-created jobs
    // Skip notification if job is already cancelled (don't notify about cancelled bookings as "new")
    if (newJob.status !== WorkStatus.CANCELLED) {
      try {
        const notification = await notificationService.notifyJobCreated(
          newJob,
          'square',
          undefined, // No Square event_id for reconciliation jobs
          undefined  // No actor email for reconciliation
        );
        
        if (notification) {
          console.log('[RECONCILE] Notification created for reconciliation job', {
            jobId: newJob.jobId,
            bookingId,
            notificationId: notification.notificationId,
          });
        } else {
          console.log('[RECONCILE] Notification skipped (possible duplicate)', {
            jobId: newJob.jobId,
            bookingId,
          });
        }
      } catch (notificationError: any) {
        // Don't fail reconciliation if notification creation fails
        console.error('[RECONCILE] Failed to create notification for job', {
          jobId: newJob.jobId,
          bookingId,
          error: notificationError.message,
          stack: notificationError.stack,
        });
      }
    } else {
      console.log('[RECONCILE] Skipped notification for cancelled job', {
        jobId: newJob.jobId,
        bookingId,
        reason: 'Job is already cancelled',
      });
    }
  } catch (error: any) {
    console.error('[RECONCILE] Failed to create job', {
      bookingId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Update existing job from Square booking
 * Only updates Square-derived fields
 */
async function updateJobFromBooking(
  existingJob: Job,
  booking: SquareBooking,
  dryRun: boolean,
  result: ReconciliationResult
): Promise<void> {
  const bookingId = booking.id;
  const jobId = existingJob.jobId;

  // Build updates object with only Square-derived fields
  const updates: Partial<Job> = {};
  let hasChanges = false;

  // Update appointment time if changed
  if (booking.start_at && booking.start_at !== existingJob.appointmentTime) {
    updates.appointmentTime = booking.start_at;
    hasChanges = true;
  }

  // Refresh customer cache if stale or missing
  if (booking.customer_id) {
    const shouldRefreshCustomer = 
      !existingJob.customerCached || 
      isCacheStale(existingJob.customerCached.cachedAt);

    if (shouldRefreshCustomer) {
      const cachedData = await fetchCustomerWithRetry(booking.customer_id, 1);
      if (cachedData) {
        updates.customerCached = cachedData;
        updates.customerName = cachedData.name;
        updates.customerEmail = cachedData.email;
        updates.customerPhone = cachedData.phone;
        hasChanges = true;
      }
    }
  }

  // Update service type if changed
  const serviceType = await getServiceName(booking);
  if (serviceType && serviceType !== existingJob.serviceType) {
    updates.serviceType = serviceType;
    hasChanges = true;
  }

  if (!hasChanges) {
    result.skipped++;
    return;
  }

  console.log('[RECONCILE] Updating job from booking', {
    jobId,
    bookingId,
    updates: Object.keys(updates),
    dryRun,
  });

  if (dryRun) {
    result.updated++;
    return;
  }

  try {
    updates.updatedBy = 'reconciliation';
    updates.updatedAt = new Date().toISOString();
    
    await dynamodb.updateJob(jobId, updates);
    
    result.updated++;
    
    console.log('[RECONCILE] Job updated', {
      jobId,
      bookingId,
    });
  } catch (error: any) {
    console.error('[RECONCILE] Failed to update job', {
      jobId,
      bookingId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get service name from booking
 */
async function getServiceName(booking: SquareBooking): Promise<string> {
  const segments = booking.appointment_segments || [];
  if (segments.length > 0 && segments[0].service_variation_id) {
    try {
      const serviceName = await fetchServiceName(segments[0].service_variation_id);
      if (serviceName) {
        return serviceName;
      }
    } catch (error) {
      console.error('[RECONCILE] Failed to fetch service name', {
        variationId: segments[0].service_variation_id,
        error,
      });
    }
  }
  return 'Detail Service';
}

/**
 * Generate a unique job ID
 */
function generateJobId(): string {
  // Use timestamp + random string for uniqueness
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Check if customer cache is stale (older than 24 hours)
 */
function isCacheStale(cachedAt?: string): boolean {
  if (!cachedAt) return true;
  const cacheTime = new Date(cachedAt).getTime();
  const now = Date.now();
  const hoursSinceCached = (now - cacheTime) / (1000 * 60 * 60);
  return hoursSinceCached > 24;
}

/**
 * Get time range for "today" reconciliation
 * Returns start and end of current day in ISO 8601 format
 */
export function getTodayTimeRange(): { startAtMin: string; startAtMax: string } {
  const now = new Date();
  
  // Start of today (00:00:00 local time)
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  // End of today (23:59:59 local time)
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  return {
    startAtMin: startOfDay.toISOString(),
    startAtMax: endOfDay.toISOString(),
  };
}

/**
 * Get time range with buffer (yesterday to tomorrow)
 * Useful for catching bookings near day boundaries
 */
export function getTimeRangeWithBuffer(): { startAtMin: string; startAtMax: string } {
  const now = new Date();
  
  // Yesterday start
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  
  // Tomorrow end
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59, 59);

  return {
    startAtMin: yesterday.toISOString(),
    startAtMax: tomorrow.toISOString(),
  };
}
