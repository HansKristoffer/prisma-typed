import { z } from 'zod'

/** `Product.data`: one member per product kind, mirrored by `Product.kind`. */
export const productData = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('klippekort'),
		klip: z.int().positive(),
		validityDays: z.int().positive()
	}),
	z.object({
		kind: z.literal('gift_card'),
		minOre: z.int().positive(),
		maxOre: z.int().positive()
	}),
	z.object({
		kind: z.literal('shop_item'),
		sku: z.string().min(1),
		pickupOnly: z.boolean(),
		variants: z.array(
			z.object({ name: z.string().min(1), sku: z.string().min(1) })
		)
	})
])

/** `OrderLine.details`: versioned, because order history is never rewritten. */
export const orderLineDetails = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('klippekort'),
		version: z.literal(1),
		productName: z.string(),
		klip: z.int().positive(),
		validityDays: z.int().positive()
	}),
	z.object({
		kind: z.literal('ticket'),
		version: z.literal(1),
		slotId: z.string(),
		seats: z.int().positive()
	}),
	z.object({
		kind: z.literal('gift_card'),
		version: z.literal(1),
		amountOre: z.int().positive()
	})
])

/** `Notification.data` is `Json?`, so its schema accepts `null`. */
export const notificationData = z
	.object({ title: z.string(), deepLink: z.string().optional() })
	.nullable()

export const columns = {
	Product: { data: productData },
	OrderLine: { details: orderLineDetails },
	Notification: { data: notificationData }
} as const
