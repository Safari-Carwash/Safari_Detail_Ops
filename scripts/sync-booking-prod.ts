/**
 * Sync a specific Square booking to PRODUCTION Detail Ops
 * Fetches latest booking data from Square API and updates local DB
 * 
 * Usage: npm run sync-booking-prod -- <bookingId>
 * Example: npm run sync-booking-prod -- i7nzfwxicf53cl
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env.local
const envPath = resolve(process.cwd(), '.env.local');
config({ path: envPath });

// Override to use PRODUCTION
process.env.DYNAMODB_JOBS_TABLE = 'safari-detail-ops-prod-jobs';
process.env.APP_ENV = 'prod';
process.env.SQUARE_ENV = 'production';

import { retrieveBooking } from '../lib/square/bookings-api';
import { fetchCustomerDetails, formatCustomerName, extractCustomerContact } from '../lib/square/customers-api';
import { fetchServiceName } from '../lib/square/catalog-api';
import { retrieveOrder } from '../lib/square/orders-api';
import { getJob, getJobByBookingId } from '../lib/aws/dynamodb';
import { createJobFromBooking, updateJobFromBooking } from '../lib/services/job-service';
import type { ParsedBooking } from '../lib/square/booking-parser';

async function syncBooking(bookingId: string) {
  console.log('═════════════════════════════════════════');
  console.log('🔄 SYNC BOOKING TO PRODUCTION');
  console.log('═════════════════════════════════════════');
  console.log('Booking ID:', bookingId);
  console.log('Environment: PRODUCTION');
  console.log('─────────────────────────────────────────');

  try {
    // 1. Fetch booking from Square
    console.log('\n📥 Step 1: Fetching booking from Square API...');
    const squareBooking = await retrieveBooking(bookingId);
    
    if (!squareBooking) {
      console.error('❌ Booking not found in Square');
      return;
    }

    console.log('✅ Booking found in Square:');
    console.log('   Status:', squareBooking.status);
    console.log('   Customer ID:', squareBooking.customer_id);
    console.log('   Start time:', squareBooking.start_at);
    console.log('   Location:', squareBooking.location_id);
    console.log('   Version:', squareBooking.version);

    // 2. Parse booking data
    console.log('\n🔍 Step 2: Parsing booking data...');
    const parsedBooking: ParsedBooking = {
      bookingId: squareBooking.id,
      customerId: squareBooking.customer_id,
      appointmentTime: squareBooking.start_at,
      status: squareBooking.status || 'PENDING',
      notes: squareBooking.customer_note || '',
      locationId: squareBooking.location_id,
      sellerId: squareBooking.seller_id,
      version: squareBooking.version,
      orderId: squareBooking.order_id,
    };

    // 3. Enrich with service details
    if (squareBooking.appointment_segments && squareBooking.appointment_segments.length > 0) {
      const serviceVariationId = squareBooking.appointment_segments[0].service_variation_id;
      parsedBooking.serviceVariationId = serviceVariationId;
      
      console.log('   Service Variation ID:', serviceVariationId);
      
      if (serviceVariationId) {
        try {
          const serviceName = await fetchServiceName(serviceVariationId!);
          parsedBooking.serviceType = serviceName;
          console.log('   Service Name:', serviceName);
        } catch (err: any) {
          console.warn('   ⚠️  Could not fetch service name:', err.message);
        }
      }
    }

    // 4. Enrich with customer details
    if (squareBooking.customer_id) {
      console.log('\n👤 Step 3: Fetching customer details...');
      try {
        const customer = await fetchCustomerDetails(squareBooking.customer_id);
        if (customer) {
          parsedBooking.customerName = formatCustomerName(customer);
          const contact = extractCustomerContact(customer);
          parsedBooking.customerEmail = contact.email;
          parsedBooking.customerPhone = contact.phone;
          
          console.log('   Name:', parsedBooking.customerName);
          console.log('   Email:', parsedBooking.customerEmail || '(none)');
          console.log('   Phone:', parsedBooking.customerPhone || '(none)');
        }
      } catch (err: any) {
        console.warn('   ⚠️  Could not fetch customer:', err.message);
      }
    }

    // 5. Enrich with order/add-ons
    if (squareBooking.order_id) {
      console.log('\n🛒 Step 4: Checking for add-ons...');
      try {
        const order = await retrieveOrder(squareBooking.order_id);
        if (order && order.line_items && order.line_items.length > 0) {
          const serviceVariationIds = squareBooking.appointment_segments?.map(
            seg => seg.service_variation_id
          ) || [];
          
          const addonItems = order.line_items.filter(item => 
            item.catalog_object_id && 
            !serviceVariationIds.includes(item.catalog_object_id)
          );
          
          if (addonItems.length > 0) {
            const addonNames = addonItems
              .map(item => item.name || 'Unknown Add-on')
              .filter(name => name);
            
            const addonsText = `\n\n✅ ADD-ONS REQUESTED:\n${addonNames.map(name => `• ${name}`).join('\n')}\n\n⚠️ Add-ons charged separately`;
            parsedBooking.notes = (parsedBooking.notes + addonsText).trim();
            
            console.log('   Add-ons found:', addonNames.length);
            addonNames.forEach(name => console.log('   •', name));
          } else {
            console.log('   No add-ons in order');
          }
        }
      } catch (err: any) {
        console.warn('   ⚠️  Could not fetch order:', err.message);
      }
    }

    // 6. Check if job exists in Detail Ops
    console.log('\n💾 Step 5: Checking Detail Ops database...');
    let existingJob = await getJob(bookingId);
    
    if (!existingJob) {
      existingJob = await getJobByBookingId(bookingId);
    }

    if (existingJob) {
      console.log('   ✅ Job exists in Detail Ops');
      console.log('   Job ID:', existingJob.jobId);
      console.log('   Current Status:', existingJob.status);
      console.log('   Square Status:', parsedBooking.status);
      
      if (existingJob.status === parsedBooking.status.toUpperCase()) {
        console.log('   ℹ️  Status already in sync - no update needed');
      } else {
        console.log('   🔄 Status mismatch - updating job...');
        const updatedJob = await updateJobFromBooking(existingJob.jobId, parsedBooking);
        console.log('   ✅ Job updated!');
        console.log('   New Status:', updatedJob.status);
      }
    } else {
      console.log('   ❌ Job NOT found in Detail Ops');
      console.log('   🔄 Creating new job...');
      const newJob = await createJobFromBooking(parsedBooking);
      console.log('   ✅ Job created!');
      console.log('   Job ID:', newJob.jobId);
      console.log('   Status:', newJob.status);
    }

    // 7. Summary
    console.log('\n═════════════════════════════════════════');
    console.log('✅ SYNC COMPLETE');
    console.log('═════════════════════════════════════════');
    console.log('Square Status:', parsedBooking.status);
    console.log('Detail Ops Status:', parsedBooking.status === 'CANCELLED' || parsedBooking.status === 'DECLINED' ? 'CANCELLED' : 'SCHEDULED');
    console.log('─────────────────────────────────────────');
    console.log('View on board: https://ops.thesafaricarwash.com/en');
    console.log('View job: https://ops.thesafaricarwash.com/en/jobs/' + bookingId);
    console.log('═════════════════════════════════════════');

  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    throw error;
  }
}

const bookingId = process.argv[2];

if (!bookingId) {
  console.error('❌ Usage: npm run sync-booking-prod -- <bookingId>');
  console.error('Example: npm run sync-booking-prod -- i7nzfwxicf53cl');
  process.exit(1);
}

syncBooking(bookingId)
  .then(() => {
    console.log('\n✅ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Failed:', error.message);
    process.exit(1);
  });
