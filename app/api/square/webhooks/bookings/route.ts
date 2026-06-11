/**
 * Square Webhooks - Bookings Endpoint - Phase B (Next.js API Route)
 * 
 * POST /api/square/webhooks/bookings
 * 
 * Receives webhook events from Square for booking.created, booking.updated, booking.canceled
 * 
 * QA MODE: GET/HEAD/POST all return 200 OK to allow Square webhook subscription creation
 * 
 * Phase B: Full implementation with:
 * - Signature verification
 * - Booking parsing
 * - DynamoDB integration
 * - Idempotent job creation/updates
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import type { ApiResponse, SquareBookingWebhook } from '@/lib/types';
import { 
  validateWebhookSignature, 
  extractSignature, 
  buildWebhookUrl 
} from '@/lib/square/webhook-validator';
import {
  parseBookingEvent,
  determineBookingAction,
  isValidBooking,
  parseAddonsFromSellerNote
} from '@/lib/square/booking-parser';
import {
  fetchCustomerDetails,
  formatCustomerName,
  extractCustomerContact
} from '@/lib/square/customers-api';
import {
  fetchServiceName
} from '@/lib/square/catalog-api';
import { 
  retrieveBooking 
} from '@/lib/square/bookings-api';
import {
  retrieveOrder
} from '@/lib/square/orders-api';
import { 
  createJobFromBooking, 
  updateJobFromBooking 
} from '@/lib/services/job-service';
import { getJobByBookingId, getJob } from '@/lib/aws/dynamodb';
import * as notificationService from '@/lib/services/notification-service';

/**
 * GET handler - Square webhook UI validation
 * Returns 200 OK to allow webhook subscription creation
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  console.log('[WEBHOOK GET]', {
    url: request.url,
    method: 'GET',
    timestamp: new Date().toISOString(),
  });
  
  return new NextResponse('OK', { 
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}

/**
 * HEAD handler - Square webhook UI validation
 * Returns 200 OK with no body
 */
export async function HEAD(request: NextRequest): Promise<NextResponse> {
  console.log('[WEBHOOK HEAD]', {
    url: request.url,
    method: 'HEAD',
    timestamp: new Date().toISOString(),
  });
  
  return new NextResponse(null, { status: 200 });
}

/**
 * POST handler - Actual webhook receiver
 * Wrapped to never throw, always returns 200 OK in QA mode
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Get configuration (outside try block for error handler access)
  const appConfig = getConfig();
  
  try {
    // Read raw body for signature verification
    const rawBody = await request.text();
    
    // Log request details (non-sensitive)
    console.log('[WEBHOOK POST]', {
      url: request.url,
      method: 'POST',
      bodyLength: rawBody.length,
      hasContentType: request.headers.has('content-type'),
      contentType: request.headers.get('content-type'),
      hasSignature: request.headers.has('x-square-hmacsha256-signature'),
      timestamp: new Date().toISOString(),
    });
    
    // Convert Next.js Headers to plain object for extractSignature
    const headersObj: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headersObj[key.toLowerCase()] = value;
    });
    
    // Phase B: Signature Verification
    const signature = extractSignature(headersObj);
    
    if (signature && appConfig.square.webhookSignatureKey) {
      const host = request.headers.get('host') || '';
      const url = buildWebhookUrl(host, request.nextUrl.pathname);
      
      const isValid = validateWebhookSignature(
        rawBody,
        signature,
        appConfig.square.webhookSignatureKey,
        url
      );
      
      if (!isValid) {
        console.error('[WEBHOOK SIGNATURE INVALID]', {
          url,
          hasBody: rawBody.length > 0,
        });
        
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'INVALID_SIGNATURE',
            message: 'Webhook signature validation failed',
          },
          timestamp: new Date().toISOString(),
        };
        
        return NextResponse.json(response, { status: 401 });
      }
      
      console.log('[WEBHOOK SIGNATURE VALID]');
    } else {
      console.warn('[WEBHOOK SIGNATURE SKIPPED]', {
        hasSignature: !!signature,
        hasKey: !!appConfig.square.webhookSignatureKey,
        environment: appConfig.env,
      });
      
      // In production, reject if no signature
      if (appConfig.env === 'prod' && !signature) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'MISSING_SIGNATURE',
            message: 'Webhook signature required in production',
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 401 });
      }
    }

    // Parse webhook payload
    let webhookEvent: SquareBookingWebhook;
    try {
      webhookEvent = JSON.parse(rawBody);
    } catch (parseError) {
      console.error('[WEBHOOK PARSE ERROR]', { error: parseError });
      throw new Error('Invalid JSON in webhook body');
    }

    // Determine action based on event type
    const action = determineBookingAction(webhookEvent.type);
    
    if (action === 'skip') {
      console.log('[WEBHOOK SKIPPED]', {
        eventId: webhookEvent.event_id,
        eventType: webhookEvent.type,
        reason: 'Unsupported event type',
      });
      
      const response: ApiResponse = {
        success: true,
        data: {
          message: 'Event acknowledged but not processed',
          eventId: webhookEvent.event_id,
          eventType: webhookEvent.type,
          processed: false,
        },
        timestamp: new Date().toISOString(),
      };
      
      return NextResponse.json(response, { status: 200 });
    }

    // Parse booking details
    let parsedBooking;
    try {
      parsedBooking = parseBookingEvent(webhookEvent);
    } catch (parseError: any) {
      console.error('[BOOKING PARSE ERROR]', {
        eventId: webhookEvent.event_id,
        error: parseError.message,
      });
      
      throw new Error(`Failed to parse booking: ${parseError.message}`);
    }

    // Validate parsed booking
    if (!isValidBooking(parsedBooking)) {
      console.error('[BOOKING VALIDATION FAILED]', {
        eventId: webhookEvent.event_id,
        booking: parsedBooking,
      });
      
      throw new Error('Booking validation failed: missing required fields');
    }

    // Enrich booking with COMPLETE booking details from Square API
    // This is critical for getting the full customer_note with add-ons
    try {
      // Add a small delay to ensure Square has fully saved the booking
      // Webhooks may fire before all fields are persisted
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const fullBooking = await retrieveBooking(parsedBooking.bookingId);
      
      if (fullBooking) {
        // Enrich serviceVariationId from fullBooking if not in webhook
        if (!parsedBooking.serviceVariationId && fullBooking.appointment_segments && fullBooking.appointment_segments.length > 0) {
          parsedBooking.serviceVariationId = fullBooking.appointment_segments[0].service_variation_id;
          console.log('[SERVICE VARIATION ID ENRICHED]', {
            bookingId: parsedBooking.bookingId,
            variationId: parsedBooking.serviceVariationId,
          });
        }
        
        // Start with the customer_note from Square
        let completeNotes = fullBooking.customer_note || '';
        
        console.log('[BOOKING ENRICHMENT] Initial notes', {
          bookingId: parsedBooking.bookingId,
          notesLength: completeNotes.length,
          hasOrderId: !!fullBooking.order_id,
          orderId: fullBooking.order_id,
          hasSellerNote: !!fullBooking.seller_note,
          sellerNoteLength: fullBooking.seller_note?.length || 0,
        });

        if (fullBooking.order_id) {
          parsedBooking.orderId = fullBooking.order_id;
        }
        
        // --- Structured add-on extraction from seller_note ---
        // The Safari website writes add-on names into the Square seller_note in this format:
        //   ADD-ONS (customer selected):
        //   • Odor Eliminator
        //   • Disinfectant Service
        //
        // Parse this into a structured addonNames array (priority 1 source).
        if (fullBooking.seller_note) {
          const parsedAddonNames = parseAddonsFromSellerNote(fullBooking.seller_note);

          if (parsedAddonNames.length > 0) {
            parsedBooking.addonNames = parsedAddonNames;

            console.log('[ADD-ONS PARSED FROM SELLER NOTE]', {
              bookingId: parsedBooking.bookingId,
              count: parsedAddonNames.length,
              names: parsedAddonNames,
            });
          } else {
            console.log('[ADD-ONS] No add-ons found in seller_note', {
              bookingId: parsedBooking.bookingId,
              sellerNotePreview: fullBooking.seller_note.substring(0, 200),
            });
          }
        }
        
        // Check if booking has associated order with line items (add-ons)
        if (fullBooking.order_id) {
          try {
            const order = await retrieveOrder(fullBooking.order_id);
            
            if (order && order.line_items && order.line_items.length > 0) {
              console.log('[ORDER FETCHED]', {
                orderId: order.id,
                lineItemCount: order.line_items.length,
              });
              
              // Extract add-on names from line items
              // Filter out the main service (service items are in appointment_segments)
              const serviceVariationIds = fullBooking.appointment_segments?.map(
                seg => seg.service_variation_id
              ) || [];
              
              const addonItems = order.line_items.filter(item => 
                item.catalog_object_id && 
                !serviceVariationIds.includes(item.catalog_object_id)
              );
              
              if (addonItems.length > 0) {
                const orderAddonNames = addonItems
                  .map(item => item.name || 'Unknown Add-on')
                  .filter(name => name);
                
                // Only use order add-ons if seller_note didn't already produce structured add-ons
                if (!parsedBooking.addonNames || parsedBooking.addonNames.length === 0) {
                  parsedBooking.addonNames = orderAddonNames;

                  console.log('[ADD-ONS EXTRACTED FROM ORDER]', {
                    bookingId: parsedBooking.bookingId,
                    orderId: order.id,
                    addonCount: orderAddonNames.length,
                    addons: orderAddonNames,
                  });
                } else {
                  console.log('[ADD-ONS FROM ORDER SKIPPED - seller_note already parsed]', {
                    bookingId: parsedBooking.bookingId,
                    existingCount: parsedBooking.addonNames.length,
                  });
                }
              } else {
                console.log('[NO ADD-ONS IN ORDER]', {
                  bookingId: parsedBooking.bookingId,
                  orderId: order.id,
                  note: 'All line items are main services',
                });
              }
            }
          } catch (orderError: any) {
            console.warn('[ORDER FETCH FAILED]', {
              orderId: fullBooking.order_id,
              error: orderError.message,
              note: 'Continuing without add-ons',
            });
          }
        }
        
        // Update notes with complete customer_note content
        if (completeNotes) {
          parsedBooking.notes = completeNotes;
          console.log('[BOOKING NOTES ENRICHED]', {
            bookingId: parsedBooking.bookingId,
            notesLength: completeNotes.length,
            notesPreview: completeNotes.substring(0, 100),
          });
        } else {
          console.warn('[BOOKING NOTES EMPTY]', {
            bookingId: parsedBooking.bookingId,
            note: 'Square API returned booking but customer_note is empty and no order',
          });
        }

        // Structured logging for add-on ingestion
        console.log('[ADDON INGESTION SUMMARY]', {
          squareBookingId: parsedBooking.bookingId,
          bookingSource: 'website',
          structuredAddonCount: parsedBooking.addonNames?.length ?? 0,
          parsedAddonCount: 0, // reserved for future Square-note-only path
          finalAddonNames: parsedBooking.addonNames ?? [],
        });
      } else {
        console.warn('[BOOKING NOT FOUND]', {
          bookingId: parsedBooking.bookingId,
          note: 'retrieveBooking returned null',
        });
      }
    } catch (bookingError: any) {
      console.warn('[BOOKING FETCH FAILED]', {
        bookingId: parsedBooking.bookingId,
        error: bookingError.message,
        note: 'Continuing with webhook notes only',
      });
      // Continue processing - will use partial notes from webhook
    }

    // Enrich booking with customer details from Square API
    if (parsedBooking.customerId) {
      try {
        const customer = await fetchCustomerDetails(parsedBooking.customerId);
        
        if (customer) {
          // Update parsed booking with customer details
          parsedBooking.customerName = formatCustomerName(customer);
          const contact = extractCustomerContact(customer);
          parsedBooking.customerEmail = contact.email;
          parsedBooking.customerPhone = contact.phone;
          
          console.log('[CUSTOMER ENRICHED]', {
            customerId: parsedBooking.customerId,
            customerName: parsedBooking.customerName,
            hasEmail: !!contact.email,
            hasPhone: !!contact.phone,
          });
        }
      } catch (customerError: any) {
        console.warn('[CUSTOMER FETCH FAILED]', {
          customerId: parsedBooking.customerId,
          error: customerError.message,
          note: 'Continuing with booking ID only',
        });
        // Continue processing - customer name will be 'Unknown Customer'
      }
    }

    // Enrich booking with service name from Square Catalog API
    if (parsedBooking.serviceVariationId) {
      try {
        const serviceName = await fetchServiceName(parsedBooking.serviceVariationId);
        
        console.log('[SERVICE ENRICHED]', {
          variationId: parsedBooking.serviceVariationId,
          serviceName,
        });
        
        // Set service name for display (keep serviceVariationId for pricing)
        parsedBooking.serviceType = serviceName;
      } catch (serviceError: any) {
        console.warn('[SERVICE FETCH FAILED]', {
          variationId: parsedBooking.serviceVariationId,
          error: serviceError.message,
          note: 'Continuing with variation ID',
        });
        // Fallback: use variation ID as service type
        parsedBooking.serviceType = parsedBooking.serviceVariationId;
      }
    }

    // Filter by Franklin location only (disabled in QA for testing)
    if (appConfig.env === 'prod' && parsedBooking.locationId && appConfig.square.franklinLocationId) {
      if (parsedBooking.locationId !== appConfig.square.franklinLocationId) {
        console.log('[WEBHOOK FILTERED]', {
          eventId: webhookEvent.event_id,
          locationId: parsedBooking.locationId,
          franklinLocationId: appConfig.square.franklinLocationId,
          reason: 'Not Franklin location',
        });
        
        const response: ApiResponse = {
          success: true,
          data: {
            message: 'Event acknowledged but filtered (not Franklin location)',
            eventId: webhookEvent.event_id,
            processed: false,
          },
          timestamp: new Date().toISOString(),
        };
        
        return NextResponse.json(response, { status: 200 });
      }
    } else if (parsedBooking.locationId && appConfig.square.franklinLocationId) {
      // QA mode: Log location mismatch but process anyway
      console.warn('[WEBHOOK QA MODE]', {
        note: 'Processing booking from non-Franklin location (QA mode)',
        locationId: parsedBooking.locationId,
        franklinLocationId: appConfig.square.franklinLocationId,
      });
    }

    console.log('[WEBHOOK PROCESSED]', {
      environment: appConfig.env,
      eventId: webhookEvent.event_id,
      eventType: webhookEvent.type,
      action,
      booking: {
        bookingId: parsedBooking.bookingId,
        customerId: parsedBooking.customerId,
        customerName: parsedBooking.customerName,
        appointmentTime: parsedBooking.appointmentTime,
        status: parsedBooking.status,
        locationId: parsedBooking.locationId,
      },
    });

    // Create or update job in DynamoDB (idempotent)
    let job;
    let jobAction: 'created' | 'updated' | 'none' = 'none';
    let existingJobSnapshot: any = null; // For change detection

    try {
      if (action === 'create') {
        // Check if job already exists by jobId (fast direct lookup)
        // Since we use bookingId as jobId, this catches manager-created bookings instantly
        console.log('[WEBHOOK] Checking for existing job by ID (fast lookup)', {
          bookingId: parsedBooking.bookingId,
          jobIdToCheck: parsedBooking.bookingId,
        });
        
        let existingJob = await getJob(parsedBooking.bookingId);
        
        // Fallback: if not found by jobId, scan by bookingId field (for old jobs with random UUIDs)
        if (!existingJob) {
          console.log('[WEBHOOK] Not found by jobId, trying scan by bookingId field (slow)');
          existingJob = await getJobByBookingId(parsedBooking.bookingId);
        }
        
        if (existingJob) {
          existingJobSnapshot = { ...existingJob };
          console.log('[JOB EXISTS]', {
            jobId: existingJob.jobId,
            bookingId: parsedBooking.bookingId,
            customerName: existingJob.customerName,
            createdBy: existingJob.createdBy,
            createdAt: existingJob.createdAt,
            action: 'updating existing job - webhook will NOT create duplicate',
          });
          
          job = await updateJobFromBooking(existingJob.jobId, parsedBooking);
          jobAction = 'updated';
        } else {
          console.log('[JOB CREATING]', {
            bookingId: parsedBooking.bookingId,
            jobIdToUse: parsedBooking.bookingId,
            customerName: parsedBooking.customerName,
            source: 'webhook',
            action: 'creating new job from webhook',
          });
          
          job = await createJobFromBooking(parsedBooking);
          jobAction = 'created';
        }
      } else if (action === 'update') {
        // Find existing job by direct lookup first, then fallback to scan
        let existingJob = await getJob(parsedBooking.bookingId);
        
        if (!existingJob) {
          existingJob = await getJobByBookingId(parsedBooking.bookingId);
        }
        
        if (existingJob) {
          existingJobSnapshot = { ...existingJob };
          console.log('[JOB UPDATING]', {
            jobId: existingJob.jobId,
            bookingId: parsedBooking.bookingId,
          });
          
          job = await updateJobFromBooking(existingJob.jobId, parsedBooking);
          jobAction = 'updated';
        } else {
          console.warn('[JOB NOT FOUND]', {
            bookingId: parsedBooking.bookingId,
            action: 'creating new job for update event',
          });
          
          // Create job if it doesn't exist (in case we missed the create event)
          job = await createJobFromBooking(parsedBooking);
          jobAction = 'created';
        }
      }

      console.log('[JOB SAVED]', {
        jobId: job?.jobId,
        bookingId: parsedBooking.bookingId,
        action: jobAction,
      });

      // Generate notifications for major events
      if (job) {
        try {
          if (jobAction === 'created') {
            // New booking notification
            const newBookingNotif = await notificationService.notifyJobCreated(
              job,
              'square',
              webhookEvent.event_id
            );
            
            if (newBookingNotif) {
              console.log('[NOTIFICATION] Job created notification sent', {
                jobId: job.jobId,
                notificationId: newBookingNotif.notificationId,
                eventId: webhookEvent.event_id,
              });
            } else {
              console.log('[NOTIFICATION] Job created notification skipped (possible duplicate)', {
                jobId: job.jobId,
                eventId: webhookEvent.event_id,
              });
            }
          } else if (jobAction === 'updated' && existingJobSnapshot) {
            // Check for cancellation
            if (job.status === 'CANCELLED' && existingJobSnapshot.status !== 'CANCELLED') {
              await notificationService.notifyJobCancelled(
                job,
                'square',
                webhookEvent.event_id
              );
              console.log('[NOTIFICATION] Job cancelled notification sent', {
                jobId: job.jobId,
              });
            }
            
            // Check for reschedule (time change)
            if (job.appointmentTime && existingJobSnapshot.appointmentTime && 
                job.appointmentTime !== existingJobSnapshot.appointmentTime) {
              await notificationService.notifyJobRescheduled(
                job,
                existingJobSnapshot.appointmentTime,
                job.appointmentTime,
                webhookEvent.event_id
              );
              console.log('[NOTIFICATION] Job rescheduled notification sent', {
                jobId: job.jobId,
              });
            }
            
            // Check for service change
            if (job.serviceType && existingJobSnapshot.serviceType && 
                job.serviceType !== existingJobSnapshot.serviceType) {
              await notificationService.notifyServiceChanged(
                job,
                existingJobSnapshot.serviceType,
                job.serviceType,
                webhookEvent.event_id
              );
              console.log('[NOTIFICATION] Service changed notification sent', {
                jobId: job.jobId,
              });
            }
          }
        } catch (notificationError: any) {
          // Don't fail the webhook if notification fails
          console.error('[NOTIFICATION ERROR]', {
            jobId: job.jobId,
            error: notificationError.message,
            stack: notificationError.stack,
          });
        }
      }
    } catch (dbError: any) {
      console.error('[DATABASE ERROR]', {
        eventId: webhookEvent.event_id,
        bookingId: parsedBooking.bookingId,
        error: dbError.message,
        stack: dbError.stack,
      });
      
      // Return 500 to signal Square to retry
      throw new Error(`Database operation failed: ${dbError.message}`);
    }

    const response: ApiResponse = {
      success: true,
      data: {
        message: 'Webhook processed successfully',
        eventId: webhookEvent.event_id,
        eventType: webhookEvent.type,
        action,
        bookingId: parsedBooking.bookingId,
        jobId: job?.jobId,
        jobAction,
        processed: true,
      },
      timestamp: new Date().toISOString(),
    };

    // Return 200 OK to acknowledge receipt
    return NextResponse.json(response, { status: 200 });
    
  } catch (error: any) {
    console.error('[WEBHOOK ERROR]', {
      error: error.message,
      stack: error.stack,
    });

    const response: ApiResponse = {
      success: false,
      error: {
        code: 'WEBHOOK_PROCESSING_ERROR',
        message: error.message || 'Failed to process webhook',
        details: process.env.APP_ENV === 'qa' ? error.stack : undefined,
      },
      timestamp: new Date().toISOString(),
    };
    
    // QA MODE: Return 200 OK even on error to prevent Square retries during testing
    // PROD MODE: Return 500 to signal Square to retry
    const statusCode = appConfig.env === 'qa' ? 200 : 500;
    return NextResponse.json(response, { status: statusCode });
  }
}
