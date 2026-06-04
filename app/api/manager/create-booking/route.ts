/**
 * Phase 5: Manager Phone Booking Creation API
 * 
 * POST /api/manager/create-booking
 * 
 * Manager-only endpoint to create bookings via phone
 * RESTRICTED to location L9ZMZD9TTTTZJ
 */

import { NextRequest, NextResponse } from 'next/server';
import type { ApiResponse, CreateManagerBookingRequest, CreateManagerBookingResponse } from '@/lib/types';
import { WorkStatus, UserRole, PaymentStatus } from '@/lib/types';
import { requireAuth } from '@/lib/auth/requireAuth';
import { findOrCreateCustomer } from '@/lib/square/customers-api';
import { createBooking } from '@/lib/square/bookings-api';
import { listPhoneBookingServices, validateAddonVariation, listAddons } from '@/lib/square/catalog-api';
import * as dynamodb from '@/lib/aws/dynamodb';
import { generateJobNumber } from '@/lib/services/job-service';
import { getConfig } from '@/lib/config';
import * as notificationService from '@/lib/services/notification-service';

/**
 * POST /api/manager/create-booking
 * 
 * Create a phone booking (Manager-only)
 */
export const POST = requireAuth(async (
  request: NextRequest,
  session
): Promise<NextResponse> => {
  try {
    const userRole = session.role as UserRole;
    
    // Only MANAGER can create phone bookings
    if (userRole !== UserRole.MANAGER) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only MANAGER can create phone bookings',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 403 });
    }

    const body: CreateManagerBookingRequest = await request.json();

    // Validate required fields
    if (!body.customer?.name || !body.customer?.phone) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Customer name and phone are required',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (!body.service?.serviceName || !body.service?.durationMinutes) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Service name and duration are required',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (!body.appointmentTime?.startAt) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Appointment start time is required',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    const config = getConfig();
    const locationId = config.square.franklinLocationId;

    console.log('[MANAGER BOOKING] Configuration:', {
      locationId,
      environment: config.square.environment,
      hasAccessToken: !!config.square.accessToken,
    });

    if (!locationId) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'CONFIGURATION_ERROR',
          message: 'Square location ID not configured',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 500 });
    }

    // Step 1: Find or create customer in Square
    console.log('[MANAGER BOOKING] Finding/creating customer', {
      name: body.customer.name,
      phone: body.customer.phone,
    });

    const customer = await findOrCreateCustomer({
      name: body.customer.name,
      phone: body.customer.phone,
      email: body.customer.email,
    });

    console.log('[MANAGER BOOKING] Customer ready', {
      customerId: customer.id,
      isNew: !customer.id,
    });

    // Step 2: Validate service variation ID is from allowed location
    if (!body.service.serviceVariationId) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Service variation ID is required',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    const serviceVariationId = body.service.serviceVariationId;
    const isProduction = config.square.environment === 'production';
    
    // SERVER-SIDE VALIDATION: In production, ensure service is from the allowed location
    if (isProduction && locationId) {
      console.log('[MANAGER BOOKING] Validating service variation (production)', {
        serviceVariationId,
        requiredLocation: locationId,
      });
      
      const allowedServices = await listPhoneBookingServices();
      const isValidService = allowedServices.some(s => s.id === serviceVariationId);
      
      if (!isValidService) {
        console.error('[MANAGER BOOKING] SECURITY: Attempted to book service not from allowed location', {
          serviceVariationId,
          allowedLocation: locationId,
          allowedServiceIds: allowedServices.map(s => s.id),
        });
        
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'INVALID_SERVICE',
            message: `Service variation ${serviceVariationId} is not available at location ${locationId}`,
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 400 });
      }
      
      console.log('[MANAGER BOOKING] Service validated successfully', {
        serviceVariationId,
        locationId,
      });
    } else {
      console.log('[MANAGER BOOKING] Skipping service validation (sandbox/qa)', {
        serviceVariationId,
        environment: config.square.environment,
      });
    }

    // Step 3: Create booking in Square
    console.log('[MANAGER BOOKING] Service validated successfully', {
      serviceVariationId,
      locationId,
    });

    // Step 3: Format add-ons for booking notes (matching website format)
    const serviceVariationVersion = body.service.serviceVariationVersion || 1;
    let customerNoteWithAddons = body.notes || '';
    
    if (body.addonItemVariationIds && body.addonItemVariationIds.length > 0) {
      console.log('[MANAGER BOOKING] Formatting add-ons for booking notes', {
        addonCount: body.addonItemVariationIds.length,
      });
      
      // Validate and fetch add-on names
      const addonNames: string[] = [];
      
      for (const addonId of body.addonItemVariationIds) {
        const isValid = await validateAddonVariation(addonId);
        if (!isValid) {
          console.error('[MANAGER BOOKING] SECURITY: Invalid add-on variation ID', {
            addonId,
          });
          
          const response: ApiResponse = {
            success: false,
            error: {
              code: 'INVALID_ADDONS',
              message: `Invalid add-on variation ID: ${addonId}`,
            },
            timestamp: new Date().toISOString(),
          };
          return NextResponse.json(response, { status: 400 });
        }
        
        // Find addon name from catalog
        const addon = (await listAddons()).find(a => a.id === addonId);
        if (addon) {
          addonNames.push(addon.name);
        }
      }
      
      // Format add-ons as text (matching website format)
      const addonsText = `\n\n✅ ADD-ONS REQUESTED:\n${addonNames.map(name => `• ${name}`).join('\n')}\n\n⚠️ Add-ons charged separately at service time`;
      customerNoteWithAddons = (customerNoteWithAddons + addonsText).trim();
      
      console.log('[MANAGER BOOKING] Add-ons formatted in notes', {
        addonsCount: addonNames.length,
      });
    }

    console.log('[MANAGER BOOKING] Creating Square booking', {
      customerId: customer.id,
      startAt: body.appointmentTime.startAt,
      serviceVariationId,
      serviceVariationVersion,
      locationId,
      teamMemberId: config.square.teamMemberId || 'not set',
      hasAddons: body.addonItemVariationIds && body.addonItemVariationIds.length > 0,
    });

    const squareBooking = await createBooking({
      customerId: customer.id,
      locationId: locationId,
      serviceVariationId: serviceVariationId,
      serviceVariationVersion: serviceVariationVersion,
      startAt: body.appointmentTime.startAt,
      durationMinutes: body.service.durationMinutes,
      teamMemberId: config.square.teamMemberId && config.square.teamMemberId.trim() !== '' 
        ? config.square.teamMemberId 
        : undefined,
      customerNote: customerNoteWithAddons,
      sellerNote: body.vehicle ? 
        `Vehicle: ${body.vehicle.year || ''} ${body.vehicle.make || ''} ${body.vehicle.model || ''}`.trim() : 
        undefined,
    });

    console.log('[MANAGER BOOKING] Square booking created', {
      bookingId: squareBooking.id,
      hasAddonsInNotes: body.addonItemVariationIds && body.addonItemVariationIds.length > 0,
    });

    // Step 5: Create job in DynamoDB immediately (don't wait for webhook)
    const jobId = squareBooking.id; // Use booking ID as job ID for consistency

    console.log('[MANAGER BOOKING] Checking for existing job', {
      jobId,
      bookingId: squareBooking.id,
    });

    // Check if job already exists (idempotency)
    const existingJob = await dynamodb.getJob(jobId);
    if (existingJob) {
      console.log('[MANAGER BOOKING] Job already exists, returning existing', {
        jobId,
        existingJobCreatedAt: existingJob.createdAt,
        existingJobCreatedBy: existingJob.createdBy,
      });

      const response: ApiResponse<CreateManagerBookingResponse> = {
        success: true,
        data: {
          jobId: existingJob.jobId,
          bookingId: squareBooking.id,
          job: existingJob,
        },
        timestamp: new Date().toISOString(),
      };

      return NextResponse.json(response, { status: 200 });
    }

    // Create new job
    const now = new Date().toISOString();
    
    // Generate unique job number (10001, 10002, etc.)
    const jobNumber = await generateJobNumber();
    
    console.log('[MANAGER BOOKING] Creating new job in DynamoDB', {
      jobId,
      jobNumber,
      customerId: customer.id,
      customerName: body.customer.name,
      customerPhone: body.customer.phone,
      serviceType: body.service.serviceName,
      appointmentTime: body.appointmentTime.startAt,
    });
    
    const job = await dynamodb.createJob({
      jobId: jobId,
      jobNumber,
      customerId: customer.id,
      customerName: body.customer.name,
      customerEmail: body.customer.email,
      customerPhone: body.customer.phone,
      vehicleInfo: {
        make: body.vehicle?.make,
        model: body.vehicle?.model,
        year: body.vehicle?.year,
        color: body.vehicle?.color,
      },
      serviceType: body.service.serviceName,
      status: WorkStatus.SCHEDULED,
      source: 'manual', // Booking created manually by staff via phone
      bookingId: squareBooking.id,
      appointmentTime: body.appointmentTime.startAt,
      notes: customerNoteWithAddons, // Store notes with add-ons formatted
      payment: body.service.amountCents ? {
        status: PaymentStatus.UNPAID,
        amountCents: body.service.amountCents,
      } : undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: session.name, // Staff member name who created the booking
      customerCached: {
        id: customer.id,
        name: body.customer.name,
        email: body.customer.email,
        phone: body.customer.phone,
        cachedAt: now,
      },
      photosMeta: [],
      statusHistory: [
        {
          from: null,
          to: WorkStatus.SCHEDULED,
          event: 'STATUS_CHANGE',
          changedAt: now,
          changedBy: {
            userId: session.sub,
            name: session.name,
            role: UserRole.MANAGER,
          },
          reason: 'Phone booking created by manager',
        },
      ],
    });

    // Generate notification for phone booking
    try {
      const phoneBookingNotif = await notificationService.notifyJobCreated(job, 'phone', undefined, session.email);
      
      if (phoneBookingNotif) {
        console.log('[PHONE BOOKING] Notification created', {
          jobId: job.jobId,
          notificationId: phoneBookingNotif.notificationId,
          bookingId: squareBooking.id,
          actorEmail: session.email,
        });
      } else {
        console.log('[PHONE BOOKING] Notification skipped (possible duplicate)', {
          jobId: job.jobId,
          bookingId: squareBooking.id,
          actorEmail: session.email,
        });
      }
    } catch (notificationError: any) {
      // Don't fail the request if notification fails
      console.error('[PHONE BOOKING] Notification creation failed', {
        jobId: job.jobId,
        bookingId: squareBooking.id,
        error: notificationError.message,
        stack: notificationError.stack,
      });
    }

    console.log('[MANAGER BOOKING] Job created in DynamoDB', {
      jobId: job.jobId,
      hasAddons: !!body.addonItemVariationIds?.length,
      addonCount: body.addonItemVariationIds?.length || 0,
    });

    const response: ApiResponse<CreateManagerBookingResponse> = {
      success: true,
      data: {
        jobId: job.jobId,
        bookingId: squareBooking.id,
        job: job,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error: any) {
    console.error('[MANAGER BOOKING ERROR]', {
      error: error.message,
      stack: error.stack,
    });

    const response: ApiResponse = {
      success: false,
      error: {
        code: 'BOOKING_CREATION_ERROR',
        message: error.message || 'Failed to create booking',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 500 });
  }
});
