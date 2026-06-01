/**
 * Square Orders API Client
 * 
 * Manages Square Orders for add-ons and other line items.
 */

import { getConfig } from '../config';
import { randomBytes } from 'crypto';

/**
 * Line item for Square Order
 */
export interface OrderLineItem {
  catalog_object_id?: string;
  catalog_version?: number;
  quantity: string;
  name?: string;
  note?: string;
  metadata?: Record<string, string>;
  base_price_money?: {
    amount: number;
    currency: string;
  };
}

/**
 * Square Order object
 */
export interface SquareOrder {
  id: string;
  location_id: string;
  line_items?: OrderLineItem[];
  state?: string;
  version?: number;
  created_at?: string;
  updated_at?: string;
  total_money?: {
    amount: number;
    currency: string;
  };
  metadata?: Record<string, string>;
}

/**
 * Create order request
 */
export interface CreateOrderRequest {
  locationId: string;
  lineItems: OrderLineItem[];
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

/**
 * Update order request
 */
export interface UpdateOrderRequest {
  orderId: string;
  version: number;
  lineItems: OrderLineItem[];
  idempotencyKey?: string;
}

/**
 * Generate idempotency key for order operations
 */
function generateIdempotencyKey(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Create a new order in Square
 * 
 * @param request - Order creation request
 * @returns Created order object
 */
export async function createOrder(request: CreateOrderRequest): Promise<SquareOrder> {
  const config = getConfig();
  
  if (!config.square.accessToken) {
    throw new Error('Square access token not configured');
  }

  const baseUrl = config.square.environment === 'sandbox' 
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
  
  const url = `${baseUrl}/v2/orders`;
  
  const idempotencyKey = request.idempotencyKey || generateIdempotencyKey();
  
  console.log('[SQUARE ORDERS API] Creating order', {
    locationId: request.locationId,
    lineItemCount: request.lineItems.length,
    idempotencyKey,
  });

  const body = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: request.locationId,
      line_items: request.lineItems,
      metadata: request.metadata,
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.square.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SQUARE ORDERS API] Create order failed', {
        status: response.status,
        error: errorText,
      });
      
      throw new Error(`Failed to create order: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    if (data.errors && data.errors.length > 0) {
      const errorMsg = data.errors.map((e: any) => `${e.code}: ${e.detail || e.category}`).join(', ');
      throw new Error(`Square API errors: ${errorMsg}`);
    }

    const order = data.order as SquareOrder;
    
    console.log('[SQUARE ORDERS API] Order created', {
      orderId: order.id,
      lineItemCount: order.line_items?.length || 0,
    });
    
    return order;
  } catch (error: any) {
    console.error('[SQUARE ORDERS API] Create order error', {
      error: error.message,
      stack: error.stack,
    });
    
    throw error;
  }
}

/**
 * Retrieve an order from Square
 * 
 * @param orderId - Square Order ID
 * @returns Order object or null if not found
 */
export async function retrieveOrder(orderId: string): Promise<SquareOrder | null> {
  const config = getConfig();
  
  if (!config.square.accessToken) {
    throw new Error('Square access token not configured');
  }

  const baseUrl = config.square.environment === 'sandbox' 
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
  
  const url = `${baseUrl}/v2/orders/${orderId}`;
  
  console.log('[SQUARE ORDERS API] Retrieving order', { orderId });

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.square.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.warn('[SQUARE ORDERS API] Order not found', { orderId });
        return null;
      }
      
      const errorText = await response.text();
      console.error('[SQUARE ORDERS API] Retrieve order failed', {
        orderId,
        status: response.status,
        error: errorText,
      });
      
      return null;
    }

    const data = await response.json();
    
    if (data.errors && data.errors.length > 0) {
      console.error('[SQUARE ORDERS API] Order retrieve errors', {
        orderId,
        errors: data.errors,
      });
      return null;
    }

    const order = data.order as SquareOrder;
    
    console.log('[SQUARE ORDERS API] Order retrieved', {
      orderId: order.id,
      lineItemCount: order.line_items?.length || 0,
    });
    
    return order;
  } catch (error: any) {
    console.error('[SQUARE ORDERS API] Retrieve order error', {
      orderId,
      error: error.message,
    });
    
    return null;
  }
}

/**
 * Update an existing order in Square
 * 
 * @param request - Order update request
 * @returns Updated order object
 */
export async function updateOrder(request: UpdateOrderRequest): Promise<SquareOrder> {
  const config = getConfig();
  
  if (!config.square.accessToken) {
    throw new Error('Square access token not configured');
  }

  const baseUrl = config.square.environment === 'sandbox' 
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
  
  const url = `${baseUrl}/v2/orders/${request.orderId}`;
  
  const idempotencyKey = request.idempotencyKey || generateIdempotencyKey();
  
  console.log('[SQUARE ORDERS API] Updating order', {
    orderId: request.orderId,
    version: request.version,
    lineItemCount: request.lineItems.length,
    idempotencyKey,
  });

  const body = {
    idempotency_key: idempotencyKey,
    order: {
      version: request.version,
      line_items: request.lineItems,
    },
  };

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${config.square.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SQUARE ORDERS API] Update order failed', {
        orderId: request.orderId,
        status: response.status,
        error: errorText,
      });
      
      throw new Error(`Failed to update order: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    if (data.errors && data.errors.length > 0) {
      const errorMsg = data.errors.map((e: any) => `${e.code}: ${e.detail || e.category}`).join(', ');
      throw new Error(`Square API errors: ${errorMsg}`);
    }

    const order = data.order as SquareOrder;
    
    console.log('[SQUARE ORDERS API] Order updated', {
      orderId: order.id,
      lineItemCount: order.line_items?.length || 0,
      newVersion: order.version,
    });
    
    return order;
  } catch (error: any) {
    console.error('[SQUARE ORDERS API] Update order error', {
      orderId: request.orderId,
      error: error.message,
      stack: error.stack,
    });
    
    throw error;
  }
}

/**
 * Check if a line item is an add-on based on metadata
 * 
 * @param lineItem - Order line item
 * @returns True if the line item is an add-on
 */
export function isAddonLineItem(lineItem: OrderLineItem): boolean {
  return lineItem.metadata?.source === 'detail-ops-addon';
}

/**
 * Extract add-on line items from an order
 * 
 * @param order - Square Order
 * @returns Array of add-on line items
 */
export function extractAddonLineItems(order: SquareOrder): OrderLineItem[] {
  if (!order.line_items) {
    return [];
  }
  
  return order.line_items.filter(isAddonLineItem);
}

/**
 * Extract non-add-on line items from an order
 * 
 * @param order - Square Order
 * @returns Array of non-add-on line items
 */
export function extractNonAddonLineItems(order: SquareOrder): OrderLineItem[] {
  if (!order.line_items) {
    return [];
  }
  
  return order.line_items.filter(item => !isAddonLineItem(item));
}

/**
 * Extract the total amount for non-add-on line items from an order.
 *
 * @param order - Square Order
 * @returns Total amount in cents for service-related line items
 */
export function extractNonAddonAmount(order: SquareOrder): number {
  if (!order.line_items) {
    return 0;
  }

  return order.line_items
    .filter(item => !isAddonLineItem(item))
    .reduce((sum, item) => sum + (item.base_price_money?.amount || 0), 0);
}
